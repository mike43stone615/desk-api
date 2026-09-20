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
import { backendKeySweepTotal, cronTicksTotal, gatewayKeyDrift } from '../modules/metrics';
import { reconcileBackendKeys } from '../domain/gateway/reconcile';
import { sweepBackendKeys } from '../domain/gateway/orphans';
import { getRedis } from '../middleware/redis-client';
import { deleteExpiredEmailInvites } from '../domain/setup/email-invites';
import { config } from '../config';

let task: cron.ScheduledTask | null = null;
let sweepTask: cron.ScheduledTask | null = null;
let reconcileTask: cron.ScheduledTask | null = null;

export function startCleanupCron(log: FastifyBaseLogger): void {
  task = cron.schedule('0 2 * * *', () => {
    void runCleanup(log);
  });
  // Backend keys left behind by deleted users/keys are revoked within minutes, and once at startup for anything
  // queued while the service was down.
  sweepTask = cron.schedule('*/5 * * * *', () => {
    void runBackendKeySweep(log);
  });
  void runBackendKeySweep(log);
  // The reconcile job compares this service's database with the backends and REVOKES keys it does not know. A
  // development copy (dev database, but possibly the same real backends) knows none of the real keys, so it must not run.
  if (config.usesDevDatabase) {
    log.info({ event: 'key_reconcile_skipped' }, 'development database: hourly backend-key reconcile is not scheduled');
  } else {
    reconcileTask = cron.schedule('17 * * * *', () => {
      void runKeyReconcile(log);
    });
  }
}

const RECONCILE_LOCK_KEY = 'desk-api:cron:key-reconcile:lock';

/** Hourly: compare our brokered keys with the backends' and revoke orphans; drift counts go to /metrics. */
export async function runKeyReconcile(log: FastifyBaseLogger): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try {
      if ((await redis.set(RECONCILE_LOCK_KEY, instanceId, 'PX', 30 * 60 * 1000, 'NX')) !== 'OK') return;
    } catch {
      // fail open, as for cleanup
    }
  }
  try {
    const report = await reconcileBackendKeys();
    gatewayKeyDrift.set({ kind: 'missing_backend_key' }, report.missing);
    gatewayKeyDrift.set({ kind: 'orphan_backend_key' }, report.orphansFailed);
    if (report.orphansRevoked) backendKeySweepTotal.inc({ outcome: 'orphan_revoked' }, report.orphansRevoked);
    if (report.orphansRevoked || report.orphansFailed || report.missing || report.unreachable.length) {
      log.warn({ event: 'gateway_key_drift', ...report }, 'backend keys were out of step with the gateway grants');
    }
  } catch (err) {
    log.error({ err }, 'gateway key reconcile failed');
  }
}

const SWEEP_LOCK_KEY = 'desk-api:cron:backend-key-sweep:lock';

export async function runBackendKeySweep(log: FastifyBaseLogger): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try {
      if ((await redis.set(SWEEP_LOCK_KEY, instanceId, 'PX', 4 * 60 * 1000, 'NX')) !== 'OK') return;
    } catch {
      // fail open, as for cleanup
    }
  }
  try {
    const { revoked, failed } = await sweepBackendKeys();
    if (revoked) backendKeySweepTotal.inc({ outcome: 'revoked' }, revoked);
    if (failed) {
      backendKeySweepTotal.inc({ outcome: 'failed' }, failed);
      log.warn({ event: 'backend_key_sweep_failed', failed }, 'some backend keys could not be revoked yet; will retry');
    }
    if (revoked) log.info({ event: 'backend_key_sweep', revoked }, 'revoked leftover backend keys');
  } catch (err) {
    log.error({ err }, 'backend key sweep failed');
  }
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
    await deleteExpiredEmailInvites();
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
  sweepTask?.stop();
  sweepTask = null;
  reconcileTask?.stop();
  reconcileTask = null;
}
