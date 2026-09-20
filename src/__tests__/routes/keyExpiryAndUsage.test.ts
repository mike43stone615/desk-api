// Key expiry (a chosen date, and idle for 180 days), what a developer sees of their own usage, and deleting an account
// revoking its keys at once.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));
vi.mock('../../infrastructure/email/resend', async () => (await import('../helpers/email-capture')).emailModuleMock());

import { buildApp } from '../../app';
import { pool } from '../../db';
import { config } from '../../config';
import { hashPassword } from '../../domain/auth/password';
import { resetSigninThrottleForTests } from '../../middleware/signin-throttle';
import { keyTimeProblem, KEY_IDLE_DAYS } from '../../domain/gateway/keys';
import { revokeExpiredKeys } from '../../domain/gateway/expiry';
import type { createFakeDb } from '../helpers/fake-db';
import type { FastifyInstance } from 'fastify';

type Rows = Map<string, Record<string, unknown>>;
const fakeDb = pool as unknown as ReturnType<typeof createFakeDb> & { gatewayKeys: Rows };
const PASSWORD = 'Str0ng!Pass1';
let app: FastifyInstance;
let hash: string;
let n = 0;

beforeAll(async () => {
  app = await buildApp();
  hash = await hashPassword(PASSWORD);
  config.gatewayKeyEncryptionSecret = 'ab'.repeat(32);
}, 30_000);
beforeEach(() => {
  resetSigninThrottleForTests();
  config.rateLimitPerMinute = 120;
});

function seedUser() {
  n += 1;
  const id = `exp-${n}`;
  const now = new Date().toISOString();
  fakeDb.users.set(id, { id, email: `${id}@example.com`, password_hash: hash, first_name: 'E', last_name: 'X', email_confirmed_at: now, created_at: now, updated_at: now });
  return { id, email: `${id}@example.com` };
}
async function session(email: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/signin', headers: { 'cf-connecting-ip': `203.0.113.${(n % 200) + 1}` }, payload: { email, password: PASSWORD } });
  return { authorization: `Bearer ${JSON.parse(res.body).token}` };
}
async function makeKey(headers: Record<string, string>, extra: Record<string, unknown> = {}) {
  const res = await app.inject({ method: 'POST', url: '/gateway/api-keys', headers, payload: { label: 'k', services: ['desk_api'], ...extra } });
  const body = JSON.parse(res.body);
  return { res, body, id: body.apiKey?.id as string, key: body.apiKey?.key as string };
}
const useKey = (key: string) => app.inject({ method: 'GET', url: '/auth/session', headers: { 'x-api-key': key, 'cf-connecting-ip': '198.51.100.55' } });
const keyRows = () => fakeDb.gatewayKeys;

describe('when a key stops working because of time', () => {
  it('keyTimeProblem: past its date is expired; unused for 180 days is idle; recent use keeps it alive; no date never expires', () => {
    const day = 86_400_000;
    const iso = (offset: number) => new Date(Date.now() + offset * day).toISOString();
    expect(keyTimeProblem({ created_at: iso(-10), last_used_at: null, expires_at: iso(-1) })).toBe('expired');
    expect(keyTimeProblem({ created_at: iso(-10), last_used_at: null, expires_at: iso(5) })).toBeNull();
    expect(keyTimeProblem({ created_at: iso(-(KEY_IDLE_DAYS + 1)), last_used_at: null, expires_at: null })).toBe('idle');
    expect(keyTimeProblem({ created_at: iso(-400), last_used_at: iso(-3), expires_at: null })).toBeNull();
    expect(keyTimeProblem({ created_at: iso(-400), last_used_at: iso(-(KEY_IDLE_DAYS + 1)), expires_at: null })).toBe('idle');
  });

  it('a key made with expiresInDays shows its date, works until then, and is refused with 401 api_key_expired afterwards', async () => {
    const h = await session(seedUser().email);
    const { res, body, id, key } = await makeKey(h, { expiresInDays: 30 });
    expect(res.statusCode).toBe(201);
    expect(Date.parse(body.apiKey.expiresAt) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect((await useKey(key)).statusCode).toBe(200);
    keyRows().get(id)!.expires_at = new Date(Date.now() - 1000).toISOString();
    const late = await useKey(key);
    expect(late.statusCode).toBe(401);
    expect(JSON.parse(late.body).code).toBe('api_key_expired');
  });

  it('expiresInDays must be a sensible whole number', async () => {
    const h = await session(seedUser().email);
    for (const bad of [0, -3, 1.5, 9999, 'soon']) expect((await makeKey(h, { expiresInDays: bad })).res.statusCode, String(bad)).toBe(400);
  });

  it('the nightly job revokes the expired and the idle keys and leaves the good ones', async () => {
    const h = await session(seedUser().email);
    const a = await makeKey(h, { label: 'a' });
    const b = await makeKey(h, { label: 'b', expiresInDays: 10 });
    const c = await makeKey(h, { label: 'c' });
    keyRows().get(b.id)!.expires_at = new Date(Date.now() - 1000).toISOString();
    keyRows().get(c.id)!.last_used_at = new Date(Date.now() - (KEY_IDLE_DAYS + 5) * 86_400_000).toISOString();
    const log = { info: vi.fn(), warn: vi.fn() } as never;
    expect(await revokeExpiredKeys(log)).toBeGreaterThanOrEqual(2);
    expect(keyRows().get(a.id)!.revoked_at).toBeFalsy();
    expect(keyRows().get(b.id)!.revoked_at).toBeTruthy();
    expect(keyRows().get(c.id)!.revoked_at).toBeTruthy();
  });
});

describe('a developer sees their own usage', () => {
  it('counts calls and errors per day for the key, only for its owner, with the limits that apply', async () => {
    const h = await session(seedUser().email);
    const { id, key } = await makeKey(h);
    for (let i = 0; i < 3; i++) await useKey(key);
    await app.inject({ method: 'GET', url: '/setup/drafts/abc', headers: { 'x-api-key': key, 'cf-connecting-ip': '198.51.100.55' } }); // a 404 counts as an error
    await new Promise((r) => setTimeout(r, 30));
    const res = await app.inject({ method: 'GET', url: `/gateway/api-keys/${id}/usage?days=7`, headers: h });
    const b = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(b.totals).toEqual({ calls: 4, errors: 1 });
    expect(b.daily).toHaveLength(1);
    expect(b.limits.map((l: { service: string }) => l.service)).toEqual(['desk_api', 'registry_api', 'market_validation_api']);
    expect(b.limits[0].perMinute).toBe(60);
    const other = await session(seedUser().email);
    expect((await app.inject({ method: 'GET', url: `/gateway/api-keys/${id}/usage`, headers: other })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/gateway/api-keys/${id}/usage`, headers: { 'x-api-key': key } })).statusCode).toBeGreaterThanOrEqual(401);
  });
});

describe('deleting an account', () => {
  it('revokes its keys right away (no waiting for a sweeper)', async () => {
    const u = seedUser();
    const h = await session(u.email);
    const { key } = await makeKey(h);
    expect((await useKey(key)).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/auth/account/delete', headers: h, payload: { password: PASSWORD } })).statusCode).toBe(200);
    expect((await useKey(key)).statusCode).toBe(401);
    expect(fakeDb.users.has(u.id)).toBe(false);
  });
});
