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
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { randomUUID } from 'crypto';
import { pool } from './db';
import { config } from './config';
import { getRedis } from './middleware/redis-client';
import { registerErrorHandler } from './middleware/http-error';
import { registerNotFound } from './middleware/not-found';
import { registerOriginCheck } from './middleware/origin-check';
import { registerApiProtection } from './middleware/api-protection';
import { requireAuth } from './middleware/auth';
import { registerRouteLimits } from './middleware/route-limits';
import { checkDependencies, isDegraded } from './domain/health/dependencies';
import { applyHtmlCsp, docsCsp, docsInlineScript, SWAGGER_UI_CSS_SRI, SWAGGER_UI_JS_SRI, SWAGGER_UI_VERSION } from './middleware/csp';
import { registerIdempotency } from './middleware/idempotency';
import { requireMetricsDocsKey } from './middleware/auth';
import { OPENAPI_SPEC } from './openapi';
import { metricsRegistry, httpRequestsTotal, httpRequestDurationMs, routeLabel, methodLabel } from './modules/metrics';

import {
  signUpHandler,
  signInHandler,
  signOutHandler,
  listSessionsHandler,
  revokeSessionHandler,
  signOutEverywhereHandler,
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
  listPendingInvitesHandler,
  acceptBusinessInviteHandler,
  declineBusinessInviteHandler,
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
import {
  createGatewayKeyHandler,
  libraryOpenApiHandler,
  listGatewayKeysHandler,
  listGatewayServicesHandler,
  revokeGatewayKeyHandler,
} from './routes/gateway';
import { gatewayMarketProxyHandler, gatewayRegistryProxyHandler } from './routes/gatewayProxy';
import { registerLibraryUi } from './routes/libraryUi';

// Captured once at module load (= process start for all practical purposes)
// specifically so /health can answer "is this actually the process I think
// it is" without needing OS-level PID/creation-time forensics. Found the
// hard way during a platform audit: a `tsx watch` dev server (on a sibling
// service) had silently stopped picking up file-change reloads at some
// point during a multi-day uptime, serving stale code for hours with no
// visible symptom -- every request still succeeded normally, just against
// the wrong build. The existing /health `ts` field doesn't help here -- it's
// evaluated fresh on every request, so a stale process reports it looking
// perfectly current regardless. A quick curl comparing this against "when
// did I last edit this service" would catch that immediately.
const PROCESS_STARTED_AT = new Date().toISOString();

// Request body sizes. The default is spelled out (instead of relying on Fastify's) and the small routes, whose real
// bodies are a few hundred bytes, get a far lower ceiling so they cannot be used to make the server buffer megabytes.
const BODY_LIMIT_DEFAULT = 1_048_576; // 1 MiB: drafts (up to 256 KB) and forwarded research requests
const BODY_LIMIT_SMALL = 16_384; // 16 KiB: sign-in, sign-up, resets, invites, key creation
const small = { bodyLimit: BODY_LIMIT_SMALL };
// The setup wizard's helper routes (name checks, structure advice, compliance search, market analysis) call paid or
// rate-limited backends on the caller's behalf, so only a signed-in person may use them. API Library keys are not
// accepted here: they use /v1/gateway/* instead.
const signedIn = { preHandler: requireAuth };

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    // /setup/drafts/ and //health reach the same handler as /setup/drafts and
    // /health, instead of one being a 404 and another matching a :param route
    // with an empty value.
    ignoreTrailingSlash: true,
    ignoreDuplicateSlashes: true,
    bodyLimit: BODY_LIMIT_DEFAULT,
  });

  // Must come before any route is registered: it records them for 405 answers.
  registerNotFound(app);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // API answers (JSON, including errors) carry account data or a one-time key,
  // so nothing between here and the client may store them. Static pages set
  // their own Cache-Control and are not JSON.
  app.addHook('onSend', async (_request, reply, payload) => {
    if (!reply.hasHeader('cache-control') && String(reply.getHeader('content-type') ?? '').includes('json')) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
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
    // No x-api-key on purpose: API Library keys are for servers. A key placed in
    // browser JavaScript is visible to every visitor of that page.
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Session-Transport'],
    credentials: true,
    // Browsers may reuse a preflight answer instead of asking before every call.
    maxAge: 600,
  });

  // Backs the httpOnly session cookie (see routes/auth.ts) that web_app uses
  // instead of storing the bearer token in localStorage, where any script
  // on the page could read it. No secret/signing needed here -- the cookie
  // holds the same opaque, server-verified session token the Authorization
  // header always has, not something forgeable client-side.
  await app.register(cookie);

  // Baseline HTTP security headers (X-Frame-Options, X-Content-Type-Options,
  // Strict-Transport-Security, etc.) - previously set nowhere. Matters most
  // for /docs below: it's real, publicly-reachable HTML (now key-gated per
  // dsk-1, but defense in depth), and had no X-Frame-Options at all, meaning
  // it could be embedded in an iframe on any external site. Content-Security-
  // Policy is disabled: this API's HTML surfaces are /docs and the static API
  // Library pages, and /docs loads the Swagger UI bundle from unpkg.com by design - a default CSP
  // would block that. Every other route only ever returns JSON, where CSP
  // provides no protection anyway.
  await app.register(helmet, {
    // Every response starts with the strictest policy (nothing loads, nothing frames it). The few HTML responses
    // (library-ui pages, /docs) replace it with their own, see middleware/csp.ts.
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
    frameguard: { action: 'deny' },
  });

  // The API Library's own web pages (sign-in + key management), served from
  // this same origin. See routes/libraryUi.ts.
  registerLibraryUi(app);

  // OpenAPI spec + Swagger UI — optionally gated behind METRICS_DOCS_API_KEY
  // (see middleware/auth.ts's requireMetricsDocsKey, a no-op unless that env var
  // is set). Ops routes exist both plain and under /v1 so a client that always
  // uses the versioned base never has to special-case them.
  const docsHtml = (base: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Desk API — Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui.css" integrity="${SWAGGER_UI_CSS_SRI}" crossorigin="anonymous"/>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js" integrity="${SWAGGER_UI_JS_SRI}" crossorigin="anonymous"></script>
  <script>${docsInlineScript(base)}</script>
</body>
</html>`;

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

  for (const base of ['', '/v1']) {
    app.get(`${base}/docs/openapi.json`, { preHandler: requireMetricsDocsKey }, async (_req, reply) => reply.send(OPENAPI_SPEC));
    app.get(`${base}/docs`, { preHandler: requireMetricsDocsKey }, async (_req, reply) => {
      reply.header('Content-Type', 'text/html; charset=utf-8');
      applyHtmlCsp(reply, docsCsp(base));
      return reply.send(docsHtml(base));
    });
    app.get(`${base}/health/live`, async (_req, reply) => reply.status(200).send({ ok: true, service: 'desk-api', processStartedAt: PROCESS_STARTED_AT }));
    app.get(`${base}/health/ready`, async (_req, reply) => {
      const { ok, checks } = await getReadiness();
      // Backends are reported but never make the service "not ready" (see domain/health/dependencies.ts).
      const dependencies = await checkDependencies();
      return reply.status(ok ? 200 : 503).send({ ok, degraded: isDegraded(dependencies), checks, dependencies, processStartedAt: PROCESS_STARTED_AT });
    });
    // Back-compat alias for the original Hono version's GET /health (basic liveness,
    // no dependency checks) — kept cheap/dependency-free since nothing in the Flutter
    // client depends on it reflecting DB health specifically.
    app.get(`${base}/health`, async (_req, reply) => reply.send({ ok: true, service: 'desk-api', ts: new Date().toISOString(), processStartedAt: PROCESS_STARTED_AT }));
    app.get(`${base}/metrics`, { preHandler: requireMetricsDocsKey }, async (_req, reply) => {
      reply.header('Content-Type', metricsRegistry.contentType);
      return reply.send(await metricsRegistry.metrics());
    });
  }

  // Where a client that starts from /v1 finds everything else.
  app.get('/v1', async (_req, reply) =>
    reply.send({
      service: 'desk-api',
      version: 'v1',
      health: '/v1/health',
      libraryDocs: '/v1/gateway/openapi.json',
      apiLibrary: '/',
    }),
  );

  registerErrorHandler(app);
  registerOriginCheck(app);
  registerApiProtection(app);
  registerRouteLimits(app);
  registerIdempotency(app);

  app.addHook('onRequest', async (request) => {
    (request as { _startTime?: number })._startTime = Date.now();
  });
  app.addHook('onResponse', async (request, reply) => {
    const start = (request as { _startTime?: number })._startTime;
    const route = routeLabel(request);
    const method = methodLabel(request.method);
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
  instance.post('/auth/signup', small, signUpHandler);
  instance.post('/auth/signin', small, signInHandler);
  instance.post('/auth/signout', signOutHandler);
  instance.get('/auth/sessions', listSessionsHandler);
  instance.delete('/auth/sessions/:id', revokeSessionHandler);
  instance.post('/auth/signout-all', small, signOutEverywhereHandler);
  instance.get('/auth/session', sessionHandler);
  instance.post('/auth/email-confirmation/request', small, requestEmailConfirmationHandler);
  instance.post('/auth/email-confirmation/confirm', small, confirmEmailHandler);
  instance.post('/auth/password-reset/request', small, requestPasswordResetHandler);
  instance.post('/auth/password-reset/confirm', small, confirmPasswordResetHandler);
  instance.post('/auth/password', small, updatePasswordHandler);

  // ── Business setup ───────────────────────────────────────────────────────
  instance.get('/setup/drafts', listDraftsHandler);
  instance.get('/setup/drafts/:id', getDraftHandler);
  instance.post('/setup/drafts', createDraftHandler);
  instance.patch('/setup/drafts/:id', patchDraftHandler);
  instance.delete('/setup/drafts/:id', deleteDraftHandler);
  instance.post('/setup/drafts/:id/complete', completeDraftHandler);
  instance.get('/setup/businesses', listBusinessesHandler);
  instance.get('/setup/businesses/:id/members', listBusinessMembersHandler);
  instance.post('/setup/businesses/:id/members', small, inviteBusinessMemberHandler);
  instance.delete('/setup/businesses/:id/members/:membershipId', removeBusinessMemberHandler);
  instance.get('/setup/invites', listPendingInvitesHandler);
  instance.post('/setup/invites/:membershipId/accept', acceptBusinessInviteHandler);
  instance.delete('/setup/invites/:membershipId', declineBusinessInviteHandler);

  // ── Admin table browser (+ upstream aggregation) ────────────────────────
  instance.get('/admin/tables', adminTablesHandler);
  instance.get('/admin/tables/:table/rows', adminTableRowsHandler);
  instance.patch('/admin/tables/:table/rows/:id', adminTableUpdateRowHandler);
  instance.delete('/admin/tables/:table/rows/:id', adminTableDeleteRowHandler);

  // ── Edge Function replacements ───────────────────────────────────────────
  instance.post('/functions/v1/analyze-business-setup', signedIn, analyzeBusinessSetupHandler);
  instance.post('/functions/v1/search-place-areas', signedIn, searchPlaceAreasHandler);

  // ── Registry API proxy (mounted at /functions/v1, mirroring registry-api paths) ──
  instance.post('/functions/v1/check-business-name-availability', signedIn, checkBusinessNameAvailabilityHandler);
  instance.post('/functions/v1/check-dba-name-availability', signedIn, checkDbaNameAvailabilityHandler);
  instance.post('/functions/v1/check-trademark-availability', signedIn, checkTrademarkAvailabilityHandler);
  instance.post('/functions/v1/check-name-multi-state', signedIn, checkNameMultiStateHandler);
  instance.post('/functions/v1/check-names-batch', signedIn, checkNamesBatchHandler);
  instance.get('/functions/v1/registry-sync-status', signedIn, registrySyncStatusHandler);
  instance.get('/functions/v1/business-structures', signedIn, businessStructuresHandler);
  instance.get('/functions/v1/business-structures/:slug', signedIn, businessStructureBySlugHandler);
  instance.post('/functions/v1/business-structures/recommend', signedIn, recommendBusinessStructuresHandler);

  // ── Compliance-OS integration proxy (app.deskbusiness.co) ────────────────
  instance.get('/integrations/compliance/business-types', signedIn, businessTypesHandler);
  instance.get('/integrations/compliance/requirements/search', signedIn, requirementsSearchHandler);
  instance.get('/integrations/compliance/jurisdictions', signedIn, jurisdictionsHandler);
  instance.post('/integrations/market-research/analyze', signedIn, marketResearchAnalyzeHandler);

  // ── API Library: developer key management (session-only) ─────────────────
  instance.get('/gateway/openapi.json', libraryOpenApiHandler);
  instance.get('/gateway/services', listGatewayServicesHandler);
  instance.get('/gateway/api-keys', listGatewayKeysHandler);
  instance.post('/gateway/api-keys', small, createGatewayKeyHandler);
  instance.delete('/gateway/api-keys/:id', revokeGatewayKeyHandler);

  // ── API Library: key-authenticated proxies to registry-api / market-validation-api ──
  instance.get('/gateway/registry/*', gatewayRegistryProxyHandler);
  instance.post('/gateway/registry/*', gatewayRegistryProxyHandler);
  instance.get('/gateway/market/*', gatewayMarketProxyHandler);
  instance.post('/gateway/market/*', gatewayMarketProxyHandler);
}
