import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

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

// Normalize URL patterns to avoid high-cardinality label explosion.
export function normalizeRoute(url: string): string {
  return url.split('?')[0];
}
