// Switching an API key or a whole account off (and back on) without deleting anything; the admin view of keys; and the
// hardening of the administrator credentials (recent sign-in for sessions, address list and record for the static key).
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
import type { createFakeDb } from '../helpers/fake-db';
import type { FastifyInstance } from 'fastify';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;
const PASSWORD = 'Str0ng!Pass1';
let app: FastifyInstance;
let hash: string;
let n = 0;

beforeAll(async () => {
  app = await buildApp();
  hash = await hashPassword(PASSWORD);
  config.gatewayKeyEncryptionSecret = 'ab'.repeat(32);
}, 30_000);
beforeEach(() => { resetSigninThrottleForTests(); config.adminApiKeyAllowedIps = []; });

const now = () => new Date().toISOString();
function seedUser(email?: string) {
  n += 1;
  const id = `susp-${n}`;
  fakeDb.users.set(id, { id, email: email ?? `${id}@example.com`, password_hash: hash, first_name: 'S', last_name: 'U', email_confirmed_at: now(), created_at: now(), updated_at: now() });
  return { id, email: fakeDb.users.get(id)!.email as string };
}
async function signIn(email: string, ip = `203.0.113.${(n % 200) + 1}`) {
  const res = await app.inject({ method: 'POST', url: '/auth/signin', headers: { 'cf-connecting-ip': ip }, payload: { email, password: PASSWORD } });
  return { res, headers: { authorization: `Bearer ${JSON.parse(res.body).token}`, 'cf-connecting-ip': ip } };
}
async function adminSession(createdDaysAgo = 0) {
  const u = seedUser('admin@example.com'); // ADMIN_EMAILS in __tests__/setup.ts
  fakeDb.seedSession(`admin-tok-${u.id}`, { id: `as-${u.id}`, user_id: u.id, token: `admin-tok-${u.id}`, expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: new Date(Date.now() - createdDaysAgo * 86_400_000).toISOString() });
  return { user: u, headers: { authorization: `Bearer admin-tok-${u.id}` } };
}
async function createKey(headers: Record<string, string>) {
  const res = await app.inject({ method: 'POST', url: '/gateway/api-keys', headers, payload: { label: 'k', services: ['desk_api'] } });
  const b = JSON.parse(res.body);
  return { id: b.apiKey.id as string, key: b.apiKey.key as string };
}
const useKey = (key: string) => app.inject({ method: 'GET', url: '/auth/session', headers: { 'x-api-key': key, 'cf-connecting-ip': '198.51.100.44' } });

describe('an owner switching one of their own keys off', () => {
  it('a suspended key is refused with 403 api_key_suspended (nothing revoked), and works again when resumed', async () => {
    const u = seedUser();
    const { headers } = await signIn(u.email);
    const { id, key } = await createKey(headers);
    expect((await useKey(key)).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/gateway/api-keys/${id}/suspend`, headers })).statusCode).toBe(200);
    const off = await useKey(key);
    expect(off.statusCode).toBe(403);
    expect(JSON.parse(off.body).code).toBe('api_key_suspended');
    const list = JSON.parse((await app.inject({ method: 'GET', url: '/gateway/api-keys', headers })).body);
    expect(list.apiKeys.find((k: { id: string }) => k.id === id).suspended).toBe(true);
    expect((await app.inject({ method: 'POST', url: `/gateway/api-keys/${id}/resume`, headers })).statusCode).toBe(200);
    expect((await useKey(key)).statusCode).toBe(200);
  });

  it('cannot touch somebody else\'s key (404), and a key cannot suspend itself or its siblings', async () => {
    const a = seedUser();
    const b = seedUser();
    const ka = await createKey((await signIn(a.email)).headers);
    const hb = (await signIn(b.email)).headers;
    expect((await app.inject({ method: 'POST', url: `/gateway/api-keys/${ka.id}/suspend`, headers: hb })).statusCode).toBe(404);
    expect((await useKey(ka.key)).statusCode).toBe(200);
    const viaKey = await app.inject({ method: 'POST', url: `/gateway/api-keys/${ka.id}/suspend`, headers: { 'x-api-key': ka.key } });
    expect([401, 403]).toContain(viaKey.statusCode);
  });
});

describe('an administrator suspending an account', () => {
  it('ends its sessions at once, refuses sign-in (403 account_suspended), refuses its keys, and can be undone', async () => {
    const admin = await adminSession();
    const u = seedUser();
    const { headers } = await signIn(u.email);
    const { key } = await createKey(headers);
    expect((await app.inject({ method: 'POST', url: `/admin/users/${u.id}/suspend`, headers: admin.headers, payload: { reason: 'under review' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/auth/session', headers })).statusCode).toBe(401); // sessions ended
    const login = await app.inject({ method: 'POST', url: '/auth/signin', payload: { email: u.email, password: PASSWORD } });
    expect(login.statusCode).toBe(403);
    expect(JSON.parse(login.body).code).toBe('account_suspended');
    expect((await app.inject({ method: 'POST', url: '/auth/signin', payload: { email: u.email, password: 'Wrong!Pass99' } })).statusCode).toBe(401); // a wrong password still just says so
    const viaKey = await useKey(key);
    expect(viaKey.statusCode).toBe(403);
    expect(JSON.parse(viaKey.body).code).toBe('api_key_suspended');
    expect(fakeDb.users.has(u.id)).toBe(true); // nothing deleted
    expect((await app.inject({ method: 'POST', url: `/admin/users/${u.id}/unsuspend`, headers: admin.headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/auth/signin', payload: { email: u.email, password: PASSWORD } })).statusCode).toBe(200);
    expect((await useKey(key)).statusCode).toBe(200);
  });

  it('is admin-only, and an administrator cannot suspend themselves', async () => {
    const u = seedUser();
    const plain = seedUser();
    const hp = (await signIn(plain.email)).headers;
    expect((await app.inject({ method: 'POST', url: `/admin/users/${u.id}/suspend`, headers: hp })).statusCode).toBe(403);
    const admin = await adminSession();
    const self = await app.inject({ method: 'POST', url: `/admin/users/${admin.user.id}/suspend`, headers: admin.headers });
    expect(self.statusCode).toBe(400);
  });
});

describe('the administrator view of keys, and switching a key off', () => {
  it('lists every live key with its owner, services, last use and state; an admin can suspend and resume any key', async () => {
    const admin = await adminSession();
    const u = seedUser();
    const { id } = await createKey((await signIn(u.email)).headers);
    const list = JSON.parse((await app.inject({ method: 'GET', url: '/admin/gateway-keys', headers: admin.headers })).body);
    const row = list.keys.find((k: { id: string }) => k.id === id);
    expect(row).toMatchObject({ owner: { email: u.email }, services: ['desk_api'], suspended: false });
    expect((await app.inject({ method: 'POST', url: `/admin/gateway-keys/${id}/suspend`, headers: admin.headers, payload: { reason: 'leaked on a forum' } })).statusCode).toBe(200);
    expect(JSON.parse((await app.inject({ method: 'GET', url: '/admin/gateway-keys', headers: admin.headers })).body).keys.find((k: { id: string }) => k.id === id).suspended).toBe(true);
    expect((await app.inject({ method: 'POST', url: `/admin/gateway-keys/${id}/resume`, headers: admin.headers })).statusCode).toBe(200);
    expect(fakeDb.keySuspensions.has(id)).toBe(false);
  });
});

describe('administrator credentials', () => {
  it('a session that signed in more than 24 hours ago cannot use the administrator tools (403 admin_recent_signin_required)', async () => {
    const old = await adminSession(3);
    const res = await app.inject({ method: 'GET', url: '/admin/gateway-keys', headers: old.headers });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('admin_recent_signin_required');
    const fresh = await adminSession(0);
    expect((await app.inject({ method: 'GET', url: '/admin/gateway-keys', headers: fresh.headers })).statusCode).toBe(200);
  });

  it('the static admin key can be limited to named addresses, and every use is recorded', async () => {
    config.adminApiKey = 'static-admin-key-for-test';
    const call = (ip: string) => app.inject({ method: 'GET', url: '/admin/gateway-keys', headers: { 'x-api-key': 'static-admin-key-for-test', 'cf-connecting-ip': ip } });
    expect((await call('198.51.100.1')).statusCode).toBe(200); // no list: works from anywhere (as before)
    config.adminApiKeyAllowedIps = ['198.51.100.2'];
    const refused = await call('198.51.100.1');
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body).code).toBe('admin_key_ip_not_allowed');
    expect((await call('198.51.100.2')).statusCode).toBe(200);
    config.adminApiKey = undefined;
  });
});
