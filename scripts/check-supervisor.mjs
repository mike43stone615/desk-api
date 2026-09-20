// Manual check of src/supervisor.ts (run from the repo after `npm run build:prod`; uses the dev database and ports 3599/3598):
//   node scripts/check-supervisor.mjs
// Reloads under steady traffic (no request may fail), a bad release is refused, a killed worker is replaced, stop works.
//  - 3 reloads under constant traffic (fresh connections AND kept-alive ones): zero failed requests, worker really changes
//  - a request that is still being answered when the reload happens is not cut off
//  - a bad new version (exits at once) is refused and the old worker keeps serving
//  - a worker killed from outside is replaced
//  - stop drains and exits
import { spawn } from 'node:child_process';
import http from 'node:http';
import { cpSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { if (ok) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n, '->', d); } };
const REPO = process.cwd().split('\\').join('/');
const COPY = `${REPO}/.tmp-sup`;
const PORT = 3599, CTL = 3598;

function get(path, port = PORT, agent) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, agent, headers: { 'cf-connecting-ip': '198.18.70.1' }, timeout: 8000 }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ s: res.statusCode, b })); });
    req.on('error', (e) => resolve({ s: 0, b: String(e.code || e.message) }));
    req.on('timeout', () => { req.destroy(); resolve({ s: 0, b: 'timeout' }); });
    req.end();
  });
}
function post(path) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: CTL, path, method: 'POST', timeout: 120000 }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ s: res.statusCode, j: JSON.parse(b || '{}') })); });
    req.on('error', (e) => resolve({ s: 0, j: { error: String(e) } }));
    req.end();
  });
}
const status = async () => JSON.parse((await get('/status', CTL)).b);

rmSync(COPY, { recursive: true, force: true });
cpSync(`${REPO}/dist`, `${COPY}/dist`, { recursive: true });
cpSync(`${REPO}/library-ui`, `${COPY}/library-ui`, { recursive: true });
const child = spawn(process.execPath, [`${COPY}/dist/supervisor.js`], { cwd: REPO, env: { ...process.env, PORT: String(PORT), SUPERVISOR_PORT: String(CTL), SUPERVISOR_DRAIN_MS: '15000', LOG_DIR: `${COPY}/logs`, LOG_RETENTION_DAYS: '30' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
try {
  for (let i = 0; i < 60; i++) { if ((await get('/status', CTL)).s === 200) break; await sleep(500); }
  check('supervisor and first worker are up', (await get('/health')).s === 200, out.slice(-300));

  for (let round = 1; round <= 8; round++) {
    console.log('round', round);
    const before = await status();
    // constant traffic: 30 requests/second, half on fresh connections, half over kept-alive ones
    const keep = new http.Agent({ keepAlive: true, maxSockets: 4 });
    let sent = 0, bad = []; let running = true;
    const traffic = (async () => { let n = 0; while (running) { n++; const useKeep = n % 2 === 0; get('/health', PORT, useKeep ? keep : undefined).then((r) => { sent++; if (r.s !== 200) bad.push(`${r.s}:${r.b.slice(0, 40)}`); }); await sleep(33); } })();
    // a request that is slow on purpose and straddles the swap: /health/ready talks to the database; also long-poll style via slow client
    await sleep(600);
    const slow = get('/metrics'); // any ordinary in-flight request
    const r = await post('/reload');
    await sleep(3500);
    running = false; await traffic; await sleep(500);
    const after = await status();
    const slowRes = await slow;
    check(`round ${round}: reload answered ok and the worker really changed (${before.workers} -> ${after.workers})`, r.s === 200 && after.workers.length === 1 && after.workers[0] !== before.workers[0], JSON.stringify(r));
    check(`round ${round}: ${sent} requests during the swap, none failed`, sent > 60 && bad.length === 0, `${bad.length} bad: ${bad.slice(0, 5).join(' | ')}`);
    check(`round ${round}: the old worker is gone (nothing left draining)`, after.draining.length === 0, JSON.stringify(after));
    check(`round ${round}: an ordinary request in flight at the swap was answered (${slowRes.s})`, slowRes.s === 200 || slowRes.s === 401, `${slowRes.s} ${slowRes.b}`);
    keep.destroy();
  }

  // a bad release: the new worker dies at once; the old one must keep serving
  const good = readFileSync(`${COPY}/dist/server.js`, 'utf8');
  for (let round = 1; round <= 3; round++) {
    const before = await status();
    writeFileSync(`${COPY}/dist/server.js`, 'process.exit(3);');
    let bad = 0, running = true;
    const traffic = (async () => { while (running) { const r = await get('/health'); if (r.s !== 200) bad++; await sleep(50); } })();
    const r = await post('/reload');
    running = false; await traffic;
    const after = await status();
    check(`bad release ${round}: reload refused (${r.s}: ${String(r.j.message).slice(0, 70)})`, r.s === 500, JSON.stringify(r));
    check(`bad release ${round}: the old worker was never touched and kept answering`, after.workers[0] === before.workers[0] && bad === 0, `${bad} failed; ${JSON.stringify(after)}`);
    writeFileSync(`${COPY}/dist/server.js`, good);
  }
  check('after the bad releases a good reload works again', (await post('/reload')).s === 200 && (await get('/health')).s === 200);

  // a worker killed from outside comes back
  const s1 = await status();
  process.kill(s1.workers[0]);
  let back = false; for (let i = 0; i < 40; i++) { await sleep(500); const st = await status().catch(() => null); if (st && st.workers.length === 1 && st.workers[0] !== s1.workers[0] && (await get('/health')).s === 200) { back = true; break; } }
  check('a worker killed from outside is replaced and serves again', back, out.slice(-300));

  const stopped = post('/stop');
  await stopped;
  let gone = false; for (let i = 0; i < 40; i++) { await sleep(500); if ((await get('/health')).s === 0) { gone = true; break; } }
  check('stop drains and the service exits', gone);

  // the daily log files: worker output is captured, and files older than the retention window are removed
  const today = new Date().toISOString().slice(0, 10);
  const logFile = `${COPY}/logs/desk-api-${today}.log`;
  check("the worker output went to today's log file (server lines with request ids)", existsSync(logFile) && /"msg":"Server listening/.test(readFileSync(logFile, 'utf8')) && /"reqId"/.test(readFileSync(logFile, 'utf8')), logFile);
  check("the supervisor's own messages are in the same file", /"component":"supervisor"/.test(readFileSync(logFile, 'utf8')));
  writeFileSync(`${COPY}/logs/desk-api-2020-01-01.log`, 'old');
  writeFileSync(`${COPY}/logs/desk-api-2020-01-01.err.log`, 'old');
  const second = spawn(process.execPath, [`${COPY}/dist/supervisor.js`], { cwd: REPO, env: { ...process.env, PORT: String(PORT), SUPERVISOR_PORT: String(CTL), LOG_DIR: `${COPY}/logs` }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { if ((await get('/status', CTL)).s === 200) break; await sleep(500); }
  check('a file older than the retention window is deleted when the supervisor starts logging', !existsSync(`${COPY}/logs/desk-api-2020-01-01.log`) && !existsSync(`${COPY}/logs/desk-api-2020-01-01.err.log`) && existsSync(logFile));
  await post('/stop');
  second.kill();
} finally {
  try { child.kill(); } catch { /* gone */ }
  rmSync(COPY, { recursive: true, force: true });
  console.log(`\nchecks: ${pass} passed, ${fail} failed`);
}
process.exit(fail ? 1 : 0);
