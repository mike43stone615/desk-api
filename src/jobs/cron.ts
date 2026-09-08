// Session/token cleanup — the surviving piece of the original index.ts's
// scheduled() handler (see git history), driven by node-cron in-process on
// the same `0 2 * * *` daily schedule the Cloudflare Workers cron trigger
// used, matching market-validation-api's in-process-cron pattern
// (src/jobs/cron.ts there).
//
// Everything else that handler used to do is intentionally NOT ported:
//  - The three market-research batch jobs (reference-distribution,
//    commuter-density, sba-lending) are moot — the embedded market-research
//    engine those jobs fed is out of scope for this rewrite (see
//    routes/integrations/marketResearch.ts's header comment).
//  - The daily OEWS cache import is dropped for the same reason — OEWS
//    import now lives exclusively in market-validation-api.
import cron from 'node-cron';
import { randomUUID } from 'crypto';
import type { FastifyBaseLogger } from 'fastify';
import { authDb } from '../infrastructure/auth';
import { cronTicksTotal } from '../modules/metrics';
import { getRedis } from '../middleware/redis-client';

let task: cron.ScheduledTask | null = null;

export function startCleanupCron(log: FastifyBaseLogger): void {
  task = cron.schedule('0 2 * * *', () => {
    void runCleanup(log);
  });
}

// Real coordination gap this closes: node-cron runs in-process, so every
// running copy of this service independently fires its own 2am tick with no
// shared state between them — fine at today's single-instance scale, but
// running N copies would mean N redundant cleanup passes racing the same
// database rows every night. A short-TTL Redis lock (SET ... NX PX, the
// standard "only one winner" primitive) makes exactly one instance actually
// run each tick; the rest see the lock held and skip cleanly. When Redis
// isn't configured (today's actual deployment), this falls open to the
// original single-instance behavior -- there's nothing to coordinate yet.
const LOCK_KEY = 'desk-api:cron:auth-cleanup:lock';
const LOCK_TTL_MS = 5 * 60 * 1000; // generous headroom over a normal run; self-heals if a run crashes mid-lock
const instanceId = randomUUID();

async function acquireLock(): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true; // no coordination possible/needed without Redis -- run as before
  try {
    const result = await redis.set(LOCK_KEY, instanceId, 'PX', LOCK_TTL_MS, 'NX');
    return result === 'OK';
  } catch {
    return true; // Redis error -- fail open rather than silently stop running cleanup at all
  }
}

export async function runCleanup(log: FastifyBaseLogger): Promise<void> {
  if (!(await acquireLock())) {
    log.info({ event: 'cron_auth_cleanup_skipped' }, 'auth cleanup tick skipped -- another instance holds the lock');
    return;
  }
  try {
    await authDb.deleteExpiredSessions();
    await authDb.deleteExpiredPasswordResetTokens();
    await authDb.deleteExpiredEmailConfirmationTokens();
    cronTicksTotal.inc({ job: 'auth_cleanup', outcome: 'ok' });
    log.info({ event: 'cron_auth_cleanup' }, 'auth cleanup tick completed');
  } catch (err) {
    cronTicksTotal.inc({ job: 'auth_cleanup', outcome: 'error' });
    log.error({ err }, 'auth cleanup tick failed');
  }
}

export function stopCleanupCron(): void {
  task?.stop();
  task = null;
}
