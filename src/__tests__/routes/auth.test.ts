import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createFakeDb } from '../helpers/fake-db';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { pool } from '../../db';
import { buildApp } from '../../app';
import type { FastifyInstance } from 'fastify';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
});

const SIGNUP_BODY = { email: 'alice@example.com', password: 'Str0ng!Pass', firstName: 'Alice', lastName: 'Anderson' };

describe('POST /auth/signup', () => {
  it('creates an account and requires email confirmation before sign-in', async () => {
    const signup = await app.inject({ method: 'POST', url: '/auth/signup', payload: SIGNUP_BODY });
    expect(signup.statusCode).toBe(201);
    const signupBody = JSON.parse(signup.body);
    expect(signupBody.emailConfirmationRequired).toBe(true);
    expect(signupBody.user.email).toBe('alice@example.com');

    const signinBeforeConfirm = await app.inject({
      method: 'POST',
      url: '/auth/signin',
      payload: { email: SIGNUP_BODY.email, password: SIGNUP_BODY.password },
    });
    expect(signinBeforeConfirm.statusCode).toBe(403);
  });

  it('rejects a duplicate signup with 409', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: SIGNUP_BODY });
    expect(res.statusCode).toBe(409);
  });

  it('rejects a weak password with a 400 RFC 7807 body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: 'weak@example.com', password: 'weak', firstName: 'W', lastName: 'K' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.title).toBeDefined();
    expect(body.status).toBe(400);
    expect(body.error).toBeDefined(); // Flutter-compat extension field
  });
});

describe('email confirmation -> signin -> session -> signout', () => {
  it('confirms the email, then signs in, then reads /auth/session, then signs out', async () => {
    const token = [...fakeDb.emailConfirmationTokens.values()].find(
      (t) => t.user_id === [...fakeDb.users.values()].find((u) => u.email === SIGNUP_BODY.email)?.id,
    )?.token as string;
    expect(token).toBeTruthy();

    const confirm = await app.inject({ method: 'POST', url: '/auth/email-confirmation/confirm', payload: { token } });
    expect(confirm.statusCode).toBe(200);

    const signin = await app.inject({
      method: 'POST',
      url: '/auth/signin',
      payload: { email: SIGNUP_BODY.email, password: SIGNUP_BODY.password },
    });
    expect(signin.statusCode).toBe(200);
    const sessionToken = JSON.parse(signin.body).token as string;
    expect(sessionToken).toBeTruthy();

    const session = await app.inject({ method: 'GET', url: '/auth/session', headers: { authorization: `Bearer ${sessionToken}` } });
    expect(session.statusCode).toBe(200);
    expect(JSON.parse(session.body).user.email).toBe(SIGNUP_BODY.email);

    const signout = await app.inject({ method: 'POST', url: '/auth/signout', headers: { authorization: `Bearer ${sessionToken}` } });
    expect(signout.statusCode).toBe(200);

    const sessionAfterSignout = await app.inject({ method: 'GET', url: '/auth/session', headers: { authorization: `Bearer ${sessionToken}` } });
    expect(sessionAfterSignout.statusCode).toBe(401);
  });
});

describe('enumeration-safety', () => {
  it('POST /auth/password-reset/request returns identical 200 {ok:true} for a registered and an unregistered email', async () => {
    const registered = await app.inject({ method: 'POST', url: '/auth/password-reset/request', payload: { email: SIGNUP_BODY.email } });
    const unregistered = await app.inject({ method: 'POST', url: '/auth/password-reset/request', payload: { email: 'nobody@example.com' } });
    expect(registered.statusCode).toBe(200);
    expect(unregistered.statusCode).toBe(200);
    expect(JSON.parse(registered.body)).toEqual(JSON.parse(unregistered.body));
  });

  it('POST /auth/email-confirmation/request returns identical 200 {ok:true} for a registered and an unregistered email', async () => {
    const registered = await app.inject({ method: 'POST', url: '/auth/email-confirmation/request', payload: { email: SIGNUP_BODY.email } });
    const unregistered = await app.inject({ method: 'POST', url: '/auth/email-confirmation/request', payload: { email: 'nobody@example.com' } });
    expect(registered.statusCode).toBe(200);
    expect(unregistered.statusCode).toBe(200);
    expect(JSON.parse(registered.body)).toEqual(JSON.parse(unregistered.body));
  });

  it('POST /auth/signin returns identical 401 body for a wrong password and a nonexistent email', async () => {
    const wrongPassword = await app.inject({ method: 'POST', url: '/auth/signin', payload: { email: SIGNUP_BODY.email, password: 'WrongPass1!' } });
    const nonexistent = await app.inject({ method: 'POST', url: '/auth/signin', payload: { email: 'nobody@example.com', password: 'WrongPass1!' } });
    expect(wrongPassword.statusCode).toBe(401);
    expect(nonexistent.statusCode).toBe(401);
    expect(JSON.parse(wrongPassword.body)).toEqual(JSON.parse(nonexistent.body));
  });
});

describe('/v1 prefix routing', () => {
  it('serves POST /auth/signin also under /v1/auth/signin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signin',
      payload: { email: SIGNUP_BODY.email, password: SIGNUP_BODY.password },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('/health and /metrics', () => {
  it('GET /health/live always returns 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /metrics returns Prometheus text format', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
  });
});
