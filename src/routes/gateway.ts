// API Library key management: list the available APIs, and create / list /
// revoke the signed-in user's own keys. Every handler requires a real SESSION
// — an API Library key can't reach these (see GATEWAY_KEY_ALLOWED_ROUTES in
// middleware/auth.ts), so a leaked key can never mint more keys or revoke
// its siblings. Ownership is enforced inside gatewayApiKeys (WHERE
// owner_user_id = $n), never by trusting an id from the URL.
import { recordSecurityEvent } from '../modules/audit/security-events';
import { notifySecurityEvent } from '../domain/auth/security-notices';
import { sendKeyShareEmail } from '../infrastructure/email/resend';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError, validationError } from '../middleware/http-error';
import { sendWithEtag } from '../middleware/etag';
import { requireAuth, requireConfirmedEmail } from '../middleware/auth';
import { gatewayApiKeys, GatewayKeyError } from '../domain/gateway/keys';
import { keyShares, ShareError } from '../domain/gateway/sharing';
import { emitWebhookEvent } from '../domain/webhooks/webhooks';
import { resumeKey, suspendKey } from '../domain/suspension';
import { IDLE_DAYS, keyUsage, limitsFor } from '../domain/gateway/usage';
import { config } from '../config';
import { KEY_BUCKET_FACTOR } from '../middleware/api-protection';
import { BrokerError } from '../domain/gateway/broker';
import { getServiceCatalog } from '../domain/gateway/services';
import { AddKeyServiceSchema, CreateGatewayKeySchema, SetKeyRestrictionsSchema, ShareKeySchema } from '../validators/gateway';
import { GATEWAY_SERVICES, type GatewayService } from '../domain/gateway/services';
import { LIBRARY_OPENAPI_SPEC } from '../openapi';

function auditKey(request: FastifyRequest, event: string, meta: Record<string, unknown>) {
  request.log.info({ level: 'audit', event, requestId: request.id, ts: new Date().toISOString(), ...meta });
  recordSecurityEvent(request, event, 'ok', Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, String(v)])));
}

/** The developer-facing API description. Public: it documents only what a key can do. */
export async function libraryOpenApiHandler(_request: FastifyRequest, reply: FastifyReply) {
  return sendWithEtag(_request, reply, LIBRARY_OPENAPI_SPEC);
}

export async function listGatewayServicesHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  // The standard personal-key rate (an administrator override on a specific key can only be seen after it exists, so
  // this is the number a new key would actually get) plus the fixed idle-expiry, so the create-key form can show what
  // a service is limited to before the key is made, not only afterward on an existing key's usage panel.
  const perMinute = Math.ceil(config.rateLimitPerMinute * KEY_BUCKET_FACTOR);
  const notes = new Map(limitsFor(perMinute).map((l) => [l.service, l.note]));
  const services = getServiceCatalog().map((entry) => ({ ...entry, limitNote: notes.get(entry.service), idleExpiryDays: IDLE_DAYS }));
  return sendWithEtag(request, reply, { services });
}

export async function listGatewayKeysHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const user = request.currentUser!;
  return reply.send({ apiKeys: await gatewayApiKeys.list(user.id) });
}

/** Keys someone else shared with the caller (pending and accepted) — "Key shared with me" on the API Library page. */
export async function listSharedKeysHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  return reply.send({ sharedKeys: await keyShares.listSharedWithMe(request.currentUser!.id) });
}

export async function createGatewayKeyHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const parsed = CreateGatewayKeySchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  const user = request.currentUser!;

  try {
    const created = await gatewayApiKeys.create(user.id, parsed.data.label, parsed.data.services, parsed.data.expiresInDays, [...new Set(parsed.data.deskScopes)], parsed.data.sandbox === true, parsed.data.allowedIps, parsed.data.businessId);
    auditKey(request, 'gateway_key_created', {
      userId: user.id,
      keyId: created.id,
      services: created.services.join(','),
      deskScopes: (created.deskScopes ?? []).join(','),
    });
    notifySecurityEvent(request, user.email, 'api_key_created', parsed.data.label);
    emitWebhookEvent({ userId: user.id }, 'key.created', { keyId: created.id, label: created.label, services: created.services, sandbox: created.sandbox ?? false });
    return reply.status(201).send({ apiKey: created });
  } catch (err) {
    if (err instanceof GatewayKeyError) {
      const status = err.code === 'limit_reached' ? 409 : err.code === 'sandbox_desk_api' ? 400 : err.code === 'not_found' ? 404 : 503;
      throw new HttpError(status, err.message, `api_key_${err.code}`);
    }
    if (err instanceof BrokerError) {
      request.log.error({ err }, 'gateway key provisioning failed');
      throw new HttpError(502, 'Could not set up access to one of the selected APIs. Nothing was created; please try again.', 'upstream_provisioning_failed');
    }
    throw err;
  }
}

function keyServiceError(err: unknown): never {
  if (err instanceof GatewayKeyError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'service_unavailable' ? 503 : err.code === 'sandbox_desk_api' ? 400 : 409;
    throw new HttpError(status, err.message, `api_key_${err.code}`);
  }
  if (err instanceof BrokerError) throw new HttpError(502, 'Could not set up access to that API. Nothing was changed; please try again.', 'upstream_provisioning_failed');
  throw err;
}

function shareError(err: unknown): never {
  if (err instanceof ShareError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'no_account' || err.code === 'already_owner' ? 400 : 409;
    throw new HttpError(status, err.message, `key_share_${err.code}`);
  }
  throw err as Error;
}

/** Changes a key's IP allowlist and/or its one-business restriction. Pass null (or an empty array for allowedIps) to clear one. */
export async function setKeyRestrictionsHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id } = request.params as { id: string };
  const parsed = SetKeyRestrictionsSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  const user = request.currentUser!;
  try {
    const key = await gatewayApiKeys.setRestrictions(user.id, id, parsed.data.allowedIps, parsed.data.businessId);
    auditKey(request, 'gateway_key_restrictions_changed', { userId: user.id, keyId: id, allowedIps: (parsed.data.allowedIps ?? []).join(','), businessId: parsed.data.businessId ?? '' });
    return reply.send({ apiKey: key });
  } catch (err) {
    return keyServiceError(err);
  }
}

/** Adds an API to one of the caller's own keys (the key and its secret stay the same). */
export async function addKeyServiceHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const { id } = request.params as { id: string };
  const parsed = AddKeyServiceSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  const user = request.currentUser!;
  try {
    const key = await gatewayApiKeys.addService(user.id, id, parsed.data.service);
    auditKey(request, 'gateway_key_service_added', { userId: user.id, keyId: id, service: parsed.data.service });
    return reply.send({ apiKey: key });
  } catch (err) {
    return keyServiceError(err);
  }
}

/** Removes an API from one of the caller's own keys (at least one must remain). */
export async function removeKeyServiceHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id, service } = request.params as { id: string; service: string };
  if (!(GATEWAY_SERVICES as readonly string[]).includes(service)) throw new HttpError(404, 'No such API.', 'not_found');
  const user = request.currentUser!;
  try {
    const key = await gatewayApiKeys.removeService(user.id, id, service as GatewayService);
    auditKey(request, 'gateway_key_service_removed', { userId: user.id, keyId: id, service });
    return reply.send({ apiKey: key });
  } catch (err) {
    return keyServiceError(err);
  }
}

/** How much one of the caller's own keys (or one shared with them) has been used (calls and errors per day), and the limits that apply to it. */
export async function keyUsageHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id } = request.params as { id: string };
  const q = request.query as { days?: string };
  const days = Math.min(90, Math.max(1, Number.parseInt(q.days ?? '30', 10) || 30));
  const viewerOwner = await keyShares.viewerOwnerOf(request.currentUser!.id, id);
  const mine = viewerOwner ? await gatewayApiKeys.summaryOf(id) : undefined;
  if (!mine) throw new HttpError(404, 'That key does not exist, is not yours, or was revoked.', 'api_key_not_found');
  const daily = await keyUsage(id, days);
  return reply.send({
    keyId: id,
    days,
    lastUsedAt: mine.lastUsedAt,
    expiresAt: mine.expiresAt ?? null,
    idleExpiryDays: IDLE_DAYS,
    totals: { calls: daily.reduce((n, d) => n + d.calls, 0), errors: daily.reduce((n, d) => n + d.errors, 0) },
    daily,
    limits: limitsFor(Math.ceil(config.rateLimitPerMinute * KEY_BUCKET_FACTOR)),
  });
}

/** The owner switches one of their own keys off without revoking it (a leaked key under investigation, or a pause). */
export async function suspendGatewayKeyHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id } = request.params as { id: string };
  const user = request.currentUser!;
  if (!(await suspendKey(id, user.id, 'suspended by its owner', user.email))) throw new HttpError(404, 'That key does not exist, is not yours, or was revoked.', 'api_key_not_found');
  auditKey(request, 'gateway_key_suspended', { userId: user.id, keyId: id });
  return reply.send({ ok: true, suspended: true });
}

export async function resumeGatewayKeyHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id } = request.params as { id: string };
  const user = request.currentUser!;
  if (!(await resumeKey(id, user.id))) throw new HttpError(404, 'That key is not suspended, or is not yours.', 'api_key_not_found');
  auditKey(request, 'gateway_key_resumed', { userId: user.id, keyId: id });
  return reply.send({ ok: true, suspended: false });
}

/** Issues a new secret for one of the caller's own keys, keeping everything else about it (its id, grants, scopes) unchanged. */
export async function rotateGatewayKeyHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const { id } = request.params as { id: string };
  const user = request.currentUser!;
  try {
    const rotated = await gatewayApiKeys.rotate(user.id, id);
    auditKey(request, 'gateway_key_rotated', { userId: user.id, keyId: id });
    notifySecurityEvent(request, user.email, 'api_key_rotated', rotated.label);
    return reply.send({ apiKey: rotated });
  } catch (err) {
    return keyServiceError(err);
  }
}

export async function revokeGatewayKeyHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id } = request.params as { id: string };
  const user = request.currentUser!;
  try {
    const { upstreamFailures } = await gatewayApiKeys.revoke(user.id, id);
    auditKey(request, 'gateway_key_revoked', { userId: user.id, keyId: id });
    emitWebhookEvent({ userId: user.id }, 'key.revoked', { keyId: id });
    if (upstreamFailures.length > 0) {
      request.log.warn(
        { keyId: id, services: upstreamFailures },
        'gateway key revoked, but a backend key could not be revoked upstream',
      );
    }
    return reply.status(204).send();
  } catch (err) {
    if (err instanceof GatewayKeyError) {
      // One rule for every DELETE: something that is already gone (or never was yours) is a 404.
      throw new HttpError(404, err.message, `api_key_${err.code}`);
    }
    throw err;
  }
}

// ── sharing a key with another person ───────────────────────────────────────────────────────────────────────────

/** The owner invites someone (by email; they must already have a confirmed Desk account) to view one of their keys. */
export async function shareGatewayKeyHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id } = request.params as { id: string };
  const parsed = ShareKeySchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  const user = request.currentUser!;
  try {
    const share = await keyShares.share(user.id, id, parsed.data.email);
    auditKey(request, 'gateway_key_shared', { userId: user.id, keyId: id, sharedWithEmail: parsed.data.email });
    const key = await gatewayApiKeys.summaryOf(id);
    void sendKeyShareEmail(config, share.sharedWith.email, key?.label ?? 'a key', user.email, request.id).catch(() => {});
    return reply.status(201).send({ share });
  } catch (err) {
    return shareError(err);
  }
}

/** Everyone a key has been shared with (pending and accepted) — the owner's own "invite +" popup. */
export async function listKeySharesHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id } = request.params as { id: string };
  try {
    return reply.send({ shares: await keyShares.listForKey(request.currentUser!.id, id) });
  } catch (err) {
    return shareError(err);
  }
}

/** The owner removes someone a key was shared with. */
export async function removeKeyShareHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id, shareId } = request.params as { id: string; shareId: string };
  try {
    await keyShares.removeByOwner(request.currentUser!.id, id, shareId);
    auditKey(request, 'gateway_key_share_removed', { userId: request.currentUser!.id, keyId: id, shareId });
    return reply.status(204).send();
  } catch (err) {
    return shareError(err);
  }
}

/** The invited person accepts a pending share. */
export async function acceptKeyShareHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { shareId } = request.params as { shareId: string };
  try {
    await keyShares.accept(request.currentUser!.id, shareId);
    auditKey(request, 'gateway_key_share_accepted', { userId: request.currentUser!.id, shareId });
    return reply.send({ ok: true });
  } catch (err) {
    return shareError(err);
  }
}

/** The invited person declines a pending share, or removes themselves from one they'd accepted. */
export async function declineKeyShareHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { shareId } = request.params as { shareId: string };
  try {
    await keyShares.decline(request.currentUser!.id, shareId);
    auditKey(request, 'gateway_key_share_declined', { userId: request.currentUser!.id, shareId });
    return reply.status(204).send();
  } catch (err) {
    return shareError(err);
  }
}
