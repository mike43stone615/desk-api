// Admin mutation audit logging — ported from market-validation-api's
// src/modules/audit/mutation-audit.service.ts (itself ported from
// compliance-os), adapted only in file location/name
// (modules/audit/mutation-audit.ts vs. mutation-audit.service.ts — matching
// this repo's existing module-naming convention rather than the sibling's).
// Deliberately simple and fire-and-forget: a logging failure must never
// break the actual mutation it's describing.
import { randomUUID } from 'crypto';
import type { FastifyRequest } from 'fastify';
import { pool } from '../../db';
import { getClientIp } from '../../middleware/api-protection';

export interface MutationAuditEntry {
  userId?: string | null;
  userEmail?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Inserts one row into mutation_audit_log. Fire-and-forget — does not
 * return a promise callers need to await, and never throws.
 */
export function logMutation(entry: MutationAuditEntry): void {
  Promise.resolve(
    pool.query(
      `INSERT INTO mutation_audit_log
         (id, user_id, user_email, action, entity_type, entity_id, before, after, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        randomUUID(),
        entry.userId ?? null,
        entry.userEmail ?? null,
        entry.action,
        entry.entityType,
        entry.entityId,
        entry.before !== undefined ? entry.before : null,
        entry.after !== undefined ? entry.after : null,
        entry.ipAddress ?? null,
        entry.userAgent ?? null,
      ],
    ),
  ).catch(() => {});
}

/** The real client address (behind the tunnel request.ip is always this machine). */
export function requestIp(request: FastifyRequest): string | null {
  return getClientIp(request);
}

export function requestUserAgent(request: { headers: Record<string, unknown> }): string | null {
  const ua = request.headers['user-agent'];
  return typeof ua === 'string' ? ua : null;
}
