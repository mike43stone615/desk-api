// The traces are collected by a local Jaeger (http://localhost:16686). This reads them for you: for each service, the
// slowest requests of the last day and where the time went, so that "tracing is set up" turns into something a person
// can act on without opening the Jaeger screens.
//   node scripts/slow-traces.mjs [lookback=1d] [top=5]
// Prints operation names and durations only (never request bodies, headers or addresses).
const JAEGER = process.env.JAEGER_URL || 'http://localhost:16686';
const lookback = process.argv[2] || '1d';
const top = Number(process.argv[3]) || 5;

const get = async (path) => (await fetch(JAEGER + path, { signal: AbortSignal.timeout(20000) })).json();

let services;
try { services = (await get('/api/services')).data.filter((s) => !/jaeger/.test(s)); }
catch (e) { console.error(`Jaeger is not answering at ${JAEGER}: ${e.message}`); process.exit(1); }

for (const service of services) {
  const { data } = await get(`/api/traces?service=${encodeURIComponent(service)}&lookback=${lookback}&limit=300`);
  const rows = (data ?? []).map((trace) => {
    const root = trace.spans.reduce((a, b) => (a.duration >= b.duration ? a : b));
    const slowestChild = trace.spans.filter((s) => s.spanID !== root.spanID).sort((a, b) => b.duration - a.duration)[0];
    return { ms: Math.round(root.duration / 1000), op: root.operationName, inner: slowestChild ? `${slowestChild.operationName} ${Math.round(slowestChild.duration / 1000)} ms` : '' };
  }).sort((a, b) => b.ms - a.ms);
  console.log(`\n${service}: ${rows.length} traces in the last ${lookback}` + (rows.length ? `, median ${rows[Math.floor(rows.length / 2)].ms} ms` : ''));
  for (const r of rows.slice(0, top)) console.log(`  ${String(r.ms).padStart(6)} ms  ${r.op}${r.inner ? `   (longest step: ${r.inner})` : ''}`);
}
