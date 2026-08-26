// Fastify application assembly — ported from the original index.ts (Hono).
// Two structural changes from the Hono version, both part of this rewrite's
// standard scaffold (see registry-api's/market-validation-api's src/app.ts):
//
//  1. /v1-prefixed routes registered alongside unprefixed legacy routes
//     (registerVersionedRoutes runs twice below). Important: the current
//     Flutter build's DeskApiClient (desk_business/lib/core/api_client.dart)
//     calls unprefixed paths like /auth/signin directly, so the unprefixed
//     registration must keep working identically — it is not being
//     deprecated, /v1 is purely additive.
//  2. RFC 7807 error handling, Zod request validation, 4-tier rate
//     limiting, OpenTelemetry, Prometheus /metrics, OpenAPI+Swagger UI —
//     none of this existed in the Hono version; all new per this rewrite's
//     scaffold requirements.
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'crypto';
import { pool } from './db';
import { config } from './config';
import { getRedis } from './middleware/redis-client';
import { registerErrorHandler } from './middleware/http-error';
import { registerApiProtection } from './middleware/api-protection';
import { registerIdempotency } from './middleware/idempotency';
import { requireMetricsDocsKey } from './middleware/auth';
import { OPENAPI_SPEC } from './openapi';
import { metricsRegistry, httpRequestsTotal, httpRequestDurationMs, normalizeRoute } from './modules/metrics';

import {
  signUpHandler,
  signInHandler,
  signOutHandler,
  sessionHandler,
  requestEmailConfirmationHandler,
  confirmEmailHandler,
  requestPasswordResetHandler,
  confirmPasswordResetHandler,
  updatePasswordHandler,
} from './routes/auth';
import {
  listDraftsHandler,
  getDraftHandler,
  createDraftHandler,
  patchDraftHandler,
  deleteDraftHandler,
  completeDraftHandler,
  listBusinessesHandler,
  listBusinessMembersHandler,
  inviteBusinessMemberHandler,
  removeBusinessMemberHandler,
} from './routes/setup';
import {
  adminTablesHandler,
  adminTableRowsHandler,
  adminTableUpdateRowHandler,
  adminTableDeleteRowHandler,
} from './routes/admin';
import { analyzeBusinessSetupHandler } from './routes/functions/analyzeBusinessSetup';
import { searchPlaceAreasHandler } from './routes/functions/searchPlaceAreas';
import {
  businessTypesHandler,
  requirementsSearchHandler,
  jurisdictionsHandler,
} from './routes/integrations/compliance';
import {
  checkBusinessNameAvailabilityHandler,
  checkDbaNameAvailabilityHandler,
  checkTrademarkAvailabilityHandler,
  checkNameMultiStateHandler,
  checkNamesBatchHandler,
  registrySyncStatusHandler,
  businessStructuresHandler,
  businessStructureBySlugHandler,
  recommendBusinessStructuresHandler,
} from './routes/integrations/registry';
import { marketResearchAnalyzeHandler } from './routes/integrations/marketResearch';
import { complianceGatewayHandler, registryGatewayHandler } from './routes/apiGateway';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // Password-reset and email-confirmation requests intentionally return 200
  // even when this is unset (src/infrastructure/email/resend.ts logs a
  // warning and no-ops, to avoid account enumeration) -- there is no
  // request-time signal that email silently isn't sending. A startup
  // warning is the only place this gets surfaced. See
  // docs/KNOWN-LIMITATIONS.md #4.
  if (!config.resendApiKey && config.environment === 'production') {
    app.log.warn(
      'RESEND_API_KEY is not set in production — password-reset and email-confirmation requests will return 200 but no email will actually send.',
    );
  }

  await app.register(cors, {
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
    credentials: true,
  });

  // OpenAPI spec + Swagger UI — publicly reachable by default, optionally
  // gated behind METRICS_DOCS_API_KEY (see middleware/auth.ts's
  // requireMetricsDocsKey, a no-op unless that env var is set).
  app.get(
    '/docs/openapi.json',
    { preHandler: requireMetricsDocsKey },
    async (_req, reply) => reply.send(OPENAPI_SPEC),
  );
  app.get('/docs', { preHandler: requireMetricsDocsKey }, async (_req, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return reply.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Desk API — Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"/>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({ url: '/docs/openapi.json', dom_id: '#swagger-ui', presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset] });
  </script>
</body>
</html>`);
  });

  async function getReadiness(): Promise<{ ok: boolean; checks: Record<string, 'ok' | 'error'> }> {
    const checks: Record<string, 'ok' | 'error'> = {};
    try {
      await pool.query('SELECT 1');
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }
    const redis = getRedis();
    if (redis) {
      try {
        await redis.ping();
        checks.redis = 'ok';
      } catch {
        checks.redis = 'error';
      }
    } else {
      checks.redis = config.redisUrl ? 'error' : 'ok';
    }
    const ok = Object.values(checks).every((v) => v === 'ok');
    return { ok, checks };
  }

  app.get('/health/live', async (_req, reply) => reply.status(200).send({ ok: true, service: 'desk-api' }));
  app.get('/health/ready', async (_req, reply) => {
    const { ok, checks } = await getReadiness();
    return reply.status(ok ? 200 : 503).send({ ok, checks });
  });
  // Back-compat alias for the original Hono version's GET /health (basic liveness,
  // no dependency checks) — kept cheap/dependency-free since nothing in the Flutter
  // client depends on it reflecting DB health specifically.
  app.get('/health', async (_req, reply) => reply.send({ ok: true, service: 'desk-api', ts: new Date().toISOString() }));

  app.get('/metrics', { preHandler: requireMetricsDocsKey }, async (_req, reply) => {
    reply.header('Content-Type', metricsRegistry.contentType);
    return reply.send(await metricsRegistry.metrics());
  });

  registerErrorHandler(app);
  registerApiProtection(app);
  registerIdempotency(app);

  app.addHook('onRequest', async (request) => {
    (request as { _startTime?: number })._startTime = Date.now();
  });
  app.addHook('onResponse', async (request, reply) => {
    const start = (request as { _startTime?: number })._startTime;
    const route = normalizeRoute(request.url);
    const method = request.method;
    const status = String(reply.statusCode);
    httpRequestsTotal.inc({ method, route, status_code: status });
    if (start !== undefined) {
      httpRequestDurationMs.observe({ method, route }, Date.now() - start);
    }
  });

  await app.register(registerLegacyAndVersionedRoutes);
  await app.register(registerLegacyAndVersionedRoutes, { prefix: '/v1' });

  return app;
}

async function registerLegacyAndVersionedRoutes(instance: FastifyInstance) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  instance.post('/auth/signup', signUpHandler);
  instance.post('/auth/signin', signInHandler);
  instance.post('/auth/signout', signOutHandler);
  instance.get('/auth/session', sessionHandler);
  instance.post('/auth/email-confirmation/request', requestEmailConfirmationHandler);
  instance.post('/auth/email-confirmation/confirm', confirmEmailHandler);
  instance.post('/auth/password-reset/request', requestPasswordResetHandler);
  instance.post('/auth/password-reset/confirm', confirmPasswordResetHandler);
  instance.post('/auth/password', updatePasswordHandler);

  // ── Business setup ───────────────────────────────────────────────────────
  instance.get('/setup/drafts', listDraftsHandler);
  instance.get('/setup/drafts/:id', getDraftHandler);
  instance.post('/setup/drafts', createDraftHandler);
  instance.patch('/setup/drafts/:id', patchDraftHandler);
  instance.delete('/setup/drafts/:id', deleteDraftHandler);
  instance.post('/setup/drafts/:id/complete', completeDraftHandler);
  instance.get('/setup/businesses', listBusinessesHandler);
  instance.get('/setup/businesses/:id/members', listBusinessMembersHandler);
  instance.post('/setup/businesses/:id/members', inviteBusinessMemberHandler);
  instance.delete('/setup/businesses/:id/members/:membershipId', removeBusinessMemberHandler);

  // ── Admin table browser (+ upstream aggregation) ────────────────────────
  instance.get('/admin/tables', adminTablesHandler);
  instance.get('/admin/tables/:table/rows', adminTableRowsHandler);
  instance.patch('/admin/tables/:table/rows/:id', adminTableUpdateRowHandler);
  instance.delete('/admin/tables/:table/rows/:id', adminTableDeleteRowHandler);

  // ── Edge Function replacements ───────────────────────────────────────────
  instance.post('/functions/v1/analyze-business-setup', analyzeBusinessSetupHandler);
  instance.post('/functions/v1/search-place-areas', searchPlaceAreasHandler);

  // ── Registry API proxy (mounted at /functions/v1, mirroring registry-api paths) ──
  instance.post('/functions/v1/check-business-name-availability', checkBusinessNameAvailabilityHandler);
  instance.post('/functions/v1/check-dba-name-availability', checkDbaNameAvailabilityHandler);
  instance.post('/functions/v1/check-trademark-availability', checkTrademarkAvailabilityHandler);
  instance.post('/functions/v1/check-name-multi-state', checkNameMultiStateHandler);
  instance.post('/functions/v1/check-names-batch', checkNamesBatchHandler);
  instance.get('/functions/v1/registry-sync-status', registrySyncStatusHandler);
  instance.get('/functions/v1/business-structures', businessStructuresHandler);
  instance.get('/functions/v1/business-structures/:slug', businessStructureBySlugHandler);
  instance.post('/functions/v1/business-structures/recommend', recommendBusinessStructuresHandler);

  // ── Compliance-OS integration proxy (app.deskbusiness.co) ────────────────
  instance.get('/integrations/compliance/business-types', businessTypesHandler);
  instance.get('/integrations/compliance/requirements/search', requirementsSearchHandler);
  instance.get('/integrations/compliance/jurisdictions', jurisdictionsHandler);
  instance.post('/integrations/market-research/analyze', marketResearchAnalyzeHandler);

  // ── api.deskbusiness.co gateway — transparent proxy to upstream services ─
  instance.all('/compliance/*', complianceGatewayHandler);
  instance.all('/registry/*', registryGatewayHandler);
}
