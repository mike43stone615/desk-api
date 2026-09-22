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
import { HttpError, errorTypeUrl, registerErrorHandler } from './middleware/http-error';
import { registerNotFound } from './middleware/not-found';
import { registerOriginCheck } from './middleware/origin-check';
import { registerApiProtection } from './middleware/api-protection';
import { requireAuth } from './middleware/auth';
import { registerRouteLimits } from './middleware/route-limits';
import { checkDependencies, isDegraded } from './domain/health/dependencies';
import { pendingMigrations } from './domain/health/migrations';
import { loggerOptions } from './middleware/log-redaction';
import { applyHtmlCsp, docsCsp, docsInlineScript, SWAGGER_UI_CSS_SRI, SWAGGER_UI_JS_SRI, SWAGGER_UI_VERSION } from './middleware/csp';
import { registerIdempotency } from './middleware/idempotency';
import { requireMetricsDocsKey } from './middleware/auth';
import { OPENAPI_SPEC } from './openapi';
import { metricsRegistry, httpRequestsTotal, httpRequestDurationMs, routeLabel, methodLabel } from './modules/metrics';

import {
  signUpHandler,
  signInHandler,
  twoFactorVerifyHandler,
  twoFactorSetupHandler,
  twoFactorEnableHandler,
  twoFactorDisableHandler,
  twoFactorBackupCodesHandler,
  twoFactorStatusHandler,
  signOutHandler,
  listSessionsHandler,
  activityHandler,
  revokeSessionHandler,
  signOutEverywhereHandler,
  sessionHandler,
  requestEmailConfirmationHandler,
  confirmEmailHandler,
  requestPasswordResetHandler,
  confirmPasswordResetHandler,
  updatePasswordHandler,
  deleteAccountHandler,
  exportAccountHandler,
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
  keyUsageHandler,
  resumeGatewayKeyHandler,
  suspendGatewayKeyHandler, addKeyServiceHandler, removeKeyServiceHandler, setKeyRestrictionsHandler,
  listGatewayKeysHandler,
  listGatewayServicesHandler,
  revokeGatewayKeyHandler,
} from './routes/gateway';
import { createWebhookHandler, deleteWebhookHandler, listWebhookEventsHandler, listWebhooksHandler, rotateWebhookSecretHandler, testWebhookHandler, webhookDeliveriesHandler, retryWebhookDeliveryHandler } from './routes/webhooksOut';
import { authorizeDecisionHandler, authorizeHandler, authorizeInfoHandler, createClientHandler, deleteClientHandler, discoveryHandler, listAuthorizationsHandler, listClientsHandler, registerOAuthTokenRoutes, revokeAuthorizationHandler } from './routes/oauth';
import { graphqlHandler } from './routes/graphql';
import { changelogAtomHandler, changelogHandler, incidentsHandler, openIncidentHandler, updateIncidentHandler } from './routes/statusInfo';
import { subscribe as subscribeToStatus, confirm as confirmStatusSubscription, unsubscribe as unsubscribeFromStatus } from './domain/status/subscribers';
import { sendStatusSubscribeConfirmEmail } from './infrastructure/email/resend';
import { listIncidents } from './domain/status/incidents';
import { invoicesHandler, listPlansHandler, subscriptionHandler } from './routes/billing';
import { adminAccessAddHandler, adminAccessListHandler, adminAccessRemoveHandler, adminMeHandler } from './routes/adminAccess';
import {
  acceptTeamInviteHandler,
  changeTeamRoleHandler,
  createTeamHandler,
  declineTeamInviteHandler,
  deleteTeamHandler,
  getTeamHandler,
  inviteTeamMemberHandler,
  listTeamInvitesHandler,
  listTeamsHandler,
  removeTeamMemberHandler,
  withdrawTeamEmailInviteHandler,
} from './routes/teams';
import { gatewayMarketProxyHandler, gatewayRegistryProxyHandler } from './routes/gatewayProxy';
import { registerLibraryUi } from './routes/libraryUi';
import { adminReconcileReportHandler, adminReconcileRunHandler, adminListKeysHandler, adminResumeKeyHandler, adminSuspendKeyHandler, adminSetKeyLimitHandler, adminSetTeamLimitHandler, adminAssignPlanHandler, adminGenerateInvoicesHandler, adminInvoiceStatusHandler, adminSuspendUserHandler, adminUnsuspendUserHandler } from './routes/adminAccounts';
import { registerSecurityTxt } from './routes/securityTxt';
import { registerWebhooks } from './routes/webhooks';
import { buildStatus, statusHtml } from './domain/health/status';
import { ERROR_CODES } from './middleware/error-codes';
import { registerPathParamCheck } from './middleware/path-params';
import { recordKeyUsage } from './domain/gateway/usage';
import { routeKey } from './middleware/route-limits';
import { sendWithEtag } from './middleware/etag';

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

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/;
/** The caller x-request-id if it is safe to log and echo back, else undefined. */
export function acceptableRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : undefined;
}

// Request body sizes. The default is spelled out (instead of relying on Fastify's) and the small routes, whose real
// bodies are a few hundred bytes, get a far lower ceiling so they cannot be used to make the server buffer megabytes.
const BODY_LIMIT_DEFAULT = 1_048_576; // 1 MiB: drafts (up to 256 KB) and forwarded research requests
const BODY_LIMIT_SMALL = 16_384; // 16 KiB: sign-in, sign-up, resets, invites, key creation
const small = { bodyLimit: BODY_LIMIT_SMALL };
// The setup wizard's helper routes (name checks, structure advice, compliance search, market analysis) call paid or
// rate-limited backends on the caller's behalf, so only a signed-in person may use them. API Library keys are not
// accepted here: they use /v1/gateway/* instead.
const signedIn = { preHandler: requireAuth };

function containsNul(value: unknown, depth: number): boolean {
  if (typeof value === 'string') return value.includes(' ');
  if (depth > 64 || value === null || typeof value !== 'object') return false;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.includes(' ') || containsNul(v, depth + 1)) return true;
  }
  return false;
}

export async function buildApp(options: { logStream?: { write: (line: string) => void } } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logStream ? { ...loggerOptions(config.logLevel), stream: options.logStream } : loggerOptions(config.logLevel),
    // A caller may supply its own request id (to follow a call through the logs), but only if it is short and plain:
    // anything else (huge, containing newlines or control characters, log-injection attempts) is replaced by a fresh id.
    requestIdHeader: false,
    genReqId: (req) => acceptableRequestId(req.headers['x-request-id']) ?? randomUUID(),
    // /setup/drafts/ and //health reach the same handler as /setup/drafts and
    // /health, instead of one being a 404 and another matching a :param route
    // with an empty value.
    ignoreTrailingSlash: true,
    ignoreDuplicateSlashes: true,
    bodyLimit: BODY_LIMIT_DEFAULT,
    // Slow or stalled clients (see docs/TIMEOUTS.md): the whole header block must arrive in 10 s and the whole request
    // in 30 s, so a client that trickles bytes cannot hold a connection (Cloudflare shields the origin, but the origin
    // must not depend on that). A kept-alive connection is closed after 65 s idle. Answers have their own budget in
    // the upstream policies (src/domain/upstream/policies.ts).
    connectionTimeout: 0,
    keepAliveTimeout: 65_000,
    requestTimeout: 30_000,
    // Node only looks for expired header/request timeouts every 30 s by default, which would make a 10 s limit
    // really 10 to 40 s. Look every 2 s.
    http: { connectionsCheckingInterval: 2_000 },
  });
  // Node's header timeout is not a Fastify option; it must stay below the request timeout.
  app.server.headersTimeout = 10_000;

  // Must come before any route is registered: it records them for 405 answers.
  registerNotFound(app);

  // Which region answered; and in a read-only standby every change is refused (GraphQL is a POST but only reads).
  const READ_ONLY_ALLOWED = /^\/(v1\/)?graphql(\?|$)/;
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-region', config.region);
    if (config.readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !READ_ONLY_ALLOWED.test(request.url)) {
      reply.header('Retry-After', '30');
      throw new HttpError(503, 'This copy of the service is read-only. Try again in a moment: the writing copy takes changes.', 'region_read_only');
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    // A body that announces itself as too big is answered 413 only after the rest of it has been read and thrown away.
    // Answering while the sender is still sending made Cloudflare report a 502 to the caller instead of the 413
    // (found live in September 2026 with a 3 MB draft). The reading stops at 8 MiB, where the connection is dropped.
    const declared = Number(request.headers['content-length']);
    const limit = request.routeOptions?.bodyLimit ?? BODY_LIMIT_DEFAULT;
    if (Number.isFinite(declared) && declared > limit) {
      await new Promise<void>((resolve) => {
        const raw = request.raw;
        let seen = 0;
        raw.on('data', (chunk: Buffer) => {
          seen += chunk.length;
          if (seen > 8_388_608) { raw.destroy(); resolve(); }
        });
        raw.once('end', resolve);
        raw.once('error', resolve);
        raw.once('close', resolve);
      });
      throw new HttpError(413, 'The request body is too large.', 'payload_too_large');
    }
  });

  // A text value containing the NUL character (U+0000) cannot be stored by the database, and used to surface as a 500
  // (found live: an API key label "bad name"). It has no legitimate use in a name, label or draft, so it is a 400.
  app.addHook('preValidation', async (request) => {
    if (request.body && typeof request.body === 'object' && containsNul(request.body, 0)) {
      throw new HttpError(400, 'Text values cannot contain the NUL character (U+0000).', 'invalid_characters');
    }
  });

  // /v1 conventions. A successful DELETE answers 204 No Content with no body, instead of the legacy unprefixed
  // 200 {"ok":true} (which existing clients rely on and keep getting). See docs/API-VERSIONING.md.
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.method === 'DELETE' && request.url.startsWith('/v1/') && reply.statusCode === 200 && payload === '{"ok":true}') {
      reply.code(204);
      reply.removeHeader('content-type');
      reply.removeHeader('content-length');
      return '';
    }
    return payload;
  });

  // /v1 conventions, continued: a create answers 201 Created with a Location header that says where the new thing is.
  // (The legacy unprefixed paths keep answering 200 where they always did.)
  const V1_CREATES: Record<string, (payload: Record<string, unknown>, url: string) => string | null> = {
    'POST /setup/drafts': (p) => (typeof p.id === 'string' ? `/v1/setup/drafts/${p.id}` : null),
    'POST /setup/drafts/:id/complete': () => '/v1/setup/businesses',
    'POST /setup/businesses/:id/members': (_p, url) => url.split('?')[0],
    'POST /gateway/api-keys': () => '/v1/gateway/api-keys',
  };
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.method !== 'POST' || !request.url.startsWith('/v1/') || (reply.statusCode !== 200 && reply.statusCode !== 201) || typeof payload !== 'string') return payload;
    const build = V1_CREATES[routeKey(request) ?? ''];
    if (!build) return payload;
    try {
      const location = build(JSON.parse(payload) as Record<string, unknown>, request.url);
      if (location) reply.code(201).header('Location', location);
    } catch { /* not JSON: leave the answer alone */ }
    return payload;
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
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Session-Transport', 'If-Match', 'If-None-Match'],
    // What a browser page may READ from an answer (otherwise these are hidden from it): the request id an error report
    // should quote, when to retry, the version tag of a draft, and the rate-limit counters.
    exposedHeaders: ['X-Request-Id', 'Retry-After', 'ETag', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
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

  // Browser features no answer of this API needs are switched off.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  });

  // The API Library's own web pages (sign-in + key management), served from
  // this same origin. See routes/libraryUi.ts.
  registerLibraryUi(app);
  registerSecurityTxt(app);
  registerWebhooks(app);

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
    app.get(`${base}/docs/openapi.json`, { preHandler: requireMetricsDocsKey }, async (req, reply) => sendWithEtag(req, reply, OPENAPI_SPEC));
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
      // Migration files this version ships that the database has not had applied (the deploy refuses that, so it is
      // normally empty). Reported, and makes the service "degraded", never "not ready".
      const pending = checks.database === 'ok' ? await pendingMigrations().catch(() => []) : [];
      return reply.status(ok ? 200 : 503).send({
        ok,
        degraded: isDegraded(dependencies) || pending.length > 0,
        checks,
        dependencies,
        ...(pending.length > 0 ? { pendingMigrations: pending } : {}),
        processStartedAt: PROCESS_STARTED_AT,
      });
    });
    // Back-compat alias for the original Hono version's GET /health (basic liveness,
    // no dependency checks) — kept cheap/dependency-free since nothing in the Flutter
    // client depends on it reflecting DB health specifically.
    // Same members as the other two services' health answers (responseId, servedAt, ok), plus the older ones.
    app.get(`${base}/health`, async (req, reply) => {
      const now = new Date().toISOString();
      return reply.send({ ok: true, service: 'desk-api', region: config.region, readOnly: config.readOnly, responseId: req.id, servedAt: now, ts: now, processStartedAt: PROCESS_STARTED_AT });
    });
    // The public status page: operational, degraded or down for each part, for anyone (a person, a developer, a monitor).
    const statusView = async () => {
      const [{ checks }, dependencies] = await Promise.all([getReadiness(), checkDependencies()]);
      const incidents = await listIncidents().catch(() => ({ active: [], recent: [] }));
      return buildStatus(checks.database === 'ok' ? 'ok' : 'error', dependencies, config.supportUrl, new Date(), incidents);
    };
    app.get(`${base}/status`, async (req, reply) => {
      const view = await statusView();
      // The HTML page and the JSON share an address: a browser gets the page, a program (Accept: application/json) the data.
      if (base === '' && typeof req.headers.accept === 'string' && req.headers.accept.includes('text/html')) {
        reply.header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store');
        applyHtmlCsp(reply, "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
        const banner = (req.query as { banner?: string }).banner;
        const validBanner = banner === 'subscribed' || banner === 'confirmed' || banner === 'unsubscribed' || banner === 'subscribe_error' ? banner : undefined;
        return reply.status(view.status === 'down' ? 503 : 200).send(statusHtml(view, validBanner));
      }
      reply.header('Cache-Control', 'no-store');
      return reply.status(view.status === 'down' ? 503 : 200).send(view);
    });
    if (base === '') {
      // A plain HTML <form> posts application/x-www-form-urlencoded, which Fastify does not parse by default; scoped here
      // (like registerOAuthTokenRoutes) so nothing else in the API is affected.
      void app.register(async (scope) => {
        scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 2_048 }, (_req, body, done) => {
          try { done(null, Object.fromEntries(new URLSearchParams(body as string))); } catch (err) { done(err as Error); }
        });
        scope.post('/status/subscribe', { bodyLimit: 2_048 }, async (req, reply) => {
          const body = req.body as { email?: string } | undefined;
          const email = typeof body?.email === 'string' ? body.email.trim() : '';
          if (!email || email.length > 254 || !/.+@.+\..+/.test(email)) return reply.redirect('/status?banner=subscribe_error');
          const { confirmToken } = await subscribeToStatus(email);
          if (confirmToken) await sendStatusSubscribeConfirmEmail(config, email, confirmToken);
          return reply.redirect('/status?banner=subscribed');
        });
      });
      app.get('/status/subscribe/confirm', async (req, reply) => {
        const token = (req.query as { token?: string }).token;
        // The confirmation e-mail's link carries "<confirmToken>.<unsubscribeToken>" (see subscribers.subscribe) so the
        // route only needs one query param; only the part before the dot is the actual confirm token.
        const confirmToken = typeof token === 'string' ? token.split('.')[0] : undefined;
        const ok = typeof confirmToken === 'string' && confirmToken && (await confirmStatusSubscription(confirmToken));
        return reply.redirect(ok ? '/status?banner=confirmed' : '/status?banner=subscribe_error');
      });
      app.get('/status/subscribe/unsubscribe', async (req, reply) => {
        const token = (req.query as { token?: string }).token;
        if (typeof token === 'string' && token) await unsubscribeFromStatus(token);
        return reply.redirect('/status?banner=unsubscribed');
      });
    }
    app.get(`${base}/status/incidents`, incidentsHandler);
    app.get(`${base}/changelog`, changelogHandler);
    app.get(`${base}/changelog.atom`, changelogAtomHandler);
    // What each error code means. Public documentation: no data, and the `type` of every error answer links here.
    app.get(`${base}/errors`, async (_req, reply) => sendWithEtag(_req, reply, { errors: Object.entries(ERROR_CODES).map(([code, meaning]) => ({ code, meaning, type: errorTypeUrl(code) })) }));
    app.get(`${base}/errors/:code`, async (req, reply) => {
      const { code } = req.params as { code: string };
      const meaning = (ERROR_CODES as Record<string, string>)[code];
      if (!meaning) throw new HttpError(404, 'Unknown error code.', 'not_found');
      return sendWithEtag(req, reply, { code, meaning, type: errorTypeUrl(code) });
    });
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
      errors: '/v1/errors',
      versions: [{ version: 'v1', status: 'current', base: '/v1' }],
      // Unprefixed paths (/setup/drafts) still answer, and are the legacy spelling of the /v1 ones.
      legacyPaths: 'unprefixed paths answer the same as /v1 but are not covered by the versioning policy',
      policy: 'https://github.com/mike43stone615/desk-api/blob/main/docs/API-VERSIONING.md',
      apiLibrary: '/',
    }),
  );

  registerErrorHandler(app);
  registerPathParamCheck(app);
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
    // Calls made with an API Library key are counted per key and day (what the developer sees) and per API (metrics).
    if (request.gatewayKey) {
      const proxied = /\/gateway\/(registry|market)\//.exec(request.url);
      recordKeyUsage(request.gatewayKey.id, proxied ? (proxied[1] === 'registry' ? 'registry_api' : 'market_validation_api') : 'desk_api', reply.statusCode);
    }
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
  instance.post('/auth/2fa/verify', small, twoFactorVerifyHandler);
  instance.get('/auth/2fa', twoFactorStatusHandler);
  instance.post('/auth/2fa/setup', small, twoFactorSetupHandler);
  instance.post('/auth/2fa/enable', small, twoFactorEnableHandler);
  instance.post('/auth/2fa/disable', small, twoFactorDisableHandler);
  instance.post('/auth/2fa/backup-codes', small, twoFactorBackupCodesHandler);
  instance.post('/auth/signout', signOutHandler);
  instance.get('/auth/sessions', listSessionsHandler);
  instance.get('/auth/activity', activityHandler);
  instance.delete('/auth/sessions/:id', revokeSessionHandler);
  instance.post('/auth/signout-all', small, signOutEverywhereHandler);
  instance.get('/auth/session', sessionHandler);
  instance.post('/auth/email-confirmation/request', small, requestEmailConfirmationHandler);
  instance.post('/auth/email-confirmation/confirm', small, confirmEmailHandler);
  instance.post('/auth/password-reset/request', small, requestPasswordResetHandler);
  instance.post('/auth/password-reset/confirm', small, confirmPasswordResetHandler);
  instance.post('/auth/password', small, updatePasswordHandler);
  instance.post('/auth/account/delete', small, deleteAccountHandler);
  instance.get('/auth/account/export', exportAccountHandler);

  // ── Business setup ───────────────────────────────────────────────────────
  instance.get('/setup/drafts', listDraftsHandler);
  instance.get('/setup/drafts/:id', getDraftHandler);
  instance.post('/setup/drafts', createDraftHandler);
  instance.patch('/setup/drafts/:id', patchDraftHandler);
  instance.put('/setup/drafts/:id', patchDraftHandler); // the same whole-draft replace, under the verb that means it
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
  instance.get('/admin/gateway-keys', adminListKeysHandler);
  instance.get('/admin/gateway-keys/reconcile', adminReconcileReportHandler);
  instance.post('/admin/gateway-keys/reconcile', small, adminReconcileRunHandler);
  instance.post('/admin/users/:id/suspend', small, adminSuspendUserHandler);
  instance.post('/admin/users/:id/unsuspend', small, adminUnsuspendUserHandler);
  instance.post('/admin/gateway-keys/:id/limit', small, adminSetKeyLimitHandler);
  instance.post('/admin/teams/:id/limit', small, adminSetTeamLimitHandler);
  instance.post('/admin/incidents', small, openIncidentHandler);
  instance.post('/admin/incidents/:id/updates', small, updateIncidentHandler);
  instance.post('/admin/billing/:type/:id/plan', small, adminAssignPlanHandler);
  instance.post('/admin/billing/invoices/generate', small, adminGenerateInvoicesHandler);
  instance.post('/admin/billing/invoices/:id/status', small, adminInvoiceStatusHandler);
  instance.post('/admin/gateway-keys/:id/suspend', small, adminSuspendKeyHandler);
  instance.post('/admin/gateway-keys/:id/resume', small, adminResumeKeyHandler);
  instance.get('/admin/me', adminMeHandler);
  instance.get('/admin/access', adminAccessListHandler);
  instance.post('/admin/access', small, adminAccessAddHandler);
  instance.delete('/admin/access/:userId', small, adminAccessRemoveHandler);
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
  // ── GraphQL (read-only; sessions, keys with the Desk API and OAuth tokens) ──
  instance.post('/graphql', small, graphqlHandler);

  // ── OAuth 2.0 for third-party apps ─────────────────────────────────────────
  instance.get('/oauth/authorize', authorizeHandler);
  instance.get('/oauth/authorize/info', authorizeInfoHandler);
  instance.post('/oauth/authorize/decision', small, authorizeDecisionHandler);
  registerOAuthTokenRoutes(instance);
  instance.post('/oauth/clients', small, createClientHandler);
  instance.get('/oauth/clients', listClientsHandler);
  instance.delete('/oauth/clients/:id', deleteClientHandler);
  instance.get('/oauth/authorizations', listAuthorizationsHandler);
  instance.delete('/oauth/authorizations/:clientId', revokeAuthorizationHandler);
  instance.get('/.well-known/oauth-authorization-server', discoveryHandler);

  // ── Outbound webhooks (session-only) ──────────────────────────────────────
  instance.get('/gateway/webhook-events', listWebhookEventsHandler);
  instance.post('/gateway/webhooks', small, createWebhookHandler);
  instance.get('/gateway/webhooks', listWebhooksHandler);
  instance.delete('/gateway/webhooks/:id', deleteWebhookHandler);
  instance.post('/gateway/webhooks/:id/rotate-secret', small, rotateWebhookSecretHandler);
  instance.post('/gateway/webhooks/:id/test', small, testWebhookHandler);
  instance.get('/gateway/webhooks/:id/deliveries', webhookDeliveriesHandler);
  instance.post('/gateway/webhooks/:id/deliveries/:deliveryId/retry', small, retryWebhookDeliveryHandler);

  // ── Plans and billing ────────────────────────────────────────────────────
  instance.get('/billing/plans', listPlansHandler);
  instance.get('/billing/subscription', subscriptionHandler);
  instance.get('/billing/invoices', invoicesHandler);

  // ── Teams: people sharing keys and one allowance (session-only) ──────────
  instance.post('/teams', small, createTeamHandler);
  instance.get('/teams', listTeamsHandler);
  instance.delete('/teams/:id/email-invites/:inviteId', withdrawTeamEmailInviteHandler);
  instance.get('/teams/invites', listTeamInvitesHandler);
  instance.post('/teams/invites/:membershipId/accept', small, acceptTeamInviteHandler);
  instance.delete('/teams/invites/:membershipId', declineTeamInviteHandler);
  instance.get('/teams/:id', getTeamHandler);
  instance.delete('/teams/:id', deleteTeamHandler);
  instance.post('/teams/:id/members', small, inviteTeamMemberHandler);
  instance.patch('/teams/:id/members/:membershipId', small, changeTeamRoleHandler);
  instance.delete('/teams/:id/members/:membershipId', removeTeamMemberHandler);

  instance.get('/gateway/openapi.json', libraryOpenApiHandler);
  instance.get('/gateway/services', listGatewayServicesHandler);
  instance.get('/gateway/api-keys', listGatewayKeysHandler);
  instance.post('/gateway/api-keys', small, createGatewayKeyHandler);
  instance.delete('/gateway/api-keys/:id', revokeGatewayKeyHandler);
  instance.get('/gateway/api-keys/:id/usage', keyUsageHandler);
  instance.post('/gateway/api-keys/:id/services', small, addKeyServiceHandler);
  instance.delete('/gateway/api-keys/:id/services/:service', removeKeyServiceHandler);
  instance.patch('/gateway/api-keys/:id/restrictions', small, setKeyRestrictionsHandler);
  instance.post('/gateway/api-keys/:id/suspend', small, suspendGatewayKeyHandler);
  instance.post('/gateway/api-keys/:id/resume', small, resumeGatewayKeyHandler);

  // ── API Library: key-authenticated proxies to registry-api / market-validation-api ──
  instance.get('/gateway/registry/*', gatewayRegistryProxyHandler);
  instance.post('/gateway/registry/*', gatewayRegistryProxyHandler);
  instance.get('/gateway/market/*', gatewayMarketProxyHandler);
  instance.post('/gateway/market/*', gatewayMarketProxyHandler);
}
