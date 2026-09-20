// Creates (once) the "canary": a real account with one API key that can call all three APIs, whose key the uptime watch
// uses every few minutes to prove the whole path works: Cloudflare -> desk-api -> key check -> each backend.
//   node scripts/setup-canary.mjs [--rotate]
// The key is written to C:\Users\User\.desk\canary-key.txt (readable only by this Windows user); it is never printed.
// The account has an unusable random password (nobody can sign in as it). Re-running does nothing unless --rotate.
import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const { Client } = require('pg');
const dir = path.join(os.homedir(), '.desk');
const file = path.join(dir, 'canary-key.txt');
const rotate = process.argv.includes('--rotate');
if (existsSync(file) && !rotate) { console.log('The canary key already exists; nothing to do (use --rotate to replace it).'); process.exit(0); }

const env = readFileSync('C:/actions-runners/desk-api/_work/live/.env', 'utf8');
const get = (k) => (new RegExp(`^${k}\\s*=\\s*(.*)$`, 'm').exec(env)?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
const BASE = process.env.CANARY_BASE || 'http://localhost:3458';
const db = new Client({ connectionString: get('DATABASE_URL') });
await db.connect();
try {
  const email = 'canary@deskbusiness.co';
  const password = 'Aa1!' + randomBytes(24).toString('base64url');
  const salt = randomBytes(16);
  const hash = `pbkdf2:sha256:310000:${salt.toString('base64')}:${pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('base64')}`;
  const now = new Date().toISOString();
  let user = (await db.query('SELECT id FROM users WHERE email = $1', [email])).rows[0];
  if (!user) {
    const id = randomBytes(16).toString('hex');
    await db.query('INSERT INTO users (id, email, password_hash, first_name, last_name, email_confirmed_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)', [id, email, hash, 'Canary', 'Monitor', now, now]);
    user = { id };
  } else {
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id]);
  }
  const ip = `198.18.250.${1 + Math.floor(Math.random() * 200)}`;
  const signin = await fetch(`${BASE}/auth/signin`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ email, password }) });
  const token = (await signin.json()).token;
  if (!token) throw new Error(`could not sign in as the canary (${signin.status})`);
  // an older canary key (if rotating) is revoked first
  const old = await fetch(`${BASE}/v1/gateway/api-keys`, { headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': ip } });
  for (const k of (await old.json()).apiKeys ?? []) if (k.label === 'canary') await fetch(`${BASE}/v1/gateway/api-keys/${k.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': ip } });
  const created = await fetch(`${BASE}/v1/gateway/api-keys`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'cf-connecting-ip': ip, 'idempotency-key': `canary-${Date.now()}` }, body: JSON.stringify({ label: 'canary', services: ['desk_api', 'registry_api', 'market_validation_api'] }) });
  const key = (await created.json()).apiKey?.key;
  if (!key) throw new Error(`could not create the canary key (${created.status})`);
  await fetch(`${BASE}/auth/signout`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': ip } });
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, key + '\n', { mode: 0o600 });
  console.log(`Canary key created and saved to ${file} (not shown).`);
} finally {
  await db.end();
}
