// API Library key management: list the available APIs, and create / list /
// revoke the signed-in user's own keys. Every handler requires a real SESSION
// — an API Library key can't reach these (see GATEWAY_KEY_ALLOWED_ROUTES in
// middleware/auth.ts), so a leaked key can never mint more keys or revoke
// its siblings. Ownership is enforced inside gatewayApiKeys (WHERE
// owner_user_id = $n), never by trusting an id from the URL.
import { recordSecurityEvent } from '../modules/audit/security-events';
import { notifySecurityEvent } from '../domain/auth/security-notices';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../middleware/http-error';
import { requireAuth, requireConfirmedEmail } from '../middleware/auth';
import { gatewayApiKeys, GatewayKeyError } from '../domain/gateway/keys';
import { BrokerError } from '../domain/gateway/broker';
import { getServiceCatalog } from '../domain/gateway/services';
import { CreateGatewayKeySchema } from '../validators/gateway';
import { LIBRARY_OPENAPI_SPEC } from '../openapi';

function auditKey(request: FastifyRequest, event: string, meta: Record<string, unknown>) {
  request.log.info({ level: 'audit', event, requestId: request.id, ts: new Date().toISOString(), ...meta });
  recordSecurityEvent(request, event, 'ok', Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, String(v)])));
}

/** The developer-facing API description. Public: it documents only what a key can do. */
export async function libraryOpenApiHandler(_request: FastifyRequest, reply: FastifyReply) {
  return reply.send(LIBRARY_OPENAPI_SPEC);
}

export async function listGatewayServicesHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  return reply.send({ services: getServiceCatalog() });
}

export async function listGatewayKeysHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const keys = await gatewayApiKeys.list(request.currentUser!.id);
  return reply.send({ apiKeys: keys });
}

export async function createGatewayKeyHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const parsed = CreateGatewayKeySchema.safeParse(request.body ?? {});
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join('; '), 'validation_error');
  const user = request.currentUser!;

  try {
    const created = await gatewayApiKeys.create(user.id, parsed.data.label, parsed.data.services);
    auditKey(request, 'gateway_key_created', {
      userId: user.id,
      keyId: created.id,
      services: created.services.join(','),
    });
    notifySecurityEvent(request, user.email, 'api_key_created', parsed.data.label);
    return reply.status(201).send({ apiKey: created });
  } catch (err) {
    if (err instanceof GatewayKeyError) {
      throw new HttpError(err.code === 'limit_reached' ? 409 : 503, err.message, `api_key_${err.code}`);
    }
    if (err instanceof BrokerError) {
      request.log.error({ err }, 'gateway key provisioning failed');
      throw new HttpError(502, 'Could not set up access to one of the selected APIs. Nothing was created; please try again.', 'upstream_provisioning_failed');
    }
    throw err;
  }
}

export async function revokeGatewayKeyHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id } = request.params as { id: string };
  const user = request.currentUser!;
  try {
    const { upstreamFailures } = await gatewayApiKeys.revoke(user.id, id);
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
      throw new HttpError(err.code === 'not_found' ? 404 : 409, err.message, `api_key_${err.code}`);
    }
    throw err;
  }
}
