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
import type { FastifyBaseLogger } from 'fastify';
import { authDb } from '../infrastructure/auth';
import { cronTicksTotal } from '../modules/metrics';

let task: cron.ScheduledTask | null = null;

export function startCleanupCron(log: FastifyBaseLogger): void {
  task = cron.schedule('0 2 * * *', () => {
    void runCleanup(log);
  });
}

async function runCleanup(log: FastifyBaseLogger): Promise<void> {
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
