// Requests that change data must come from a trusted origin (the app, or this site itself).
import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { createFakeDb } from '../helpers/fake-db';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { pool } from '../../db';
import { buildApp } from '../../app';
import { isAllowedOrigin } from '../../middleware/origin-check';
import type { FastifyInstance } from 'fastify';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;
let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  app = await buildApp();
  const now = new Date().toISOString();
  fakeDb.users.set('origin-user', {
    id: 'origin-user', email: 'origin@example.com', password_hash: 'x', first_name: 'O', last_name: 'C',
    email_confirmed_at: now, created_at: now, updated_at: now,
  });
  fakeDb.sessions.set('origin-token', {
    id: 's1', user_id: 'origin-user', token: 'origin-token', expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now,
  });
  cookie = 'desk_session=origin-token';
});

const createDraft = (headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/setup/drafts', headers: { cookie, host: 'api.deskbusiness.co', ...headers } });
const draftCount = () => fakeDb.drafts.size;

describe('cookie-authenticated writes', () => {
  it('are refused from a foreign site, and nothing is created', async () => {
    const before = draftCount();
    const res = await createDraft({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    expect(draftCount()).toBe(before);
  });

  it('are refused from look-alike origins, "null", and other schemes', async () => {
    for (const origin of ['null', 'https://app.deskbusiness.co.evil.example', 'https://evilapp.deskbusiness.co', 'http://app.deskbusiness.co', 'https://oracle.deskbusiness.co']) {
      expect((await createDraft({ origin })).statusCode, origin).toBe(403);
    }
  });

  it('are allowed from the app', async () => {
    expect((await createDraft({ origin: 'https://app.deskbusiness.co', 'sec-fetch-site': 'same-site' })).statusCode).toBe(201);
  });

  it('are allowed from this site itself (the API Library pages)', async () => {
    expect((await createDraft({ origin: 'https://api.deskbusiness.co', 'sec-fetch-site': 'same-origin' })).statusCode).toBe(201);
  });

  it('are allowed with no Origin at all (servers and native apps)', async () => {
    expect((await createDraft()).statusCode).toBe(201);
  });

  it('are refused with no Origin when the browser says the request is cross-site', async () => {
    expect((await createDraft({ 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
  });
});

describe('what is not affected', () => {
  it('reads (GET) from any origin still work; CORS decides what a page may read', async () => {
    const res = await app.inject({ method: 'GET', url: '/setup/drafts', headers: { cookie, origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('a bearer-token write from a foreign origin is refused too', async () => {
    const res = await app.inject({ method: 'POST', url: '/setup/drafts', headers: { authorization: 'Bearer origin-token', origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(403);
  });

  it('sign-in from a foreign origin is refused (login CSRF)', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/signin', headers: { origin: 'https://evil.example' }, payload: { email: 'a@example.com', password: 'x' } });
    expect(res.statusCode).toBe(403);
  });

  it('CORS preflight from the app still succeeds', async () => {
    const res = await app.inject({ method: 'OPTIONS', url: '/setup/drafts', headers: { origin: 'https://app.deskbusiness.co', 'access-control-request-method': 'POST' } });
    expect(res.statusCode).toBe(204);
  });
});

describe('isAllowedOrigin', () => {
  const allowed = ['https://app.deskbusiness.co'];
  it.each([
    ['https://app.deskbusiness.co', 'api.deskbusiness.co', true],
    ['https://api.deskbusiness.co', 'api.deskbusiness.co', true],
    ['https://evil.example', 'api.deskbusiness.co', false],
    ['null', 'api.deskbusiness.co', false],
    ['https://api.deskbusiness.co', undefined, false],
    ['not a url', 'api.deskbusiness.co', false],
  ])('%s with host %s -> %s', (origin, host, expected) => {
    expect(isAllowedOrigin(origin, host, allowed)).toBe(expected);
  });
});
