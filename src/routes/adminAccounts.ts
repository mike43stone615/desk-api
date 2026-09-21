// Administrator tools for accounts and API keys: see every key, and switch an account or a key off (and back on)
// without deleting anything. Same guard as the rest of /admin (an allowlisted admin session, or the admin key).
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db';
import { HttpError, validationError } from '../middleware/http-error';
import { guard } from './admin';
import { forgetKeyRateFactors } from '../domain/gateway/keys';
import { logMutation, requestIp, requestUserAgent } from '../modules/audit/mutation-audit';
import { resumeKey, suspendKey, suspendUser, unsuspendUser } from '../domain/suspension';
import { lastReconcileReport, runReconcileAndRemember } from '../domain/gateway/reconcile';

const ReasonSchema = z.object({ reason: z.string().trim().max(300, 'reason must be at most 300 characters').optional() });

function actor(request: FastifyRequest): string {
  return request.currentUser?.email ?? 'admin-api-key';
}

function record(request: FastifyRequest, action: string, entityType: string, entityId: string, after: unknown) {
  logMutation({ userId: request.currentUser?.id ?? null, userEmail: actor(request), action, entityType, entityId, after, ipAddress: requestIp(request), userAgent: requestUserAgent(request) });
}

/** Every API key that has not been revoked: who owns it, what it can reach, when it was last used, and whether it is switched off. */
export async function adminListKeysHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  const { rows } = await pool.query(
    `SELECT k.id, k.label, k.key_prefix, k.created_at, k.last_used_at, u.email AS owner_email, u.id AS owner_id,
            (SELECT string_agg(g.service, ',' ORDER BY g.service) FROM gateway_api_key_grants g WHERE g.api_key_id = k.id) AS services,
            (SELECT reason FROM key_suspensions ks WHERE ks.api_key_id = k.id) AS key_suspended_reason,
            EXISTS (SELECT 1 FROM key_suspensions ks WHERE ks.api_key_id = k.id) AS key_suspended,
            EXISTS (SELECT 1 FROM account_suspensions a WHERE a.user_id = k.owner_user_id) AS owner_suspended
     FROM gateway_api_keys k JOIN users u ON u.id = k.owner_user_id
     WHERE k.revoked_at IS NULL ORDER BY k.created_at DESC LIMIT 500`,
  );
  return reply.send({
    keys: rows.map((r) => ({
      id: r.id,
      label: r.label,
      keyPrefix: r.key_prefix,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      owner: { id: r.owner_id, email: r.owner_email },
      services: r.services ? String(r.services).split(',') : [],
      suspended: Boolean(r.key_suspended),
      suspendedReason: r.key_suspended_reason ?? null,
      ownerSuspended: Boolean(r.owner_suspended),
    })),
  });
}

/** What the last comparison of our keys with the backends' found (orphans revoked, keys missing upstream). */
export async function adminReconcileReportHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  return reply.send({ last: lastReconcileReport() });
}

/** Compares our keys with the backends' now (the same thing the hourly job does: orphans are revoked). */
export async function adminReconcileRunHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  const report = await runReconcileAndRemember(actor(request));
  record(request, 'reconcile_keys', 'gateway_api_key', 'all', report);
  return reply.send({ last: lastReconcileReport() });
}

export async function adminSuspendUserHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  const { id } = request.params as { id: string };
  const parsed = ReasonSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  if (request.currentUser?.id === id) throw new HttpError(400, 'You cannot suspend your own account.', 'validation_error');
  if (!(await suspendUser(id, parsed.data.reason ?? 'suspended by an administrator', actor(request)))) throw new HttpError(404, 'No such account.', 'not_found');
  record(request, 'suspend_account', 'user', id, { reason: parsed.data.reason ?? null });
  return reply.send({ ok: true, suspended: true });
}

export async function adminUnsuspendUserHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  const { id } = request.params as { id: string };
  if (!(await unsuspendUser(id))) throw new HttpError(404, 'That account is not suspended.', 'not_found');
  record(request, 'unsuspend_account', 'user', id, null);
  return reply.send({ ok: true, suspended: false });
}

export async function adminSuspendKeyHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  const { id } = request.params as { id: string };
  const parsed = ReasonSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  if (!(await suspendKey(id, null, parsed.data.reason ?? 'suspended by an administrator', actor(request)))) throw new HttpError(404, 'No such key (or it was revoked).', 'api_key_not_found');
  record(request, 'suspend_key', 'gateway_api_key', id, { reason: parsed.data.reason ?? null });
  return reply.send({ ok: true, suspended: true });
}

const KeyLimitSchema = z.object({ perMinute: z.number().int('perMinute must be a whole number.').min(1).max(6000).nullable() });

/** Gives one key its own per-minute limit (a partner), or clears it (null) so the standard limit applies again. */
export async function adminSetKeyLimitHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  const { id } = request.params as { id: string };
  const parsed = KeyLimitSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  const result = await pool.query(`UPDATE gateway_api_keys SET rate_limit_per_minute = $2 WHERE id = $1 AND revoked_at IS NULL`, [id, parsed.data.perMinute]);
  if ((result.rowCount ?? 0) === 0) throw new HttpError(404, 'No such key (or it is revoked).', 'not_found');
  forgetKeyRateFactors();
  record(request, 'set_key_limit', 'gateway_api_key', id, { perMinute: parsed.data.perMinute });
  return reply.send({ ok: true, perMinute: parsed.data.perMinute });
}

export async function adminResumeKeyHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  const { id } = request.params as { id: string };
  if (!(await resumeKey(id, null))) throw new HttpError(404, 'That key is not suspended.', 'api_key_not_found');
  record(request, 'resume_key', 'gateway_api_key', id, null);
  return reply.send({ ok: true, suspended: false });
}
