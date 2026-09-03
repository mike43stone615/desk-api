// Idempotency-Key support for the two setup-draft creation endpoints
// (POST /setup/drafts, POST /setup/drafts/:id/complete) — the concrete
// double-submit risk flagged in this session's audit (a flaky connection on
// mobile retrying a create request must not create two drafts / two
// businesses). Ported from compliance-os's src/middleware/idempotency.ts,
// adapted from its Prisma/idempotencyKey model to this repo's raw `pg`
// convention and a new idempotency_keys table (migrations/0006_idempotency_
// keys.sql) rather than reusing compliance-os's schema verbatim.
//
// The key is claimed atomically via INSERT ... ON CONFLICT DO NOTHING at
// request start (migrations/0007 made response_status nullable so a claimed
// row can represent "in flight, not yet completed"), not written after the
// handler runs — two genuinely concurrent requests with the same key can no
// longer both pass the "have I seen this?" check before either claims it.
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
// A crash between claiming a key and completing the request shouldn't wedge
// that key in "in flight" for the full 24h TTL — treat a claim this old with
// no recorded response as abandoned, and let a fresh request reclaim it.
const IN_FLIGHT_STALE_MS = 30 * 1000; // 30s

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
  response_status: number | null;
  response_body: unknown;
  request_hash: string;
  expires_at: string;
  created_at: string;
}

function conflictProblem(request: FastifyRequest, reply: FastifyReply, detail: string) {
  return reply
    .status(409)
    .header('Content-Type', 'application/problem+json')
    .send({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail,
      instance: request.url,
      error: detail,
    });
}

/**
 * Registers opt-in Idempotency-Key support. Requests without the header
 * behave exactly as today. When present on an eligible endpoint:
 *  - unclaimed key -> atomically claimed, executes normally, onSend records the response
 *  - claimed key, still in flight, same request hash -> 409 (genuinely concurrent retry)
 *  - completed key + same request body hash -> replays the cached response (no re-execution)
 *  - completed/in-flight key + different request body hash -> 409 conflict
 */
export function registerIdempotency(app: FastifyInstance) {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isIdempotencyEligible(request.method, request.url)) return;

    const rawKey = request.headers['idempotency-key'];
    if (typeof rawKey !== 'string' || rawKey.length === 0) return;

    const requestHash = hashRequestBody(request.body);
    const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString();

    // At most one retry: the first pass either claims the key or inspects
    // why it couldn't, clearing an expired/abandoned row and looping once
    // to claim fresh. A second failure just means real, current contention.
    for (let attempt = 0; attempt < 2; attempt++) {
      let claim: { rowCount: number | null };
      try {
        claim = await pool.query(
          `INSERT INTO idempotency_keys (key, request_hash, response_status, response_body, expires_at)
           VALUES ($1, $2, NULL, NULL, $3)
           ON CONFLICT (key) DO NOTHING`,
          [rawKey, requestHash, expiresAt],
        );
      } catch {
        // DB unavailable — fail open, this is an opt-in convenience feature, not a safety guarantee.
        return;
      }

      if (claim.rowCount === 1) {
        // Atomically claimed — proceed, onSend fills in the response.
        request.idempotencyKey = rawKey;
        request.idempotencyRequestHash = requestHash;
        return;
      }

      // Someone else already holds a row for this key — inspect it.
      let existing: IdempotencyRow | undefined;
      try {
        const { rows } = await pool.query<IdempotencyRow>(
          `SELECT key, response_status, response_body, request_hash, expires_at, created_at
           FROM idempotency_keys WHERE key = $1`,
          [rawKey],
        );
        existing = rows[0];
      } catch {
        return;
      }
      if (!existing) continue; // raced with a delete elsewhere — retry the claim

      const isExpired = new Date(existing.expires_at).getTime() < Date.now();
      const isAbandonedInFlight =
        existing.response_status === null &&
        Date.now() - new Date(existing.created_at).getTime() > IN_FLIGHT_STALE_MS;

      if (isExpired || isAbandonedInFlight) {
        await pool.query(`DELETE FROM idempotency_keys WHERE key = $1`, [rawKey]).catch(() => {});
        continue; // retry the atomic claim now that the stale row is gone
      }

      if (existing.request_hash !== requestHash) {
        return conflictProblem(request, reply, 'Idempotency-Key was already used with a different request payload.');
      }

      if (existing.response_status === null) {
        // Genuinely concurrent: another request with this exact key + payload
        // is executing right now. This is the case the whole feature exists
        // for — reject rather than let both proceed; the caller's own retry
        // logic (the flaky-connection scenario this protects against) will
        // try again shortly, by which point the first request has completed.
        return conflictProblem(request, reply, 'This request is already being processed. Retry shortly.');
      }

      reply.header('Idempotency-Replayed', 'true');
      if (existing.response_body === null || existing.response_body === undefined) {
        return reply.status(existing.response_status).send();
      }
      return reply.status(existing.response_status).send(existing.response_body);
    }
    // Exhausted the retry budget under real, current contention — fail open
    // rather than block the request indefinitely; worst case here is the
    // original (rare) double-submit risk, not a hang.
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

    // Awaited (not fire-and-forget): the response shouldn't reach the client
    // before the completion is durably recorded, or a crash in between would
    // leave the key claimed-but-incomplete until the staleness window passes.
    try {
      await pool.query(
        `UPDATE idempotency_keys SET response_status = $2, response_body = $3 WHERE key = $1`,
        [key, reply.statusCode, responseBody],
      );
    } catch {
      /* non-critical — worst case this key stays "in flight" until it goes stale */
    }

    return payload;
  });
}
