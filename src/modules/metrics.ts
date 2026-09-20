import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry, prefix: 'desk_node_' });

export const httpRequestsTotal = new Counter({
  name: 'desk_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [metricsRegistry],
});

export const httpRequestDurationMs = new Histogram({
  name: 'desk_http_request_duration_ms',
  help: 'HTTP request duration in milliseconds',
  labelNames: ['method', 'route'] as const,
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
  registers: [metricsRegistry],
});

export const authEventsTotal = new Counter({
  name: 'desk_auth_events_total',
  help: 'Auth events (signup/signin/signout/etc.), by event and outcome',
  labelNames: ['event', 'outcome'] as const,
  registers: [metricsRegistry],
});

export const cronTicksTotal = new Counter({
  name: 'desk_cron_ticks_total',
  help: 'Background cron ticks (session/token cleanup), by outcome',
  labelNames: ['job', 'outcome'] as const,
  registers: [metricsRegistry],
});

export const gatewayKeyDrift = new Gauge({
  name: 'desk_gateway_key_drift',
  help: 'Backend keys out of step with what desk-api holds (as of the last hourly check), by kind',
  labelNames: ['kind'] as const,
  registers: [metricsRegistry],
});

export const backendKeySweepTotal = new Counter({
  name: 'desk_backend_key_sweep_total',
  help: 'Backend keys revoked (or failed to revoke) by the background sweeper',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/**
 * The `route` label of the request metrics: the route's PATTERN ("/setup/drafts/:id", "/gateway/registry/*"), never
 * the URL that was called. Using the URL made one time series per draft id, per scanner probe and per random string
 * anyone sent, growing the metrics (and this process's memory) without limit. The /v1 prefix is dropped so both
 * spellings of a route share a series; anything that matched no route is one series, "unmatched".
 */
export function routeLabel(request: { routeOptions?: { url?: string }; is404?: boolean }): string {
  if (request.is404) return 'unmatched';
  const pattern = request.routeOptions?.url;
  if (!pattern || pattern === '*') return 'unmatched';
  if (pattern === '/v1') return '/';
  return pattern.startsWith('/v1/') ? pattern.slice(3) : pattern;
}

/** The `method` label: a fixed set, so a made-up verb cannot create new series. */
export function methodLabel(method: string): string {
  return KNOWN_METHODS.has(method) ? method : 'OTHER';
}
