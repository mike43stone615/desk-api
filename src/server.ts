// Node.js server entry point — replaces the Hono/Cloudflare-Workers
// index.ts's `export default { fetch, scheduled }` (see git history).
// Runs on port 3458 (3456=registry-api, 3457=market-validation-api,
// 3000=compliance-os are already taken in this local fleet).
//
// This service is NOT wired into the Cloudflare Tunnel/DNS/watchdog — it
// runs standalone here for local development and review. Cutover is a
// separate, later step done by someone else.

// tracing MUST be first — patches modules before they are loaded
import './tracing';
import './config';
import { buildApp } from './app';
import { connectRedis } from './middleware/redis-client';
import { pool } from './db';
import { config } from './config';
import { startCleanupCron, stopCleanupCron } from './jobs/cron';

async function main() {
  await connectRedis();
  const app = await buildApp();

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
