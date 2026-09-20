// Changing the password and deleting the account both need the CURRENT password, so a stolen session alone cannot do
// either. Wrong guesses count towards the same lock-out as sign-in.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));
vi.mock('../../infrastructure/email/resend', async () => (await import('../helpers/email-capture')).emailModuleMock());

import { buildApp } from '../../app';
import { pool } from '../../db';
import { emailed } from '../helpers/email-capture';
import { hashPassword } from '../../domain/auth/password';
import { resetSigninThrottleForTests } from '../../middleware/signin-throttle';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let hash: string;
const PASSWORD = 'Str0ng!Pass1';
let n = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeDb = pool as any;

beforeAll(async () => {
  app = await buildApp();
  hash = await hashPassword(PASSWORD);
}, 30_000);
beforeEach(() => { resetSigninThrottleForTests(); emailed.security.clear(); });

function seedUser() {
  n += 1;
  const id = `acct-${n}`;
  const now = new Date().toISOString();
  fakeDb.users.set(id, { id, email: `${id}@example.com`, password_hash: hash, first_name: 'A', last_name: 'C', email_confirmed_at: now, created_at: now, updated_at: now });
  return { id, email: `${id}@example.com` };
}
async function signedIn(email: string, ip = '203.0.113.7') {
  const res = await app.inject({ method: 'POST', url: '/auth/signin', headers: { 'cf-connecting-ip': ip }, payload: { email, password: PASSWORD } });
  return { authorization: `Bearer ${JSON.parse(res.body).token}`, 'cf-connecting-ip': ip };
}

describe('password change needs the current password', () => {
  it('is refused with 403 and a code when the current password is wrong or missing, and nothing changes', async () => {
    const u = seedUser();
    const h = await signedIn(u.email);
    const wrong = await app.inject({ method: 'POST', url: '/auth/password', headers: h, payload: { currentPassword: 'Wrong!Pass99', password: 'N3w!Password9' } });
    expect(wrong.statusCode).toBe(403);
    expect(JSON.parse(wrong.body).code).toBe('current_password_incorrect');
    const missing = await app.inject({ method: 'POST', url: '/auth/password', headers: h, payload: { password: 'N3w!Password9' } });
    expect(missing.statusCode).toBe(400);
    // still signed in (a 403, not a 401) and the old password still works
    expect((await app.inject({ method: 'GET', url: '/auth/session', headers: h })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/auth/signin', payload: { email: u.email, password: PASSWORD } })).statusCode).toBe(200);
  });

  it('works with the right current password', async () => {
    const u = seedUser();
    const h = await signedIn(u.email);
    const ok = await app.inject({ method: 'POST', url: '/auth/password', headers: h, payload: { currentPassword: PASSWORD, password: 'N3w!Password9' } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/auth/signin', payload: { email: u.email, password: 'N3w!Password9' } })).statusCode).toBe(200);
  });

  it('repeated wrong guesses lock the account out of guessing (same lock-out as sign-in)', async () => {
    const u = seedUser();
    const h = await signedIn(u.email);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await app.inject({ method: 'POST', url: '/auth/password', headers: h, payload: { currentPassword: `Wrong!Pass${i}`, password: 'N3w!Password9' } })).statusCode;
    expect(last).toBe(429);
    const locked = await app.inject({ method: 'POST', url: '/auth/password', headers: h, payload: { currentPassword: PASSWORD, password: 'N3w!Password9' } });
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['retry-after']).toBeDefined();
  });
});

describe('POST /auth/account/delete', () => {
  it('needs a session and the password; a wrong password deletes nothing', async () => {
    const u = seedUser();
    expect((await app.inject({ method: 'POST', url: '/auth/account/delete', payload: { password: PASSWORD } })).statusCode).toBe(401);
    const h = await signedIn(u.email);
    const wrong = await app.inject({ method: 'POST', url: '/auth/account/delete', headers: h, payload: { password: 'Wrong!Pass99' } });
    expect(wrong.statusCode).toBe(403);
    expect(fakeDb.users.has(u.id)).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/auth/account/delete', headers: h, payload: {} })).statusCode).toBe(400);
  });

  it('deletes the account and its sessions, emails the owner, and the old session stops working', async () => {
    const u = seedUser();
    const h = await signedIn(u.email);
    const other = await signedIn(u.email, '203.0.113.8');
    const res = await app.inject({ method: 'POST', url: '/auth/account/delete', headers: h, payload: { password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(fakeDb.users.has(u.id)).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/auth/session', headers: h })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/auth/session', headers: other })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/auth/signin', payload: { email: u.email, password: PASSWORD } })).statusCode).toBe(401);
    await new Promise((r) => setTimeout(r, 20));
    expect(fakeDb.securityEvents.filter((e: { user_id: string }) => e.user_id === u.id)).toEqual([]); // their stored events went with them
    expect(emailed.security.get(u.email)).toContain('Your Desk account was deleted');
  });
});
