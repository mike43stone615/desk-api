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
    // Response body is intentionally generic (no `user` object) — see the
    // next test — so this only checks the account was actually created via
    // its real, separate effect: signing in is blocked until confirmed.

    const signinBeforeConfirm = await app.inject({
      method: 'POST',
      url: '/auth/signin',
      payload: { email: SIGNUP_BODY.email, password: SIGNUP_BODY.password },
    });
    expect(signinBeforeConfirm.statusCode).toBe(403);
  });

  it('responds identically to a duplicate signup as to a new one (enumeration-safe)', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: SIGNUP_BODY });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      ok: true,
      emailConfirmationRequired: true,
      message: 'If that email is not already registered, a confirmation link has been sent. Check your inbox before signing in.',
    });
    // No second account was actually created — still exactly the one user.
    expect(fakeDb.users.size).toBe(1);
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

  it('rejects an oversized password with a 400 instead of hashing it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: 'huge-pw@example.com',
        password: 'A1!' + 'a'.repeat(1_000_000),
        firstName: 'H',
        lastName: 'P',
      },
    });
    expect(res.statusCode).toBe(400);
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

describe('httpOnly session cookie (what web_app relies on instead of storing the token itself)', () => {
  async function signUpConfirmAndSignIn(email: string) {
    await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: 'Str0ng!Pass', firstName: 'Cookie', lastName: 'Tester' },
    });
    const token = [...fakeDb.emailConfirmationTokens.values()].find(
      (t) => t.user_id === [...fakeDb.users.values()].find((u) => u.email === email)?.id,
    )?.token as string;
    await app.inject({ method: 'POST', url: '/auth/email-confirmation/confirm', payload: { token } });
    return app.inject({ method: 'POST', url: '/auth/signin', payload: { email, password: 'Str0ng!Pass' } });
  }

  it('a successful sign-in sets an httpOnly, Secure, SameSite=Lax cookie carrying the same token as the response body', async () => {
    const signin = await signUpConfirmAndSignIn('cookie-set@example.com');
    expect(signin.statusCode).toBe(200);

    const setCookie = signin.cookies.find((c) => c.name === 'desk_session');
    expect(setCookie).toBeTruthy();
    expect(setCookie!.httpOnly).toBe(true);
    expect(setCookie!.secure).toBe(true);
    expect(setCookie!.sameSite).toBe('Lax');
    expect(setCookie!.path).toBe('/');
    expect(setCookie!.value).toBe(JSON.parse(signin.body).token);
  });

  it('/auth/session authenticates from the cookie alone, with no Authorization header at all', async () => {
    const signin = await signUpConfirmAndSignIn('cookie-only@example.com');
    const sessionToken = JSON.parse(signin.body).token as string;

    const session = await app.inject({
      method: 'GET',
      url: '/auth/session',
      cookies: { desk_session: sessionToken },
    });
    expect(session.statusCode).toBe(200);
    expect(JSON.parse(session.body).user.email).toBe('cookie-only@example.com');
  });

  it('the Authorization header wins over a stale/mismatched cookie when both are present', async () => {
    const signinA = await signUpConfirmAndSignIn('header-priority-a@example.com');
    const tokenA = JSON.parse(signinA.body).token as string;
    const signinB = await signUpConfirmAndSignIn('header-priority-b@example.com');
    const tokenB = JSON.parse(signinB.body).token as string;

    const session = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { authorization: `Bearer ${tokenA}` },
      cookies: { desk_session: tokenB },
    });
    expect(session.statusCode).toBe(200);
    expect(JSON.parse(session.body).user.email).toBe('header-priority-a@example.com');
  });

  it('/auth/signout clears the cookie and revokes the session it names, even when called with no Authorization header', async () => {
    const signin = await signUpConfirmAndSignIn('cookie-signout@example.com');
    const sessionToken = JSON.parse(signin.body).token as string;

    const signout = await app.inject({
      method: 'POST',
      url: '/auth/signout',
      cookies: { desk_session: sessionToken },
    });
    expect(signout.statusCode).toBe(200);
    const clearedCookie = signout.cookies.find((c) => c.name === 'desk_session');
    expect(clearedCookie).toBeTruthy();
    expect(Number(clearedCookie!.maxAge)).toBeLessThanOrEqual(0);

    const sessionAfter = await app.inject({
      method: 'GET',
      url: '/auth/session',
      cookies: { desk_session: sessionToken },
    });
    expect(sessionAfter.statusCode).toBe(401);
  });

  it('a request with neither a header nor a cookie is unauthenticated', async () => {
    const session = await app.inject({ method: 'GET', url: '/auth/session' });
    expect(session.statusCode).toBe(401);
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

  it('GET /metrics requires the configured x-api-key and returns Prometheus text format when given it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-api-key': 'test-metrics-docs-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
  });

  it('GET /metrics rejects a missing or wrong x-api-key with 401', async () => {
    const noKey = await app.inject({ method: 'GET', url: '/metrics' });
    expect(noKey.statusCode).toBe(401);
    const wrongKey = await app.inject({ method: 'GET', url: '/metrics', headers: { 'x-api-key': 'wrong' } });
    expect(wrongKey.statusCode).toBe(401);
  });

  it('GET /docs rejects a missing x-api-key with 401 and allows the correct one', async () => {
    const noKey = await app.inject({ method: 'GET', url: '/docs' });
    expect(noKey.statusCode).toBe(401);
    const withKey = await app.inject({ method: 'GET', url: '/docs', headers: { 'x-api-key': 'test-metrics-docs-key' } });
    expect(withKey.statusCode).toBe(200);
  });

  it('sets baseline security headers on every response, including the 401 above', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' });
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    // Explicitly not set: /docs is the one HTML surface here and loads the
    // Swagger UI bundle from unpkg.com by design - a default CSP would block it.
    expect(res.headers['content-security-policy']).toBeUndefined();
  });
});

describe('POST /auth/password ends the user\'s other sessions', () => {
  async function confirmedUser(email: string) {
    await app.inject({ method: 'POST', url: '/auth/signup', payload: { email, password: 'Str0ng!Pass', firstName: 'P', lastName: 'W' } });
    const user = [...fakeDb.users.values()].find((u) => u.email === email)!;
    const token = [...fakeDb.emailConfirmationTokens.values()].find((t) => t.user_id === user.id)?.token as string;
    await app.inject({ method: 'POST', url: '/auth/email-confirmation/confirm', payload: { token } });
    const signIn = async () =>
      JSON.parse((await app.inject({ method: 'POST', url: '/auth/signin', payload: { email, password: 'Str0ng!Pass' } })).body).token as string;
    return { first: await signIn(), second: await signIn() };
  }
  const me = (token: string) => app.inject({ method: 'GET', url: '/auth/session', headers: { authorization: `Bearer ${token}` } });

  it('the session that changes the password stays signed in; every other session is signed out', async () => {
    const { first, second } = await confirmedUser('pwchange@example.com');
    const res = await app.inject({ method: 'POST', url: '/auth/password', headers: { authorization: `Bearer ${first}` }, payload: { password: 'N3w!Password' } });
    expect(res.statusCode).toBe(200);
    expect((await me(first)).statusCode).toBe(200);
    expect((await me(second)).statusCode).toBe(401);
  });

  it('works the same when the change is made with the browser cookie', async () => {
    const { first, second } = await confirmedUser('pwcookie@example.com');
    const res = await app.inject({ method: 'POST', url: '/auth/password', cookies: { desk_session: first }, payload: { password: 'N3w!Password' } });
    expect(res.statusCode).toBe(200);
    expect((await me(first)).statusCode).toBe(200);
    expect((await me(second)).statusCode).toBe(401);
  });
});

describe('tokens are stored hashed, never as the value that grants access', () => {
  it('a session token is stored as sha256:<hex>, and the plain token is not anywhere in the table', async () => {
    const email = 'hashed@example.com';
    await app.inject({ method: 'POST', url: '/auth/signup', payload: { email, password: 'Str0ng!Pass', firstName: 'H', lastName: 'A' } });
    const user = [...fakeDb.users.values()].find((u) => u.email === email)!;
    const confirm = [...fakeDb.emailConfirmationTokens.values()].find((t) => t.user_id === user.id)!;
    expect(String(confirm.token)).toMatch(/^sha256:[0-9a-f]{64}$/);

    fakeDb.users.get(String(user.id))!.email_confirmed_at = new Date().toISOString();
    const signin = await app.inject({ method: 'POST', url: '/auth/signin', payload: { email, password: 'Str0ng!Pass' } });
    const token = JSON.parse(signin.body).token as string;
    const stored = [...fakeDb.sessions.keys()];
    expect(stored).not.toContain(token);
    expect(stored.filter((k) => k.startsWith('sha256:')).length).toBeGreaterThan(0);
    expect((await app.inject({ method: 'GET', url: '/auth/session', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
  });
});
