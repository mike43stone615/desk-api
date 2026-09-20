// The person's own data export, the structured "request denied" record, and the admin reconcile report.
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
const lines: string[] = [];
let app: FastifyInstance;
let hash: string;
let n = 0;

beforeAll(async () => {
  app = await buildApp({ logStream: { write: (l: string) => lines.push(l) } });
  app.log.level = 'warn'; // the test environment logs errors only
  hash = await hashPassword(PASSWORD);
  config.gatewayKeyEncryptionSecret = 'ab'.repeat(32);
}, 30_000);
beforeEach(() => { resetSigninThrottleForTests(); config.rateLimitPerMinute = 120; lines.length = 0; });

function seedUser() {
  n += 1;
  const id = `exp2-${n}`;
  const now = new Date().toISOString();
  fakeDb.users.set(id, { id, email: `${id}@example.com`, password_hash: hash, first_name: 'Ex', last_name: 'Port', email_confirmed_at: now, created_at: now, updated_at: now });
  return { id, email: `${id}@example.com` };
}
async function session(email: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/signin', headers: { 'cf-connecting-ip': `203.0.113.${(n % 200) + 1}`, 'user-agent': 'TestBrowser/1' }, payload: { email, password: PASSWORD } });
  return { token: JSON.parse(res.body).token as string, headers: { authorization: `Bearer ${JSON.parse(res.body).token}` } };
}

describe('GET /auth/account/export', () => {
  it('returns the caller\'s own data as a downloadable file, and never a hash, token or key secret', async () => {
    const u = seedUser();
    const other = seedUser();
    const me = await session(u.email);
    await session(other.email);
    const draft = await app.inject({ method: 'POST', url: '/setup/drafts', headers: me.headers, payload: {} });
    await app.inject({ method: 'PATCH', url: `/setup/drafts/${JSON.parse(draft.body).id}`, headers: me.headers, payload: { draft: { businessName: 'My Bakery' } } });
    const key = await app.inject({ method: 'POST', url: '/gateway/api-keys', headers: me.headers, payload: { label: 'ci', services: ['desk_api'] } });
    const secretKey = JSON.parse(key.body).apiKey.key as string;

    const res = await app.inject({ method: 'GET', url: '/auth/account/export', headers: me.headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="desk-data-\d{4}-\d{2}-\d{2}\.json"$/);
    const b = JSON.parse(res.body);
    expect(b.account).toMatchObject({ id: u.id, email: u.email, firstName: 'Ex', lastName: 'Port' });
    expect(b.drafts[0].draft).toEqual({ businessName: 'My Bakery' });
    expect(b.apiKeys).toHaveLength(1);
    expect(b.apiKeys[0].label).toBe('ci');
    expect(b.sessions.length).toBeGreaterThanOrEqual(1);
    expect(b.securityEvents.some((e: { event: string }) => e.event === 'signin_success')).toBe(true);
    // nothing that is a credential, and nothing of anyone else's
    for (const secret of [hash, me.token, secretKey, PASSWORD]) expect(res.body).not.toContain(secret);
    expect(res.body).not.toContain(other.email);
    expect(res.body).not.toMatch(/password_hash|passwordHash|encrypted_backend_key/);
  });

  it('needs a session (401 without one)', async () => {
    expect((await app.inject({ method: 'GET', url: '/auth/account/export' })).statusCode).toBe(401);
  });
});

describe('refused requests are recorded as structured "request denied" lines', () => {
  it('says what kind of credential was presented, the route and the reason, and never the credential', async () => {
    const secret = 'sekret-token-value-1234567890abcdef';
    await app.inject({ method: 'GET', url: '/auth/session', headers: { authorization: `Bearer ${secret}`, 'cf-connecting-ip': '198.51.100.9' } });
    await app.inject({ method: 'GET', url: '/auth/session' });
    await new Promise((r) => setTimeout(r, 20));
    const denied = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((j) => j?.event === 'request_denied');
    expect(denied).toHaveLength(2);
    expect(denied[0]).toMatchObject({ status: 401, code: 'session_invalid', method: 'GET', route: '/auth/session', credential: 'bearer_token' });
    expect(denied[1]).toMatchObject({ status: 401, code: 'authentication_required', credential: 'none' });
    expect(lines.join('\n')).not.toContain(secret);
  });
});

describe('the admin reconcile report', () => {
  it('is empty before any run, then holds the result of a run and who asked for it', async () => {
    config.adminApiKey = 'admin-key-for-report-test';
    const h = { 'x-api-key': 'admin-key-for-report-test', 'cf-connecting-ip': '198.51.100.20' };
    const before = JSON.parse((await app.inject({ method: 'GET', url: '/admin/gateway-keys/reconcile', headers: h })).body);
    expect(before.last).toBeNull();
    const run = await app.inject({ method: 'POST', url: '/admin/gateway-keys/reconcile', headers: h });
    expect(run.statusCode).toBe(200);
    const after = JSON.parse((await app.inject({ method: 'GET', url: '/admin/gateway-keys/reconcile', headers: h })).body);
    expect(after.last.by).toBe('admin-api-key');
    expect(after.last.report).toHaveProperty('orphansRevoked');
    expect(Date.parse(after.last.at)).not.toBeNaN();
    config.adminApiKey = undefined;
  });
});
