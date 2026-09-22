// Outbound webhook endpoints: a developer says where Desk should send events and which ones. Session-only. The signing secret
// is shown once, when the endpoint is made or its secret rotated. See domain/webhooks/webhooks.ts for the delivery rules.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, validationError } from '../middleware/http-error';
import { requireAuth, requireConfirmedEmail } from '../middleware/auth';
import { recordSecurityEvent } from '../modules/audit/security-events';
import { WEBHOOK_EVENTS, WebhookError, webhooks } from '../domain/webhooks/webhooks';

const CreateSchema = z.object({
  url: z.string().trim().min(1, 'A URL is required.').max(500, 'That address is too long.'),
  events: z.array(z.enum(WEBHOOK_EVENTS.filter((e) => e !== 'webhook.test') as [string, ...string[]])).min(1, 'Choose at least one event.').max(20),
  teamId: z.string().trim().min(1).max(64).optional(),
});

function fail(err: unknown): never {
  if (err instanceof WebhookError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : err.code === 'limit_reached' ? 409 : err.code === 'unavailable' ? 503 : 400;
    throw new HttpError(status, err.message, `webhook_${err.code}`);
  }
  throw err;
}

const audit = (request: FastifyRequest, event: string, meta: Record<string, string>) => {
  request.log.info({ level: 'audit', event, requestId: request.id, ...meta });
  recordSecurityEvent(request, event, 'ok', meta);
};

/** The events a webhook can listen for. */
export async function listWebhookEventsHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  return reply.send({ events: WEBHOOK_EVENTS.filter((e) => e !== 'webhook.test') });
}

export async function createWebhookHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const parsed = CreateSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  try {
    const { endpoint, secret } = await webhooks.create(request.currentUser!.id, parsed.data);
    audit(request, 'webhook_created', { userId: request.currentUser!.id, endpointId: endpoint.id });
    return reply.status(201).header('Location', `/v1/gateway/webhooks/${endpoint.id}`).send({ endpoint, secret, note: 'This is the only time the signing secret is shown.' });
  } catch (err) {
    return fail(err);
  }
}

export async function listWebhooksHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { teamId } = request.query as { teamId?: string };
  try {
    return reply.send({ hasMore: false, endpoints: await webhooks.list(request.currentUser!.id, teamId) });
  } catch (err) {
    return fail(err);
  }
}

export async function deleteWebhookHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id } = request.params as { id: string };
  if (!(await webhooks.remove(request.currentUser!.id, id))) throw new HttpError(404, 'No such webhook endpoint.', 'webhook_not_found');
  audit(request, 'webhook_deleted', { userId: request.currentUser!.id, endpointId: id });
  return reply.status(204).send();
}

export async function rotateWebhookSecretHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id } = request.params as { id: string };
  const secret = await webhooks.rotateSecret(request.currentUser!.id, id);
  if (!secret) throw new HttpError(404, 'No such webhook endpoint.', 'webhook_not_found');
  audit(request, 'webhook_secret_rotated', { userId: request.currentUser!.id, endpointId: id });
  return reply.send({ secret, note: 'This is the only time the signing secret is shown. The endpoint is switched on again.' });
}

export async function testWebhookHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id } = request.params as { id: string };
  if (!(await webhooks.sendTest(request.currentUser!.id, id))) throw new HttpError(404, 'No such webhook endpoint.', 'webhook_not_found');
  return reply.status(202).send({ ok: true, message: 'A test event is queued; see the deliveries list for the result.' });
}

export async function webhookDeliveriesHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id } = request.params as { id: string };
  const rows = await webhooks.deliveries(request.currentUser!.id, id);
  if (!rows) throw new HttpError(404, 'No such webhook endpoint.', 'webhook_not_found');
  return reply.send({ hasMore: false, deliveries: rows });
}

/** Puts one failed delivery back in line right now, with a fresh set of tries; switches the endpoint back on if it had been disabled. */
export async function retryWebhookDeliveryHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id, deliveryId } = request.params as { id: string; deliveryId: string };
  const ok = await webhooks.retryDelivery(request.currentUser!.id, id, deliveryId);
  if (!ok) throw new HttpError(404, 'No such webhook endpoint, or that delivery has not failed.', 'webhook_delivery_not_found');
  audit(request, 'webhook_delivery_retried', { userId: request.currentUser!.id, endpointId: id, deliveryId });
  return reply.status(202).send({ ok: true, message: 'Queued to try again.' });
}
