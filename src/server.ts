/**
 * Node.js server entry point — used for self-hosted deployment.
 *
 * This file is NOT used in Cloudflare Workers. It is a scaffold for the future
 * migration described in docs/FUTURE-MIGRATION.md.
 *
 * Before using:
 *   1. Install: npm install @hono/node-server
 *   2. Replace the D1DatabaseAdapter with the PostgreSQL adapter
 *   3. Replace the R2StorageAdapter with the MinIO adapter
 *   4. Set environment variables (see compose.yaml)
 *
 * See docs/KNOWN-LIMITATIONS.md #6 and docs/FUTURE-MIGRATION.md for the full plan.
 */

// TODO: implement when self-hosting.
// Example:
//
// import { serve } from '@hono/node-server';
// import app from './index.js';
//
// const port = Number(process.env.PORT ?? 8787);
//
// serve({ fetch: app.fetch, port }, (info) => {
//   console.log(JSON.stringify({ level: 'info', event: 'server_started', port: info.port }));
// });
//
// process.on('SIGTERM', () => {
//   console.log(JSON.stringify({ level: 'info', event: 'server_stopping' }));
//   process.exit(0);
// });

throw new Error('src/server.ts is a scaffold. See docs/FUTURE-MIGRATION.md before enabling.');
