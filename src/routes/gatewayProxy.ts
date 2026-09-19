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
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../middleware/http-error';
import { config } from '../config';
import { gatewayApiKeys, looksLikeGatewayKey } from '../domain/gateway/keys';
import type { BrokeredService } from '../domain/gateway/services';

interface UpstreamRoute {
  method: 'GET' | 'POST';
  /** Exact upstream path, or a matcher returning the upstream path to call. */
  match: (path: string) => string | null;
  forwardQuery?: boolean;
}

const exact = (p: string) => (path: string) => (path === p ? p : null);
const SLUG = /^[a-z0-9][a-z0-9_-]{0,80}$/i;

const REGISTRY_ROUTES: UpstreamRoute[] = [
  ...[
    '/functions/v1/check-business-name-availability',
    '/functions/v1/check-dba-name-availability',
    '/functions/v1/check-trademark-availability',
    '/functions/v1/check-name-multi-state',
    '/functions/v1/check-names-batch',
    '/functions/v1/check-name-trend',
  ].map((p): UpstreamRoute => ({ method: 'POST', match: exact(p) })),
  { method: 'GET', match: exact('/functions/v1/registry-sync-status') },
  { method: 'GET', match: exact('/business-structures'), forwardQuery: true },
  { method: 'POST', match: exact('/business-structures/recommend') },
  {
    method: 'GET',
    match: (path) => {
      const m = /^\/business-structures\/([^/]+)$/.exec(path);
      return m && SLUG.test(m[1]) && m[1] !== 'recommend' ? `/business-structures/${m[1]}` : null;
    },
  },
];

const MARKET_ROUTES: UpstreamRoute[] = [
  { method: 'POST', match: exact('/research/analyze') },
  { method: 'GET', match: exact('/scoring-methodology') },
];

const SERVICES: Record<
  BrokeredService,
  { baseUrl: () => string | undefined; routes: UpstreamRoute[]; timeoutMs: number }
> = {
  registry_api: { baseUrl: () => config.registryApiUrl, routes: REGISTRY_ROUTES, timeoutMs: 30_000 },
  market_validation_api: { baseUrl: () => config.marketApiUrl, routes: MARKET_ROUTES, timeoutMs: 80_000 },
};

const PASSTHROUGH_HEADERS = ['content-type', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];

async function forward(service: BrokeredService, request: FastifyRequest, reply: FastifyReply) {
  const presented = request.headers['x-api-key'];
  if (!looksLikeGatewayKey(presented)) throw new HttpError(401, 'An API key is required (x-api-key header).');
  const verified = await gatewayApiKeys.verify(presented);
  if (!verified) throw new HttpError(401, 'Invalid or revoked API key.');
  if (!verified.services.has(service)) throw new HttpError(403, 'This API key is not enabled for this API.');

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
  if (!upstreamPath || !route) throw new HttpError(404, 'Unknown endpoint for this API.');

  const baseUrl = spec.baseUrl();
  const backendKey = await gatewayApiKeys.getBackendKey(verified.id, service);
  if (!baseUrl || !backendKey) throw new HttpError(503, 'This API is temporarily unavailable for this key.');

  const queryIndex = request.url.indexOf('?');
  const query = route.forwardQuery && queryIndex >= 0 ? request.url.slice(queryIndex) : '';
  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl.replace(/\/+$/, '')}${upstreamPath}${query}`, {
      method: route.method,
      headers: {
        'x-api-key': backendKey,
        ...(route.method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      body: route.method === 'POST' ? JSON.stringify(request.body ?? {}) : undefined,
      signal: AbortSignal.timeout(spec.timeoutMs),
    });
  } catch {
    throw new HttpError(502, 'The upstream API could not be reached.');
  }

  // A 401/403 from upstream means OUR brokered credential was refused — not
  // the developer's mistake — so it must not look like their key failing.
  if (upstream.status === 401 || upstream.status === 403) {
    request.log.error({ service, keyId: verified.id, status: upstream.status }, 'gateway upstream rejected brokered key');
    throw new HttpError(502, 'The upstream API rejected this request. Please contact support.');
  }
  for (const name of PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) reply.header(name, value);
  }
  return reply.status(upstream.status).send(await upstream.text());
}

export async function gatewayRegistryProxyHandler(request: FastifyRequest, reply: FastifyReply) {
  return forward('registry_api', request, reply);
}

export async function gatewayMarketProxyHandler(request: FastifyRequest, reply: FastifyReply) {
  return forward('market_validation_api', request, reply);
}
