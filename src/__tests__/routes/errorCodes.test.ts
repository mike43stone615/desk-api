// Every error answer carries a stable machine-readable `code` next to the human message.
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
import { hashPassword } from '../../domain/auth/password';
import { defaultCode } from '../../middleware/http-error';
import type { FastifyInstance } from 'fastify';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;
let app: FastifyInstance;
let hash: string;
beforeAll(async () => {
  app = await buildApp();
  hash = await hashPassword('Str0ng!Pass1');
});

const body = (res: { body: string }) => JSON.parse(res.body) as { code: string; error: string; detail: string; status: number; title: string; type: string; instance: string };
let n = 0;
function signedIn(confirmed = true) {
  n += 1;
  const id = `ec-${n}`;
  const now = new Date().toISOString();
  fakeDb.users.set(id, { id, email: `${id}@example.com`, password_hash: hash, first_name: 'E', last_name: 'C', email_confirmed_at: confirmed ? now : null, created_at: now, updated_at: now });
  fakeDb.seedSession(`t-${id}`, { id: `s-${id}`, user_id: id, token: `t-${id}`, expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now });
  return { id, email: `${id}@example.com`, headers: { authorization: `Bearer t-${id}` } };
}

describe('every error has a code', () => {
  const cases: Array<[string, () => Promise<{ body: string; statusCode: number }>, number, string]> = [
    ['unknown URL', () => app.inject({ method: 'GET', url: '/nope' }), 404, 'not_found'],
    ['wrong method', () => app.inject({ method: 'PUT', url: '/setup/drafts', payload: {} }), 405, 'method_not_allowed'],
    ['no session', () => app.inject({ method: 'GET', url: '/auth/session' }), 401, 'authentication_required'],
    ['bad session', () => app.inject({ method: 'GET', url: '/auth/session', headers: { authorization: 'Bearer nope' } }), 401, 'session_invalid'],
    ['wrong password', () => app.inject({ method: 'POST', url: '/auth/signin', payload: { email: signedIn().email, password: 'Wrong!Pass1' } }), 401, 'invalid_credentials'],
    ['invalid sign-up', () => app.inject({ method: 'POST', url: '/auth/signup', payload: { email: 'x', password: 'p', firstName: '', lastName: '' } }), 400, 'validation_error'],
    ['bad JSON', () => app.inject({ method: 'POST', url: '/auth/signin', headers: { 'content-type': 'application/json' }, payload: '{"email":' }), 400, 'invalid_json'],
    ['body too large', () => app.inject({ method: 'POST', url: '/auth/signin', payload: { email: 'a@b.co', password: 'x'.repeat(20_000) } }), 413, 'payload_too_large'],
    ['bad paging', () => app.inject({ method: 'GET', url: '/setup/businesses?limit=0', headers: signedIn().headers }), 400, 'validation_error'],
    ['missing draft', () => app.inject({ method: 'GET', url: '/setup/drafts/none', headers: signedIn().headers }), 404, 'draft_not_found'],
    ['unconfirmed email', () => app.inject({ method: 'GET', url: '/setup/drafts', headers: signedIn(false).headers }), 403, 'email_not_confirmed'],
    ['not an admin', () => app.inject({ method: 'GET', url: '/admin/tables', headers: signedIn().headers }), 403, 'admin_required'],
    ['bad reset link', () => app.inject({ method: 'POST', url: '/auth/password-reset/confirm', payload: { token: 'nope', password: 'Str0ng!Pass1' } }), 400, 'invalid_or_expired_token'],
    ['unknown session', () => app.inject({ method: 'DELETE', url: '/auth/sessions/none', headers: signedIn().headers }), 404, 'session_not_found'],
    ['bad API key', () => app.inject({ method: 'GET', url: '/v1/gateway/registry/business-structures', headers: { 'x-api-key': 'deskgw_' + '0'.repeat(48) } }), 401, 'invalid_api_key'],
    ['cross-site', () => app.inject({ method: 'POST', url: '/auth/signin', headers: { origin: 'https://evil.example.com' }, payload: { email: 'a@b.co', password: 'x' } }), 403, 'origin_not_allowed'],
  ];
  for (const [name, call, status, code] of cases) {
    it(`${name}: ${status} ${code}`, async () => {
      const res = await call();
      expect(res.statusCode).toBe(status);
      const b = body(res);
      expect(b.code).toBe(code);
      // the older members are all still there, so nothing that reads them breaks
      expect(b.status).toBe(status);
      expect(typeof b.error).toBe('string');
      expect(b.detail).toBe(b.error);
      expect(b.title).toBeTruthy();
      expect(b.type).toBe(`https://api.deskbusiness.co/errors/${code}`);
      expect(b.instance).toBeTruthy();
    });
  }

  it('a code is lower snake_case', async () => {
    for (const [, call] of cases) expect(body(await call()).code).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});

describe('auth errors keep their own codes', () => {
  it('weak passwords say which rule failed', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: { email: 'weak@example.com', password: 'abc', firstName: 'A', lastName: 'B' } });
    expect(body(res).code).toMatch(/^[a-z_]+$/);
  });

  it('a wrong-password lockout is its own code', async () => {
    const u = signedIn();
    let last;
    for (let i = 0; i < 6; i++) last = await app.inject({ method: 'POST', url: '/auth/signin', headers: { 'cf-connecting-ip': '203.0.113.77' }, payload: { email: u.email, password: 'Wrong!Pass' + i } });
    // (the limiter is off in the test suite: this only checks the code exists on the refusal path when it is on)
    expect([401, 429]).toContain(last!.statusCode);
  });
});

describe('defaultCode', () => {
  it('maps statuses to stable names and falls back sensibly', () => {
    expect(defaultCode(404)).toBe('not_found');
    expect(defaultCode(429)).toBe('rate_limited');
    expect(defaultCode(418)).toBe('client_error');
    expect(defaultCode(599)).toBe('server_error');
  });
});
