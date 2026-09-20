// Node.js server entry point — replaces the Hono/Cloudflare-Workers
// index.ts's `export default { fetch, scheduled }` (see git history).
// Runs on port 3458 (3456=registry-api, 3457=market-validation-api,
// 3000=compliance-os are already taken in this local fleet).
//
// Live: the Cloudflare Tunnel routes api.deskbusiness.co to
// http://localhost:3458, i.e. this process. Bind loopback-only — the
// tunnel always connects via localhost on this same machine.

// dotenv MUST be first, before anything below reads process.env — Sentry and
// tracing.ts both read their config (SENTRY_DSN, OTEL_EXPORTER_OTLP_ENDPOINT)
// at import time, and both were silently no-ops in production because
// './config' (which loads dotenv) was imported after them, not before. Live
// confirmed: with the old order, both env vars read as undefined at the
// exact moment Sentry.init()/tracing.ts evaluated them.
import 'dotenv/config';
import cluster from 'node:cluster';
// Sentry MUST be first after dotenv — captures errors during the imports/setup below too.
import { Sentry } from './sentry';
// tracing MUST come right after Sentry — patches modules before they are loaded
import './tracing';
import './config';
import { buildApp } from './app';
import { connectRedis } from './middleware/redis-client';
import { pool } from './db';
import { config } from './config';
import { startCleanupCron, stopCleanupCron } from './jobs/cron';
import { shouldCaptureError } from './middleware/http-error';

async function main() {
  await connectRedis();
  const app = await buildApp();
  Sentry.setupFastifyErrorHandler(app, { shouldHandleError: shouldCaptureError });

  try {
    await app.listen({ port: config.port, host: '127.0.0.1' });
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
    await app.close();
    await pool.end();
    return;
  }

  startCleanupCron(app.log);

  const shutdown = async () => {
    stopCleanupCron();
    await app.close();
    await pool.end();
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  // Started by the supervisor (src/supervisor.ts): tell it this copy is serving, and when it asks this copy to step
  // down (a newer one is already answering) finish the requests in flight, then leave. Run directly, neither applies.
  if (cluster.isWorker) {
    // First the supervisor says "drain": from then on every answer carries `Connection: close`, so clients (the
    // tunnel keeps connections open) move to new connections instead of reusing one that is about to be closed.
    process.on('message', (m) => {
      if ((m as { type?: string } | null)?.type === 'drain') app.server.on('request', (_req, res) => res.setHeader('Connection', 'close'));
    });
    process.send?.({ type: 'ready' });
    process.once('disconnect', () => void shutdown().finally(() => process.exit(0)));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
