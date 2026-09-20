// Password guessing is slowed down: repeated failures lock further attempts (even with the right password) for a
// while, without revealing whether an email is registered.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { createFakeDb } from '../helpers/fake-db';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { pool } from '../../db';
import { buildApp } from '../../app';
import { hashPassword } from '../../domain/auth/password';
import { resetSigninThrottleForTests } from '../../middleware/signin-throttle';
import type { FastifyInstance } from 'fastify';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;
const PASSWORD = 'Str0ng!Pass';
let app: FastifyInstance;
let passwordHash: string;
let counter = 0;

beforeAll(async () => {
  app = await buildApp();
  passwordHash = await hashPassword(PASSWORD);
});
beforeEach(() => {
  resetSigninThrottleForTests();
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => vi.useRealTimers());

function seedUser(confirmed = true) {
  counter += 1;
  const id = `throttle-user-${counter}`;
  const email = `throttle${counter}@example.com`;
  const now = new Date().toISOString();
  fakeDb.users.set(id, {
    id, email, password_hash: passwordHash, first_name: 'T', last_name: 'U',
    email_confirmed_at: confirmed ? now : null, created_at: now, updated_at: now,
  });
  return email;
}

const signIn = (email: string, password: string, ip = '203.0.113.1') =>
  app.inject({ method: 'POST', url: '/auth/signin', headers: { 'cf-connecting-ip': ip }, payload: { email, password } });

describe('repeated failures for one account from one address', () => {
  it('locks after 5 wrong passwords, even for the right password, then says how long to wait', async () => {
    const email = seedUser();
    for (let i = 0; i < 5; i++) expect((await signIn(email, 'Wrong!Pass1')).statusCode).toBe(401);
    const locked = await signIn(email, PASSWORD);
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['retry-after']).toBe('900');
    expect(locked.headers['content-type']).toMatch(/problem\+json/);
    expect(JSON.parse(locked.body).detail).toMatch(/Too many failed sign-in attempts/);
    expect((await signIn(email, PASSWORD)).statusCode).toBe(429);
  });

  it('lets the right password in again once the lockout has passed', async () => {
    const email = seedUser();
    for (let i = 0; i < 5; i++) await signIn(email, 'Wrong!Pass1');
    expect((await signIn(email, PASSWORD)).statusCode).toBe(429);
    vi.setSystemTime(Date.now() + 15 * 60_000 + 1000);
    expect((await signIn(email, PASSWORD)).statusCode).toBe(200);
  });

  it('a correct sign-in clears the count, so four wrong guesses do not add up across it', async () => {
    const email = seedUser();
    for (let i = 0; i < 4; i++) await signIn(email, 'Wrong!Pass1');
    expect((await signIn(email, PASSWORD)).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) expect((await signIn(email, 'Wrong!Pass1')).statusCode).toBe(401);
    expect((await signIn(email, PASSWORD)).statusCode).toBe(200);
  });

  it('does not lock other accounts, or the same account from another address', async () => {
    const victim = seedUser();
    const other = seedUser();
    for (let i = 0; i < 5; i++) await signIn(victim, 'Wrong!Pass1', '203.0.113.9');
    expect((await signIn(victim, PASSWORD, '203.0.113.9')).statusCode).toBe(429);
    expect((await signIn(other, PASSWORD, '203.0.113.9')).statusCode).toBe(200);
    expect((await signIn(victim, PASSWORD, '198.51.100.7')).statusCode).toBe(200);
  });
});

describe('the answer does not reveal whether an email is registered', () => {
  it('an unknown email locks in exactly the same way as a real one', async () => {
    const real = seedUser();
    const ghost = 'nobody-here@example.com';
    for (let i = 0; i < 5; i++) {
      await signIn(real, 'Wrong!Pass1');
      await signIn(ghost, 'Wrong!Pass1');
    }
    const a = await signIn(real, 'Wrong!Pass1');
    const b = await signIn(ghost, 'Wrong!Pass1');
    expect(a.statusCode).toBe(429);
    expect(b.statusCode).toBe(429);
    expect(a.headers['retry-after']).toBe(b.headers['retry-after']);
    expect(JSON.parse(a.body).detail).toBe(JSON.parse(b.body).detail);
  });

  it('a valid password on an unconfirmed account is not counted as a failure', async () => {
    const email = seedUser(false);
    for (let i = 0; i < 10; i++) expect((await signIn(email, PASSWORD)).statusCode).toBe(403);
  });
});

describe('guessing spread over many addresses or many accounts', () => {
  it('30 failures against one account from 30 different addresses lock that account for everyone', async () => {
    const email = seedUser();
    for (let i = 0; i < 30; i++) await signIn(email, 'Wrong!Pass1', `192.0.2.${i + 1}`);
    expect((await signIn(email, PASSWORD, '198.51.100.99')).statusCode).toBe(429);
  }, 60_000);

  it('30 failures from one address across different accounts lock that address', async () => {
    for (let i = 0; i < 30; i++) await signIn(`spray${i}@example.com`, 'Wrong!Pass1', '198.51.100.50');
    const email = seedUser();
    expect((await signIn(email, PASSWORD, '198.51.100.50')).statusCode).toBe(429);
    expect((await signIn(email, PASSWORD, '198.51.100.51')).statusCode).toBe(200);
  }, 60_000);
});
