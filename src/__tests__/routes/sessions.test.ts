// "Where am I signed in?" and "sign out everywhere".
import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { createFakeDb } from '../helpers/fake-db';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));
vi.mock('../../infrastructure/email/resend', async () => (await import('../helpers/email-capture')).emailModuleMock());

import { pool } from '../../db';
import { buildApp } from '../../app';
import { config } from '../../config';
import { hashPassword } from '../../domain/auth/password';
import type { FastifyInstance } from 'fastify';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;
let app: FastifyInstance;
const PASSWORD = 'Str0ng!Pass1';
let passwordHash: string;

beforeAll(async () => {
  app = await buildApp();
  passwordHash = await hashPassword(PASSWORD);
});

let n = 0;
function seedUser(): { id: string; email: string } {
  n += 1;
  const id = `sess-user-${n}`;
  const now = new Date().toISOString();
  fakeDb.users.set(id, {
    id, email: `${id}@example.com`, password_hash: passwordHash, first_name: 'S', last_name: 'U',
    email_confirmed_at: now, created_at: now, updated_at: now,
  });
  return { id, email: `${id}@example.com` };
}

async function signIn(email: string, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: 'POST', url: '/auth/signin', headers, payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body).token as string;
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const list = async (token: string) => JSON.parse((await app.inject({ method: 'GET', url: '/auth/sessions', headers: bearer(token) })).body).sessions as Array<Record<string, unknown>>;

describe('GET /auth/sessions', () => {
  it('lists the person\'s live sessions, marks the one asking, and shows what signed in', async () => {
    const u = seedUser();
    const phone = await signIn(u.email, { 'user-agent': 'DeskApp/2.1 (iPhone)', 'cf-connecting-ip': '203.0.113.7' });
    const laptop = await signIn(u.email, { 'user-agent': 'Mozilla/5.0 (Windows) Chrome/120', 'cf-connecting-ip': '198.51.100.9' });
    const sessions = await list(laptop);
    expect(sessions).toHaveLength(2);
    const current = sessions.find((s) => s.current)!;
    expect(current).toMatchObject({ userAgent: 'Mozilla/5.0 (Windows) Chrome/120', ip: '198.51.100.9' });
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    const other = sessions.find((s) => !s.current)!;
    expect(other).toMatchObject({ userAgent: 'DeskApp/2.1 (iPhone)', ip: '203.0.113.7' });
    // Never exposes anything that could be used as a credential.
    const text = JSON.stringify(sessions);
    expect(text).not.toContain(phone);
    expect(text).not.toContain(laptop);
    expect(text).not.toContain('sha256:');
    expect(Object.keys(current).sort()).toEqual(['createdAt', 'current', 'expiresAt', 'id', 'ip', 'lastUsedAt', 'userAgent']);
  });

  it('never shows anyone else\'s sessions, and hides expired ones', async () => {
    const a = seedUser();
    const b = seedUser();
    const tokenA = await signIn(a.email);
    await signIn(b.email);
    expect(await list(tokenA)).toHaveLength(1);
    // expire A's only other session
    const second = await signIn(a.email);
    for (const row of fakeDb.sessions.values()) if (row.user_id === a.id && row.id !== (await list(tokenA)).find((s) => s.current)!.id) row.expires_at = '2000-01-01T00:00:00.000Z';
    expect(await list(tokenA)).toHaveLength(1);
    expect(second).toBeTruthy();
  });

  it('requires a session (401), and an API Library key cannot use it (403)', async () => {
    expect((await app.inject({ method: 'GET', url: '/auth/sessions' })).statusCode).toBe(401);
    const u = seedUser();
    const token = await signIn(u.email);
    config.gatewayKeyEncryptionSecret = 'ab'.repeat(32);
    const created = await app.inject({ method: 'POST', url: '/gateway/api-keys', headers: bearer(token), payload: { label: 'k', services: ['desk_api'] } });
    const key = JSON.parse(created.body).apiKey.key;
    expect((await app.inject({ method: 'GET', url: '/auth/sessions', headers: { 'x-api-key': key } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/auth/signout-all', headers: { 'x-api-key': key }, payload: {} })).statusCode).toBe(403);
  });

  it('records when a session was last used, without writing on every request', async () => {
    const u = seedUser();
    const token = await signIn(u.email);
    const row = [...fakeDb.sessions.values()].find((r) => r.user_id === u.id)!;
    expect(row.last_used_at).toBeNull();
    await app.inject({ method: 'GET', url: '/auth/session', headers: bearer(token) });
    await new Promise((r) => setTimeout(r, 10));
    const firstUse = row.last_used_at;
    expect(firstUse).toBeTruthy();
    await app.inject({ method: 'GET', url: '/auth/session', headers: bearer(token) });
    await new Promise((r) => setTimeout(r, 10));
    expect(row.last_used_at).toBe(firstUse); // fresh: not rewritten
    row.last_used_at = new Date(Date.now() - 3_600_000).toISOString();
    await app.inject({ method: 'GET', url: '/auth/session', headers: bearer(token) });
    await new Promise((r) => setTimeout(r, 10));
    expect(Date.now() - Date.parse(row.last_used_at as string)).toBeLessThan(60_000); // stale: refreshed
  });
});

describe('DELETE /auth/sessions/:id', () => {
  it('ends another device\'s session immediately, and only that one', async () => {
    const u = seedUser();
    const phone = await signIn(u.email);
    const laptop = await signIn(u.email);
    const target = (await list(laptop)).find((s) => !s.current)!;
    const res = await app.inject({ method: 'DELETE', url: `/auth/sessions/${target.id}`, headers: bearer(laptop) });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/auth/session', headers: bearer(phone) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/auth/session', headers: bearer(laptop) })).statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('cannot end someone else\'s session, or one that does not exist (404 either way)', async () => {
    const a = seedUser();
    const b = seedUser();
    const tokenA = await signIn(a.email);
    const tokenB = await signIn(b.email);
    const bSession = (await list(tokenB))[0];
    const res = await app.inject({ method: 'DELETE', url: `/auth/sessions/${bSession.id}`, headers: bearer(tokenA) });
    expect(res.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/auth/session', headers: bearer(tokenB) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/auth/sessions/nope', headers: bearer(tokenA) })).statusCode).toBe(404);
  });

  it('ending the current session signs the caller out and clears the cookie', async () => {
    const u = seedUser();
    const token = await signIn(u.email);
    const self = (await list(token)).find((s) => s.current)!;
    const res = await app.inject({ method: 'DELETE', url: `/auth/sessions/${self.id}`, headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['set-cookie'])).toMatch(/desk_session=;|Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    expect((await app.inject({ method: 'GET', url: '/auth/session', headers: bearer(token) })).statusCode).toBe(401);
  });
});

describe('POST /auth/signout-all', () => {
  it('ends every session including this one, and says how many', async () => {
    const u = seedUser();
    const tokens = [await signIn(u.email), await signIn(u.email), await signIn(u.email)];
    const other = seedUser();
    const otherToken = await signIn(other.email);
    const res = await app.inject({ method: 'POST', url: '/auth/signout-all', headers: bearer(tokens[0]), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, revoked: 3 });
    expect(String(res.headers['set-cookie'])).toMatch(/desk_session=;|Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    for (const t of tokens) expect((await app.inject({ method: 'GET', url: '/auth/session', headers: bearer(t) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/auth/session', headers: bearer(otherToken) })).statusCode).toBe(200);
  });

  it('with keepCurrent it ends only the others and keeps this device signed in', async () => {
    const u = seedUser();
    const tokens = [await signIn(u.email), await signIn(u.email), await signIn(u.email)];
    const res = await app.inject({ method: 'POST', url: '/auth/signout-all', headers: bearer(tokens[1]), payload: { keepCurrent: true } });
    expect(JSON.parse(res.body)).toEqual({ ok: true, revoked: 2 });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: '/auth/session', headers: bearer(tokens[1]) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/auth/session', headers: bearer(tokens[0]) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/auth/session', headers: bearer(tokens[2]) })).statusCode).toBe(401);
  });

  it('works from the web app\'s cookie session, and a foreign site cannot trigger it', async () => {
    const u = seedUser();
    const res = await app.inject({ method: 'POST', url: '/auth/signin', headers: { 'x-session-transport': 'cookie' }, payload: { email: u.email, password: PASSWORD } });
    const cookie = String(res.headers['set-cookie']);
    const value = /=([^;]+)/.exec(cookie)![1];
    const name = cookie.split('=')[0];
    const foreign = await app.inject({ method: 'POST', url: '/auth/signout-all', headers: { origin: 'https://evil.example.com' }, cookies: { [name]: value }, payload: {} });
    expect(foreign.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/auth/signout-all', headers: { origin: config.corsOrigins[0] }, cookies: { [name]: value }, payload: {} });
    expect(ok.statusCode).toBe(200);
  });
});
