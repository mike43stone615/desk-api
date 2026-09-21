// API Library key management: list the available APIs, and create / list /
// revoke the signed-in user's own keys. Every handler requires a real SESSION
// — an API Library key can't reach these (see GATEWAY_KEY_ALLOWED_ROUTES in
// middleware/auth.ts), so a leaked key can never mint more keys or revoke
// its siblings. Ownership is enforced inside gatewayApiKeys (WHERE
// owner_user_id = $n), never by trusting an id from the URL.
import { recordSecurityEvent } from '../modules/audit/security-events';
import { notifySecurityEvent } from '../domain/auth/security-notices';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError, validationError } from '../middleware/http-error';
import { sendWithEtag } from '../middleware/etag';
import { requireAuth, requireConfirmedEmail } from '../middleware/auth';
import { gatewayApiKeys, GatewayKeyError } from '../domain/gateway/keys';
import { keyManagerOwner, keyViewerOwner, teams as teamsDomain, TeamError } from '../domain/teams/teams';
import { pool } from '../db';
import { resumeKey, suspendKey } from '../domain/suspension';
import { IDLE_DAYS, keyUsage, limitsFor } from '../domain/gateway/usage';
import { config } from '../config';
import { KEY_BUCKET_FACTOR, TEAM_BUCKET_FACTOR } from '../middleware/api-protection';
import { BrokerError } from '../domain/gateway/broker';
import { getServiceCatalog } from '../domain/gateway/services';
import { AddKeyServiceSchema, CreateGatewayKeySchema } from '../validators/gateway';
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
  return sendWithEtag(request, reply, { services: getServiceCatalog() });
}

export async function listGatewayKeysHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const user = request.currentUser!;
  const { teamId } = request.query as { teamId?: string };
  if (teamId) {
    // A team's keys are visible to every accepted member (a viewer sees them and their usage, never a secret).
    try {
      await teamsDomain.requireMember(teamId, user.id, 'viewer');
    } catch (err) {
      if (err instanceof TeamError) throw new HttpError(err.code === 'not_found' ? 404 : 403, err.message, `team_${err.code}`);
      throw err;
    }
    return reply.send({ apiKeys: await gatewayApiKeys.list(user.id, teamId) });
  }
  return reply.send({ apiKeys: await gatewayApiKeys.list(user.id) });
}

export async function createGatewayKeyHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const parsed = CreateGatewayKeySchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  const user = request.currentUser!;

  try {
    // A team key needs the developer role or higher in that team.
    if (parsed.data.teamId) await teamsDomain.requireMember(parsed.data.teamId, user.id, 'developer');
    const created = await gatewayApiKeys.create(user.id, parsed.data.label, parsed.data.services, parsed.data.expiresInDays, [...new Set(parsed.data.deskScopes)], parsed.data.teamId);
    auditKey(request, 'gateway_key_created', {
      userId: user.id,
      keyId: created.id,
      services: created.services.join(','),
      deskScopes: (created.deskScopes ?? []).join(','),
      teamId: created.teamId ?? '',
    });
    notifySecurityEvent(request, user.email, 'api_key_created', parsed.data.label);
    return reply.status(201).send({ apiKey: created });
  } catch (err) {
    if (err instanceof TeamError) throw new HttpError(err.code === 'not_found' ? 404 : 403, err.message, `team_${err.code}`);
    if (err instanceof GatewayKeyError) {
      throw new HttpError(err.code === 'limit_reached' ? 409 : err.code === 'team_desk_api' ? 400 : 503, err.message, `api_key_${err.code}`);
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
    const status = err.code === 'not_found' ? 404 : err.code === 'service_unavailable' ? 503 : err.code === 'team_desk_api' ? 400 : 409;
    throw new HttpError(status, err.message, `api_key_${err.code}`);
  }
  if (err instanceof BrokerError) throw new HttpError(502, 'Could not set up access to that API. Nothing was changed; please try again.', 'upstream_provisioning_failed');
  throw err;
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
    const owner = await keyManagerOwner(user.id, id);
    if (!owner) throw new GatewayKeyError('not_found', 'API key not found.');
    const key = await gatewayApiKeys.addService(owner, id, parsed.data.service);
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
    const owner = await keyManagerOwner(user.id, id);
    if (!owner) throw new GatewayKeyError('not_found', 'API key not found.');
    const key = await gatewayApiKeys.removeService(owner, id, service as GatewayService);
    auditKey(request, 'gateway_key_service_removed', { userId: user.id, keyId: id, service });
    return reply.send({ apiKey: key });
  } catch (err) {
    return keyServiceError(err);
  }
}

/** The calls a minute a key may make: a personal key gets half an address's worth; a team key draws on its team's shared allowance. */
async function effectivePerMinute(teamId: string | null): Promise<number> {
  if (!teamId) return Math.ceil(config.rateLimitPerMinute * KEY_BUCKET_FACTOR);
  const { rows } = await pool.query<{ rate_limit_per_minute: number | null }>(`SELECT rate_limit_per_minute FROM teams WHERE id = $1`, [teamId]);
  return rows[0]?.rate_limit_per_minute ?? Math.ceil(config.rateLimitPerMinute * TEAM_BUCKET_FACTOR);
}

/** How much one of the caller's own keys has been used (calls and errors per day), and the limits that apply to it. */
export async function keyUsageHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id } = request.params as { id: string };
  const q = request.query as { days?: string };
  const days = Math.min(90, Math.max(1, Number.parseInt(q.days ?? '30', 10) || 30));
  const viewerOwner = await keyViewerOwner(request.currentUser!.id, id);
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
    limits: limitsFor(await effectivePerMinute(mine.teamId ?? null)),
    ...(mine.teamId ? { teamId: mine.teamId, sharedWithTeam: true } : {}),
  });
}

/** The owner switches one of their own keys off without revoking it (a leaked key under investigation, or a pause). */
export async function suspendGatewayKeyHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id } = request.params as { id: string };
  const user = request.currentUser!;
  const owner = await keyManagerOwner(user.id, id);
  if (!owner || !(await suspendKey(id, owner, 'suspended by its owner', user.email))) throw new HttpError(404, 'That key does not exist, is not yours, or was revoked.', 'api_key_not_found');
  auditKey(request, 'gateway_key_suspended', { userId: user.id, keyId: id });
  return reply.send({ ok: true, suspended: true });
}

export async function resumeGatewayKeyHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id } = request.params as { id: string };
  const user = request.currentUser!;
  const owner = await keyManagerOwner(user.id, id);
  if (!owner || !(await resumeKey(id, owner))) throw new HttpError(404, 'That key is not suspended, or is not yours.', 'api_key_not_found');
  auditKey(request, 'gateway_key_resumed', { userId: user.id, keyId: id });
  return reply.send({ ok: true, suspended: false });
}

export async function revokeGatewayKeyHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id } = request.params as { id: string };
  const user = request.currentUser!;
  try {
    const owner = await keyManagerOwner(user.id, id);
    if (!owner) throw new GatewayKeyError('not_found', 'API key not found.');
    const { upstreamFailures } = await gatewayApiKeys.revoke(owner, id);
    auditKey(request, 'gateway_key_revoked', { userId: user.id, keyId: id });
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
