// Idempotency-Key support for the two setup-draft creation endpoints
// (POST /setup/drafts, POST /setup/drafts/:id/complete) — the concrete
// double-submit risk flagged in this session's audit (a flaky connection on
// mobile retrying a create request must not create two drafts / two
// businesses). Ported from compliance-os's src/middleware/idempotency.ts,
// adapted from its Prisma/idempotencyKey model to this repo's raw `pg`
// convention and a new idempotency_keys table (migrations/0006_idempotency_
// keys.sql) rather than reusing compliance-os's schema verbatim.
import { createHash } from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db';
import { normalizePath } from './api-protection';

declare module 'fastify' {
  interface FastifyRequest {
    idempotencyKey?: string;
    idempotencyRequestHash?: string;
  }
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Endpoints that opt into Idempotency-Key support. */
function isIdempotencyEligible(method: string, url: string): boolean {
  const path = normalizePath(url);
  if (method === 'POST' && path === '/setup/drafts') return true;
  if (method === 'POST' && /^\/setup\/drafts\/[^/]+\/complete$/.test(path)) return true;
  return false;
}

function hashRequestBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

interface IdempotencyRow {
  key: string;
  response_status: number;
  response_body: unknown;
  request_hash: string;
  expires_at: string;
}

/**
 * Registers opt-in Idempotency-Key support. Requests without the header
 * behave exactly as today. When present on an eligible endpoint:
 *  - unseen key -> executes normally, then caches the response for 24h
 *  - seen key + same request body hash -> replays the cached response (no re-execution)
 *  - seen key + different request body hash -> 409 conflict
 */
export function registerIdempotency(app: FastifyInstance) {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isIdempotencyEligible(request.method, request.url)) return;

    const rawKey = request.headers['idempotency-key'];
    if (typeof rawKey !== 'string' || rawKey.length === 0) return;

    const requestHash = hashRequestBody(request.body);

    let existing: IdempotencyRow | undefined;
    try {
      const { rows } = await pool.query<IdempotencyRow>(
        `SELECT key, response_status, response_body, request_hash, expires_at
         FROM idempotency_keys WHERE key = $1`,
        [rawKey],
      );
      existing = rows[0];
    } catch {
      // DB unavailable — fail open, this is an opt-in convenience feature, not a safety guarantee.
      return;
    }

    if (existing) {
      if (new Date(existing.expires_at).getTime() < Date.now()) {
        await pool.query(`DELETE FROM idempotency_keys WHERE key = $1`, [rawKey]).catch(() => {});
      } else if (existing.request_hash !== requestHash) {
        return reply
          .status(409)
          .header('Content-Type', 'application/problem+json')
          .send({
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            detail: 'Idempotency-Key was already used with a different request payload.',
            instance: request.url,
            error: 'Idempotency-Key was already used with a different request payload.',
          });
      } else {
        reply.header('Idempotency-Replayed', 'true');
        if (existing.response_body === null || existing.response_body === undefined) {
          return reply.status(existing.response_status).send();
        }
        return reply.status(existing.response_status).send(existing.response_body);
      }
    }

    // Not seen (or expired-and-cleared) — let the request execute; onSend records the result.
    request.idempotencyKey = rawKey;
    request.idempotencyRequestHash = requestHash;
  });

  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const key = request.idempotencyKey;
    const requestHash = request.idempotencyRequestHash;
    if (!key || !requestHash) return payload;

    let responseBody: unknown = null;
    if (typeof payload === 'string' && payload.length > 0) {
      try {
        responseBody = JSON.parse(payload);
      } catch {
        responseBody = null;
      }
    }

    const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString();

    Promise.resolve(
      pool.query(
        `INSERT INTO idempotency_keys (key, request_hash, response_status, response_body, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (key) DO UPDATE SET
           request_hash = excluded.request_hash,
           response_status = excluded.response_status,
           response_body = excluded.response_body,
           expires_at = excluded.expires_at`,
        [key, requestHash, reply.statusCode, responseBody, expiresAt],
      ),
    ).catch(() => {
      /* non-critical */
    });

    return payload;
  });
}
