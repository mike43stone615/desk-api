// Shared helper for the live checks (scripts/live-checks/), which run against the real service. Creates throwaway users straight in the database (so the
// sign-up limiter is not used up), and removes everything it created. Nothing secret is printed.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomBytes, pbkdf2Sync } from 'node:crypto';
const require = createRequire(process.cwd() + '/package.json');
const { Client } = require('pg');

export const BASE = process.env.LIVE_BASE || 'https://api.deskbusiness.co';
export const PW = 'Zx9!' + randomBytes(6).toString('hex') + 'Qq7#';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The production database URL is read from the settings the deployed service itself uses.
export function prodEnv(repo = 'desk-api') {
  const text = readFileSync((repo === 'desk-api' ? 'C:/actions-runners/desk-api/_work/live/.env' : `C:/actions-runners/${repo}/_work/${repo}/${repo}/.env`), 'utf8');
  const get = (k) => (new RegExp(`^${k}\\s*=\\s*(.*)$`, 'm').exec(text)?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
  return { get };
}

export async function openHarness(tag = 'x') {
  const db = new Client({ connectionString: prodEnv().get('DATABASE_URL') });
  await db.connect();
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const created = { users: [], keys: [] };
  const results = [];
  const hashPw = (pw) => {
    const salt = randomBytes(16);
    return `pbkdf2:sha256:310000:${salt.toString('base64')}:${pbkdf2Sync(pw, salt, 310000, 32, 'sha256').toString('base64')}`;
  };

  async function call(method, path, { token, cookie, key, body, raw, headers = {}, pace = 350 } = {}) {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (cookie) h.cookie = cookie;
    if (key) h['x-api-key'] = key;
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    await sleep(pace);
    const t0 = Date.now();
    const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: 'manual' });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { /* not json */ }
    return { s: res.status, h: res.headers, text, json, ms: Date.now() - t0 };
  }

  async function mkUser(name, { confirmed = true, password = PW } = {}) {
    const id = randomBytes(16).toString('hex');
    const email = `gwtest-${tag}-${name}-${stamp}@example.com`;
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO users (id, email, password_hash, first_name, last_name, email_confirmed_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [id, email, hashPw(password), name.toUpperCase(), 'Verify', confirmed ? now : null, now],
    );
    const u = { id, email, password };
    created.users.push(id);
    return u;
  }

  // Signs in (bearer token and/or cookie) and returns the credentials.
  async function signin(u, { cookieMode = false, password } = {}) {
    const r = await call('POST', '/auth/signin', {
      body: { email: u.email, password: password ?? u.password },
      headers: cookieMode ? { 'x-session-transport': 'cookie', origin: 'https://app.deskbusiness.co' } : {},
    });
    return {
      status: r.s,
      token: r.json?.token,
      cookie: (r.h.get('set-cookie') || '').split(';')[0] || undefined,
      res: r,
    };
  }

  function check(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : '  -> ' + detail}`);
    return ok;
  }

  async function cleanup() {
    for (const [tok, id] of created.keys) { try { await call('DELETE', `/gateway/api-keys/${id}`, { token: tok, pace: 100 }); } catch { /* ignore */ } }
    if (created.users.length) await db.query('DELETE FROM users WHERE id = ANY($1)', [created.users]);
    await db.query('DELETE FROM idempotency_keys WHERE key LIKE $1', [`%${stamp}%`]).catch(() => {});
    await db.end();
  }

  return { db, stamp, call, mkUser, signin, check, cleanup, created, results };
}
