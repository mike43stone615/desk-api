// Finds where one machine's desk-api starts to struggle: ramps up the number of simultaneous callers and reports, for each
// step, requests per second, response-time percentiles and the share of failures.
//   node scripts/load-test.mjs --url http://127.0.0.1:3593 [--seconds 8] [--users 40] [--steps 1,5,10,25,50,100]
// Run it against a COPY of the service on a spare port with the development database (never production):
//   PORT=3593 node dist/server.js        then        node scripts/load-test.mjs --url http://127.0.0.1:3593
// Three kinds of call are mixed: a public page (no database), an authenticated call that hits the database (session
// check), and a key-authenticated call (key lookup + suspension check + usage count). Every simulated caller gets its own
// pretend network address and its own account, so the per-address and per-account limits do not hide the real limit.
import 'dotenv/config';
import { createRequire } from 'node:module';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = opt('--url', 'http://127.0.0.1:3593');
const SECONDS = Number(opt('--seconds', '8'));
const USERS = Number(opt('--users', '40'));
const STEPS = opt('--steps', '1,5,10,25,50,100').split(',').map(Number);
const require = createRequire(path.join(process.cwd(), 'package.json'));
const { Client } = require('pg');

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const name = (await db.query('SELECT current_database() n')).rows[0].n;
if (!/_(dev|test)$/.test(name)) throw new Error(`Refusing to load-test with database "${name}" (only _dev or _test).`);

// accounts, sessions and one key each
const password = 'Zx9!' + randomBytes(6).toString('hex') + 'Qq7#';
const salt = randomBytes(16);
const hash = `pbkdf2:sha256:310000:${salt.toString('base64')}:${pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('base64')}`;
const callers = [];
const stamp = Date.now();
const createdIds = [];
for (let i = 0; i < USERS; i++) {
  const id = randomBytes(16).toString('hex');
  const email = `load-${stamp}-${i}@example.com`;
  const now = new Date().toISOString();
  await db.query('INSERT INTO users (id, email, password_hash, first_name, last_name, email_confirmed_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)', [id, email, hash, 'L', 'T', now, now]);
  createdIds.push(id);
  const ip = `198.18.${100 + Math.floor(i / 250)}.${(i % 250) + 1}`;
  const s = await fetch(`${BASE}/auth/signin`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ email, password }) });
  const token = (await s.json()).token;
  const k = await fetch(`${BASE}/v1/gateway/api-keys`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ label: 'load', services: ['desk_api'] }) });
  callers.push({ ip, token, key: (await k.json()).apiKey?.key });
}
console.log(`${callers.length} accounts ready on ${BASE} (database ${name})\n`);

const KINDS = [
  { name: 'public page (no database)', call: (c, n) => fetch(`${BASE}/v1/errors/not_found`, { headers: { 'cf-connecting-ip': `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}` } }) },
  { name: 'signed-in call (session lookup)', call: (c) => fetch(`${BASE}/auth/session`, { headers: { authorization: `Bearer ${c.token}`, 'cf-connecting-ip': c.ip } }) },
  { name: 'key call (key lookup + counters)', call: (c) => fetch(`${BASE}/v1/auth/session`, { headers: { 'x-api-key': c.key, 'cf-connecting-ip': c.ip } }) },
];

async function step(concurrency) {
  const deadline = Date.now() + SECONDS * 1000;
  const times = []; let failures = 0; let limited = 0; let n = 0;
  await Promise.all(Array.from({ length: concurrency }, async (_, w) => {
    const c = callers[w % callers.length];
    while (Date.now() < deadline) {
      const kind = KINDS[n++ % KINDS.length];
      const t0 = performance.now();
      try {
        const r = await kind.call(c, n + w * 100000);
        await r.arrayBuffer();
        if (r.status === 429) limited++; else if (r.status >= 500) failures++;
      } catch { failures++; }
      times.push(performance.now() - t0);
    }
  }));
  times.sort((a, b) => a - b);
  const q = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))];
  return { concurrency, rps: Math.round(times.length / SECONDS), p50: q(0.5), p95: q(0.95), p99: q(0.99), failures, limited, total: times.length };
}

console.log('callers  requests/s   p50 ms   p95 ms   p99 ms   errors   limited');
const results = [];
for (const s of STEPS) {
  const r = await step(s);
  results.push(r);
  console.log(`${String(r.concurrency).padStart(7)}  ${String(r.rps).padStart(10)}  ${r.p50.toFixed(0).padStart(7)}  ${r.p95.toFixed(0).padStart(7)}  ${r.p99.toFixed(0).padStart(7)}  ${String(r.failures).padStart(6)}  ${String(r.limited).padStart(8)}`);
}
const knee = results.find((r) => r.p95 > 500 || r.failures > r.total * 0.01);
console.log(`\nFirst step where the 95th percentile passed 500 ms or more than 1% failed: ${knee ? `${knee.concurrency} simultaneous callers (${knee.rps} requests/s)` : 'none in this range'}.`);
console.log(`Highest throughput seen: ${Math.max(...results.map((r) => r.rps))} requests/s.`);

await db.query('DELETE FROM users WHERE id = ANY($1)', [createdIds]);
await db.end();
