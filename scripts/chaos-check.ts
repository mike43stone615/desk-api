// Kills things on purpose and checks that the service answers sensibly and recovers by itself:
//   1. the registry backend disappears  -> 502 at first, then the circuit opens: 503 with Retry-After, instantly;
//   2. the backend comes back            -> after the open period one trial call succeeds and normal answers resume;
//   3. every database connection is killed -> the next requests work again and the process never crashed;
//   4. a caller who gives up while the backend is slow -> the call to the backend is dropped too.
// Runs a COPY of the service (port 3592) against the development database and a stand-in backend (port 3591), so
// production is never touched. Usage:  npx tsx scripts/chaos-check.ts [rounds]    (needs the dev database running)
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { Client } from 'pg';
import { hashPassword } from '../src/domain/auth/password';

const PORT = 3592;
const BACKEND_PORT = 3591;
const BASE = `http://127.0.0.1:${PORT}`;
const rounds = Number(process.argv[2]) || 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, '->', detail); }
};

let backend: http.Server | null = null;
let hang = false; // when set, the stand-in backend never answers
let hungRequestsClosed = 0;
function startBackend(): Promise<void> {
  return new Promise((resolve) => {
    backend = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      res.on('close', () => { if (hang && !res.writableFinished) hungRequestsClosed++; });
      req.on('end', () => {
        if (hang) return; // never answer
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, standIn: true })); });
    }).listen(BACKEND_PORT, '127.0.0.1', () => resolve());
  });
}
function stopBackend(): Promise<void> {
  return new Promise((resolve) => { if (!backend) return resolve(); backend.closeAllConnections?.(); backend.close(() => resolve()); backend = null; });
}

async function call(path: string, token?: string, ip = '198.18.60.1', method = 'POST', body: unknown = { businessName: 'Chaos Widgets', stateOfFormation: 'FL' }) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> | undefined;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers };
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const name = (await db.query('SELECT current_database() AS n')).rows[0].n as string;
  if (!/_(dev|test)$/.test(name)) throw new Error(`Refusing to run against "${name}": this check kills database connections and may only use a _dev or _test database.`);

  const password = 'Zx9!chaosCheck7Q#';
  const userId = 'chaos' + Date.now().toString(16);
  const email = `chaos-${Date.now()}@example.com`;
  const now = new Date().toISOString();
  await db.query('INSERT INTO users (id, email, password_hash, first_name, last_name, email_confirmed_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)', [userId, email, await hashPassword(password), 'Chaos', 'Check', now, now]);

  await startBackend();
  const child: ChildProcess = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), REGISTRY_API_URL: `http://127.0.0.1:${BACKEND_PORT}`, REGISTRY_API_SECRET: 'stand-in', NODE_ENV: 'development' },
    stdio: 'ignore',
  });
  let exited = false;
  child.on('exit', () => { exited = true; });

  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/health')).ok) break; } catch { /* starting */ } await sleep(500); }
    const login = await call('/auth/signin', undefined, '198.18.60.2', 'POST', { email, password });
    const token = login.json?.token as string;
    check('the copy of the service is up and a test user can sign in', login.status === 200 && Boolean(token), String(login.status));

    for (let round = 1; round <= rounds; round++) {
      console.log(`round ${round}`);
      const ip = `198.18.61.${round}`;
      const path = '/functions/v1/check-business-name-availability';
      const good = await call(path, token, ip);
      check(`round ${round}: with the backend up, the lookup answers 200`, good.status === 200 && good.json?.standIn === true, `${good.status}`);

      // a caller gives up after one second while the backend is hanging
      hang = true;
      hungRequestsClosed = 0;
      await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, authorization: `Bearer ${token}` }, body: '{"businessName":"Slow Co","stateOfFormation":"FL"}', signal: AbortSignal.timeout(1000) }).catch(() => {});
      await sleep(1500);
      check(`round ${round}: the caller left after 1 s, so the service dropped its call to the slow backend too (${hungRequestsClosed} closed)`, hungRequestsClosed >= 1, `closed=${hungRequestsClosed}`);
      hang = false;
      const notPunished = await call(path, token, ip);
      check(`round ${round}: a caller who left is not counted as the backend failing`, notPunished.status === 200, `${notPunished.status}`);

      await stopBackend();
      const first = await call(path, token, ip);
      check(`round ${round}: backend gone -> 502 with a clear code (${first.json?.code})`, first.status === 502 && first.json?.code === 'upstream_unreachable', `${first.status} ${JSON.stringify(first.json)}`);
      let opened = first;
      for (let i = 0; i < 8 && opened.status !== 503; i++) opened = await call(path, token, ip);
      check(`round ${round}: after repeated failures the circuit opens: 503 upstream_unavailable with Retry-After`, opened.status === 503 && opened.json?.code === 'upstream_unavailable' && Number(opened.headers.get('retry-after')) > 0, `${opened.status} retry-after=${opened.headers.get('retry-after')}`);
      const t0 = Date.now();
      await call(path, token, ip);
      check(`round ${round}: while the circuit is open the refusal is instant (${Date.now() - t0} ms), not another wait for a dead backend`, Date.now() - t0 < 500, `${Date.now() - t0} ms`);
      const health = await call('/health', undefined, ip, 'GET');
      check(`round ${round}: the service itself stays up and healthy while its backend is dead`, health.status === 200 && !exited, `${health.status}`);

      await startBackend();
      await sleep(16_000); // the circuit's open period is 15 s
      const back = await call(path, token, ip);
      check(`round ${round}: backend back -> the next call is the trial and succeeds (200)`, back.status === 200, `${back.status} ${JSON.stringify(back.json)}`);
      const after = await call(path, token, ip);
      check(`round ${round}: ...and everything is normal again`, after.status === 200, `${after.status}`);

      // every database connection the service holds is killed from outside
      const killed = await db.query("SELECT COUNT(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND application_name <> 'chaos-check'");
      let recovered = false;
      let seen500 = 0;
      for (let i = 0; i < 20; i++) {
        const r = await call('/auth/session', token, ip, 'GET');
        if (r.status === 200) { recovered = true; break; }
        if (r.status >= 500) seen500++;
        await sleep(500);
      }
      check(`round ${round}: ${killed.rows[0].n} database connections killed -> requests work again by themselves (${seen500} error answers on the way)`, recovered && !exited, `recovered=${recovered} exited=${exited}`);
      const ready = await call('/health/ready', undefined, ip, 'GET');
      check(`round ${round}: readiness reports ok again`, ready.status === 200, `${ready.status}`);
    }
  } finally {
    child.kill();
    await stopBackend();
    await db.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    await db.end();
    console.log(`\nchecks: ${pass} passed, ${fail} failed`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
