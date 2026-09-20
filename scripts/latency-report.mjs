// Per-route response-time percentiles from the running service's own /metrics (the request-time histogram is labelled by
// route PATTERN, so /setup/drafts/abc and /setup/drafts/xyz are one line):
//   node scripts/latency-report.mjs [--url http://localhost:3458] [--key <METRICS_DOCS_API_KEY>] [--min 5]
// Reads the key from the deployed settings when not given (never printed). Times are since the service last started.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const base = opt('--url', 'http://localhost:3458');
const min = Number(opt('--min', '5'));
let key = opt('--key', '');
if (!key) {
  try { key = (/^METRICS_DOCS_API_KEY\s*=\s*(.*)$/m.exec(readFileSync('C:/actions-runners/desk-api/_work/live/.env', 'utf8'))?.[1] ?? '').trim().replace(/^["']|["']$/g, ''); } catch { /* none */ }
}
const res = await fetch(`${base}/metrics`, { headers: { ...(key ? { 'x-api-key': key } : {}), 'cf-connecting-ip': '198.18.99.99' } });
if (!res.ok) { console.error(`/metrics answered ${res.status}`); process.exit(1); }
const lines = (await res.text()).split('\n');

/** route -> { count, sum, buckets: [[le, cumulativeCount]] } (merged over methods and statuses) */
const routes = new Map();
const re = /^desk_http_request_duration_ms_(bucket|sum|count)\{([^}]*)\}\s+([0-9.eE+-]+|Inf)/;
for (const line of lines) {
  const m = re.exec(line);
  if (!m) continue;
  const labels = Object.fromEntries([...m[2].matchAll(/(\w{1,40})="([^"]*)"/g)].map((x) => [x[1], x[2]]));
  const route = `${labels.method} ${labels.route}`;
  const r = routes.get(route) ?? { count: 0, sum: 0, buckets: new Map() };
  const v = Number(m[3]);
  if (m[1] === 'count') r.count += v;
  else if (m[1] === 'sum') r.sum += v;
  else r.buckets.set(labels.le, (r.buckets.get(labels.le) ?? 0) + v);
  routes.set(route, r);
}
function percentile(r, p) {
  const target = r.count * p;
  const sorted = [...r.buckets.entries()].map(([le, n]) => [le === '+Inf' ? Infinity : Number(le), n]).sort((a, b) => a[0] - b[0]);
  for (const [le, n] of sorted) if (n >= target) return le;
  return Infinity;
}
const rows = [...routes.entries()].filter(([, r]) => r.count >= min).map(([route, r]) => ({ route, calls: r.count, mean: r.sum / r.count, p50: percentile(r, 0.5), p95: percentile(r, 0.95), p99: percentile(r, 0.99) })).sort((a, b) => b.calls - a.calls);
if (rows.length === 0) { console.log('No route has had enough calls yet (or the histogram metric is not present).'); process.exit(0); }
const fmt = (n) => (n === Infinity ? '>max' : n >= 100 ? Math.round(n) : n.toFixed(1)).toString().padStart(6);
console.log('route'.padEnd(46) + 'calls'.padStart(8) + 'mean ms'.padStart(9) + ' p50 <='.padStart(8) + ' p95 <='.padStart(8) + ' p99 <='.padStart(8));
for (const r of rows) console.log(r.route.slice(0, 45).padEnd(46) + String(r.calls).padStart(8) + fmt(r.mean).padStart(9) + fmt(r.p50).padStart(8) + fmt(r.p95).padStart(8) + fmt(r.p99).padStart(8));
console.log('\n"p95 <= N" means at least 95% of calls finished within N ms (the histogram counts in buckets, so the figure is the bucket edge).');
