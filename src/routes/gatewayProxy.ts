// API Library proxy: /gateway/registry/* and /gateway/market/* (also served
// under /v1). A caller presents an API Library key as `x-api-key`; if that
// key has the matching grant, the request is forwarded server-to-server to
// the real backend using that grant's OWN brokered backend key, and the
// response is returned. The developer's key is never forwarded, and the
// backend key never leaves this process.
//
// Only an explicit allowlist of upstream endpoints is reachable — the same
// endpoints each backend gates behind its own API key. The wildcard is never
// concatenated into an upstream path: it's matched against the allowlist and,
// for the one parameterised endpoint, a strict slug pattern, so traversal
// (`..`, encoded slashes) can't reach /admin or anything else.
import { emitWebhookEvent } from '../domain/webhooks/webhooks';
import { meterAnalysis } from '../domain/billing/plans';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { hit, type Limit } from '../middleware/route-limits';
import { HttpError, problemBody } from '../middleware/http-error';
import { config } from '../config';
import { gatewayApiKeys, looksLikeGatewayKey } from '../domain/gateway/keys';
import { bindAuthToLog, expiredKeyError } from '../middleware/auth';
import { getClientIp } from '../middleware/api-protection';
import type { BrokeredService } from '../domain/gateway/services';
import { sandboxAnswer, SANDBOX_HEADER } from '../domain/gateway/sandbox';
import { abortWhenClientLeaves, callUpstream } from '../domain/upstream/client';
import { MARKET_POLICY, REGISTRY_POLICY } from '../domain/upstream/policies';
import { trimTrailingSlashes } from '../utils/strings';

interface UpstreamRoute {
  method: 'GET' | 'POST';
  /** Exact upstream path, or a matcher returning the upstream path to call. */
  match: (path: string) => string | null;
  forwardQuery?: boolean;
  /** A lookup that can safely be sent twice, so one quick retry is allowed on a network error / 502 / 503 / 504. */
  idempotent?: boolean;
  /** This spelling still works but is superseded: the public path to use instead (answered with Deprecation + Link headers). */
  deprecatedFor?: string;
  /** Reference data that changes rarely: the answer is kept this many seconds (keyed by path and query; only 200s). */
  cacheSeconds?: number;
}

/** Reference lookups (business structures, the scoring methodology) change a few times a year. */
const REFERENCE_CACHE_SECONDS = 600;
// Off in the test suite (which calls the same lookups again and again expecting fresh answers) unless a test turns it on.
const referenceCacheEnabled = () => process.env.NODE_ENV !== 'test' || process.env.REFERENCE_CACHE_IN_TESTS === '1';
const referenceCache = new Map<string, { at: number; contentType: string; text: string }>();
/** For tests. */
export function clearReferenceCache(): void {
  referenceCache.clear();
}

const exact = (p: string) => (path: string) => (path === p ? p : null);
/** A clean public name (`/name-availability`) that maps onto the backend's own path. */
const alias = (publicPath: string, upstreamPath: string) => (path: string) => (path === publicPath ? upstreamPath : null);
const SLUG = /^[a-z0-9][a-z0-9_-]{0,80}$/i;

// The public names are the ones to document and use. The backend's own
// `functions/v1/...` paths stay reachable, unchanged, for anyone already on them.
const REGISTRY_NAME_CHECKS: Array<[publicPath: string, upstreamPath: string]> = [
  ['/name-availability', '/functions/v1/check-business-name-availability'],
  ['/dba-availability', '/functions/v1/check-dba-name-availability'],
  ['/trademark-availability', '/functions/v1/check-trademark-availability'],
  ['/multi-state-availability', '/functions/v1/check-name-multi-state'],
  ['/batch-availability', '/functions/v1/check-names-batch'],
  ['/name-trend', '/functions/v1/check-name-trend'],
];

const REGISTRY_ROUTES: UpstreamRoute[] = [
  ...REGISTRY_NAME_CHECKS.flatMap(([publicPath, upstreamPath]): UpstreamRoute[] => [
    { method: 'POST', match: alias(publicPath, upstreamPath), idempotent: true },
    { method: 'POST', match: exact(upstreamPath), idempotent: true, deprecatedFor: publicPath },
  ]),
  { method: 'GET', match: alias('/sync-status', '/functions/v1/registry-sync-status'), idempotent: true },
  { method: 'GET', match: exact('/functions/v1/registry-sync-status'), idempotent: true, deprecatedFor: '/sync-status' },
  { method: 'GET', match: exact('/business-structures'), forwardQuery: true, idempotent: true, cacheSeconds: REFERENCE_CACHE_SECONDS },
  { method: 'POST', match: exact('/business-structures/recommend'), idempotent: true },
  {
    method: 'GET',
    idempotent: true,
    cacheSeconds: REFERENCE_CACHE_SECONDS,
    match: (path) => {
      const m = /^\/business-structures\/([^/]+)$/.exec(path);
      return m && SLUG.test(m[1]) && m[1] !== 'recommend' ? `/business-structures/${m[1]}` : null;
    },
  },
];

const MARKET_ROUTES: UpstreamRoute[] = [
  { method: 'POST', match: exact('/research/analyze') },
  { method: 'GET', match: exact('/scoring-methodology'), idempotent: true, cacheSeconds: REFERENCE_CACHE_SECONDS },
];

const SERVICES: Record<
  BrokeredService,
  { baseUrl: () => string | undefined; routes: UpstreamRoute[]; policy: typeof REGISTRY_POLICY }
> = {
  registry_api: { baseUrl: () => config.registryApiUrl, routes: REGISTRY_ROUTES, policy: REGISTRY_POLICY },
  market_validation_api: { baseUrl: () => config.marketApiUrl, routes: MARKET_ROUTES, policy: MARKET_POLICY },
};

const PASSTHROUGH_HEADERS = ['content-type', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];

const MARKET_ANALYSIS_DAILY: Limit = { name: 'market-analysis-key-day', max: Number(process.env.MARKET_ANALYSES_PER_KEY_PER_DAY) || 200, windowMs: 24 * 60 * 60 * 1000, what: 'market analyses' };

// A team's analyses are counted together (twice a single key's number, since several people use them).
const MARKET_ANALYSIS_TEAM_DAILY: Limit = { ...MARKET_ANALYSIS_DAILY, name: 'market-analysis-team-day', max: MARKET_ANALYSIS_DAILY.max * 2 };

async function forward(service: BrokeredService, request: FastifyRequest, reply: FastifyReply) {
  const presented = request.headers['x-api-key'];
  if (!looksLikeGatewayKey(presented)) throw new HttpError(401, 'An API key is required (x-api-key header).', 'api_key_required');
  const verified = await gatewayApiKeys.verify(presented);
  if (!verified) throw new HttpError(401, 'Invalid or revoked API key.', 'invalid_api_key');
  if (verified.timeProblem) throw expiredKeyError(verified.timeProblem);
  if (verified.suspended) throw new HttpError(403, 'This API key is suspended.', 'api_key_suspended');
  if (verified.allowedIps && verified.allowedIps.length > 0 && !verified.allowedIps.includes(getClientIp(request))) {
    throw new HttpError(403, 'This API key is not accepted from this address.', 'api_key_ip_not_allowed');
  }
  request.gatewayKey = verified;
  bindAuthToLog(request, reply, { auth: 'key', keyId: verified.id, userId: verified.ownerUserId, service });
  if (!verified.services.has(service)) throw new HttpError(403, 'This API key is not enabled for this API.', 'api_key_service_not_enabled');

  const spec = SERVICES[service];
  const rest = '/' + ((request.params as { '*': string })['*'] ?? '');
  let upstreamPath: string | null = null;
  let route: UpstreamRoute | undefined;
  for (const candidate of spec.routes) {
    if (candidate.method !== request.method) continue;
    const resolved = candidate.match(rest);
    if (resolved) {
      upstreamPath = resolved;
      route = candidate;
      break;
    }
  }
  if (!upstreamPath || !route) throw new HttpError(404, 'Unknown endpoint for this API.', 'unknown_endpoint');

  if (route.deprecatedFor) {
    // RFC 9745 / RFC 8288: this spelling keeps working, and says what to use instead.
    const prefix = request.url.startsWith('/v1/') ? '/v1' : '';
    const successor = `${prefix}/gateway/${service === 'registry_api' ? 'registry' : 'market'}${route.deprecatedFor}`;
    reply.header('Deprecation', 'true');
    reply.header('Link', `<${successor}>; rel="successor-version"`);
  }

  // A sandbox key never leaves this server: it gets a fixed sample answer, and nothing is counted, capped or billed.
  if (verified.sandbox) {
    const publicPath = REGISTRY_NAME_CHECKS.find(([, up]) => up === upstreamPath)?.[0] ?? upstreamPath;
    const sample = sandboxAnswer(service, request.method, publicPath, request.body);
    if (!sample) throw new HttpError(404, 'The sandbox has no sample answer for this endpoint. Use a live key to call it.', 'sandbox_no_sample');
    reply.header(SANDBOX_HEADER, 'true');
    return reply.status(sample.status).send(sample.body);
  }

  // A market analysis costs real money upstream (outside data and AI): each key may make a limited number a day.
  if (service === 'market_validation_api' && route.method === 'POST' && upstreamPath === '/research/analyze') {
    const cap = verified.teamId ? MARKET_ANALYSIS_TEAM_DAILY : MARKET_ANALYSIS_DAILY;
    const wait = await hit(cap, verified.teamId ?? verified.id);
    if (wait > 0) {
      reply.header('Retry-After', String(wait));
      emitWebhookEvent({ userId: verified.ownerUserId, teamId: verified.teamId ?? undefined }, 'usage.cap_reached', { keyId: verified.id, cap: cap.max, what: 'market analyses per day' });
      throw new HttpError(429, `${verified.teamId ? 'This team has' : 'This key has'} used its ${cap.max} market analyses for today. Try again in ${Math.ceil(wait / 3600)} hours, or ask for a higher limit.`, 'market_analysis_daily_cap');
    }
  }

  const cacheKey = route.cacheSeconds && referenceCacheEnabled() ? `${service}:${upstreamPath}${route.forwardQuery && request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''}` : null;
  if (cacheKey) {
    const cached = referenceCache.get(cacheKey);
    if (cached && Date.now() - cached.at < (route.cacheSeconds ?? 0) * 1000) {
      reply.header('X-Cache', 'HIT').header('Age', String(Math.floor((Date.now() - cached.at) / 1000)));
      return reply.status(200).header('Content-Type', cached.contentType).send(cached.text);
    }
  }

  const baseUrl = spec.baseUrl();
  const backendKey = await gatewayApiKeys.getBackendKey(verified.id, service);
  if (!baseUrl || !backendKey) throw new HttpError(503, 'This API is temporarily unavailable for this key.', 'api_unavailable');

  const queryIndex = request.url.indexOf('?');
  const query = route.forwardQuery && queryIndex >= 0 ? request.url.slice(queryIndex) : '';
  // Timeout, one retry for lookups, circuit breaker, in-flight limits (per API key too) and an answer-size ceiling
  // all live in the shared upstream client. A refusal from it is an HttpError like any other.
  const upstream = await callUpstream(
    `${trimTrailingSlashes(baseUrl)}${upstreamPath}${query}`,
    {
      method: route.method,
      headers: {
        'x-api-key': backendKey,
        // One id follows the call through desk-api and into the backend's own logs.
        'x-request-id': request.id,
        ...(route.method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      body: route.method === 'POST' ? JSON.stringify(request.body ?? {}) : undefined,
      signal: abortWhenClientLeaves(reply),
    },
    { ...spec.policy, retryable: route.idempotent === true },
    verified.id,
  );

  // Every successful market analysis is counted exactly for billing: against the team when the key is a team's.
  if (service === 'market_validation_api' && route.method === 'POST' && upstreamPath === '/research/analyze' && upstream.status < 400) {
    meterAnalysis(verified.teamId ? 'team' : 'user', verified.teamId ?? verified.ownerUserId);
  }

  // A 401/403 from upstream means OUR brokered credential was refused — not
  // the developer's mistake — so it must not look like their key failing.
  if (upstream.status === 401 || upstream.status === 403) {
    request.log.error({ service, keyId: verified.id, status: upstream.status }, 'gateway upstream rejected brokered key');
    throw new HttpError(502, `The upstream API rejected this request. Please report it: ${config.supportUrl}`, 'upstream_rejected');
  }
  for (const name of PASSTHROUGH_HEADERS) {
    if (name.startsWith('x-ratelimit-')) continue; // merged below
    const value = upstream.headers.get(name);
    if (value) reply.header(name, value);
  }
  mergeRateLimitHeaders(reply, upstream.headers);
  const text = upstream.text;
  if (upstream.status >= 200 && upstream.status < 300) {
    if (cacheKey && upstream.status === 200) {
      if (referenceCache.size > 500) referenceCache.clear();
      referenceCache.set(cacheKey, { at: Date.now(), contentType: upstream.headers.get('content-type') ?? 'application/json', text });
      reply.header('X-Cache', 'MISS');
    }
    return reply.status(upstream.status).send(text);
  }

  // A failed call gets the same error body as any other desk-api error, whatever
  // shape the backend used (`{error}`, `{message}`, a validation list...).
  let detail = 'The request failed.';
  let errors: unknown;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const message = parsed.error ?? parsed.detail ?? parsed.message;
    if (typeof message === 'string' && message) detail = message;
    if (parsed.errors !== undefined) errors = parsed.errors;
  } catch {
    /* not JSON — keep the status text */
  }
  return reply
    .status(upstream.status)
    .header('Content-Type', 'application/problem+json')
    .send(problemBody(request.url, upstream.status, upstream.status === 500 ? 'The upstream API failed.' : detail, errors !== undefined ? { errors } : undefined));
}

/**
 * Two limits apply to a proxied call: ours (per key) and the backend's (per backend key). The answer reports the one
 * that is closer to running out, so the numbers are the same kind of number on every route ("what you have left").
 */
export function mergeRateLimitHeaders(reply: FastifyReply, upstream: { get(name: string): string | null }): void {
  const ours = { limit: Number(reply.getHeader('x-ratelimit-limit')), remaining: Number(reply.getHeader('x-ratelimit-remaining')), reset: reply.getHeader('x-ratelimit-reset') };
  const theirs = { limit: Number(upstream.get('x-ratelimit-limit')), remaining: Number(upstream.get('x-ratelimit-remaining')), reset: upstream.get('x-ratelimit-reset') };
  const usable = (l: { limit: number; remaining: number }) => Number.isFinite(l.limit) && Number.isFinite(l.remaining);
  if (!usable(theirs)) return; // the backend said nothing: ours stays
  if (!usable(ours) || theirs.remaining < ours.remaining) {
    reply.header('X-RateLimit-Limit', String(theirs.limit)).header('X-RateLimit-Remaining', String(theirs.remaining));
    if (theirs.reset) reply.header('X-RateLimit-Reset', theirs.reset);
  }
}

export async function gatewayRegistryProxyHandler(request: FastifyRequest, reply: FastifyReply) {
  return forward('registry_api', request, reply);
}

export async function gatewayMarketProxyHandler(request: FastifyRequest, reply: FastifyReply) {
  return forward('market_validation_api', request, reply);
}
