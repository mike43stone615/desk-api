// Every free-text field and request body has a ceiling, so nothing can push megabytes through the password hasher, into
// a database column or into an outgoing email.
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
import type { FastifyInstance } from 'fastify';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;
let app: FastifyInstance;
let headers: Record<string, string>;
let businessId: string;

beforeAll(async () => {
  app = await buildApp();
  const now = new Date().toISOString();
  fakeDb.users.set('fl-user', {
    id: 'fl-user', email: 'fl@example.com', password_hash: 'x', first_name: 'F', last_name: 'L',
    email_confirmed_at: now, created_at: now, updated_at: now,
  });
  fakeDb.seedSession('fl-token', { id: 'fl-s', user_id: 'fl-user', token: 'fl-token', expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now });
  headers = { authorization: 'Bearer fl-token' };
  businessId = 'fl-biz';
  fakeDb.businesses.set(businessId, { id: businessId, user_id: 'fl-user', name: 'Biz', industry: null, business_json: '{}', created_at: now, updated_at: now });
  fakeDb.memberships.set('fl-m', { id: 'fl-m', business_id: businessId, user_id: 'fl-user', role: 'owner', accepted_at: now, created_at: now, updated_at: now });
});

const msg = (res: { body: string }) => String(JSON.parse(res.body).detail);
const post = (url: string, payload: unknown, h: Record<string, string> = {}) => app.inject({ method: 'POST', url, headers: h, payload: payload as object });

describe('account fields', () => {
  const good = { email: 'new@example.com', password: 'Str0ng!Pass', firstName: 'Ada', lastName: 'Lovelace' };

  it('sign-up refuses an over-long email, first name or last name, but accepts exactly the maximum', async () => {
    const longEmail = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(58)}.com`; // 255 characters
    expect(longEmail.length).toBe(255);
    for (const bad of [{ email: longEmail }, { firstName: 'x'.repeat(101) }, { lastName: 'x'.repeat(101) }]) {
      const res = await post('/auth/signup', { ...good, ...bad });
      expect(res.statusCode, JSON.stringify(Object.keys(bad))).toBe(400);
      expect(msg(res)).toMatch(/at most/);
    }
    const ok = await post('/auth/signup', { ...good, firstName: 'x'.repeat(100), lastName: 'y'.repeat(100) });
    expect(ok.statusCode).toBe(201);
  });

  it('sign-in, resend and reset refuse an over-long email before doing any work', async () => {
    const long = `${'a'.repeat(300)}@example.com`;
    for (const url of ['/auth/signin', '/auth/email-confirmation/request', '/auth/password-reset/request']) {
      const res = await post(url, { email: long, password: 'whatever' });
      expect(res.statusCode, url).toBe(400);
      expect(msg(res)).toMatch(/at most 254/);
    }
  });

  it('confirmation and reset tokens longer than any real token are refused', async () => {
    const t = 'x'.repeat(201);
    expect((await post('/auth/email-confirmation/confirm', { token: t })).statusCode).toBe(400);
    expect((await post('/auth/password-reset/confirm', { token: t, password: 'Str0ng!Pass1' })).statusCode).toBe(400);
  });
});

describe('business fields', () => {
  it('a draft with a business name over 200 characters or an industry over 100 is refused; the maximum is accepted', async () => {
    const draft = (await post('/setup/drafts', {}, headers)).body;
    const id = JSON.parse(draft).id as string;
    const patch = (body: unknown) => app.inject({ method: 'PATCH', url: `/setup/drafts/${id}`, headers, payload: body as object });

    const tooLongName = await patch({ draft: { businessName: 'n'.repeat(201) } });
    expect(tooLongName.statusCode).toBe(400);
    expect(msg(tooLongName)).toBe('businessName must be at most 200 characters.');
    const tooLongIndustry = await patch({ draft: { industry: 'i'.repeat(101) } });
    expect(tooLongIndustry.statusCode).toBe(400);
    expect(msg(tooLongIndustry)).toBe('industry must be at most 100 characters.');
    expect((await patch({ draft: { businessName: 'n'.repeat(200), industry: 'i'.repeat(100) } })).statusCode).toBe(200);
    expect((await patch({ draft: { businessName: 42 } })).statusCode).toBe(200); // other types are left to the existing rules
  });

  it('finishing a draft that already holds an over-long name (saved before the limit) is refused clearly', async () => {
    const now = new Date().toISOString();
    fakeDb.drafts.set('old-draft', { id: 'old-draft', user_id: 'fl-user', draft_json: JSON.stringify({ businessName: 'n'.repeat(500) }), created_at: now, updated_at: now });
    const res = await post('/setup/drafts/old-draft/complete', {}, headers);
    expect(res.statusCode).toBe(400);
    expect(msg(res)).toBe('Business name must be at most 200 characters.');
    fakeDb.drafts.set('old-draft2', { id: 'old-draft2', user_id: 'fl-user', draft_json: JSON.stringify({ businessName: 'ok', industry: 'i'.repeat(300) }), created_at: now, updated_at: now });
    expect(msg(await post('/setup/drafts/old-draft2/complete', {}, headers))).toBe('Industry must be at most 100 characters.');
  });

  it('an invitation to an over-long email says so', async () => {
    const res = await post(`/setup/businesses/${businessId}/members`, { email: `${'a'.repeat(300)}@example.com` }, headers);
    expect(res.statusCode).toBe(400);
    expect(msg(res)).toMatch(/at most 254/);
  });
});

describe('request body size', () => {
  const big = (bytes: number) => ({ email: 'a@example.com', password: 'x'.repeat(bytes) });

  it('small routes answer 413 for a body over 16 KB, in the standard error shape', async () => {
    for (const url of ['/auth/signin', '/auth/signup', '/auth/password-reset/request', '/auth/password-reset/confirm', '/auth/email-confirmation/confirm']) {
      const res = await post(url, big(20_000));
      expect(res.statusCode, url).toBe(413);
      expect(res.headers['content-type']).toMatch(/problem\+json/);
    }
    expect((await post('/gateway/api-keys', { label: 'x', services: ['desk_api'], pad: 'x'.repeat(20_000) }, headers)).statusCode).toBe(413);
    expect((await post(`/setup/businesses/${businessId}/members`, { email: 'a@example.com', pad: 'x'.repeat(20_000) }, headers)).statusCode).toBe(413);
  });

  it('the same routes are limited under /v1 too', async () => {
    expect((await post('/v1/auth/signin', big(20_000))).statusCode).toBe(413);
  });

  it('a normal sign-in body is nowhere near the ceiling', async () => {
    expect((await post('/auth/signin', { email: 'nobody@example.com', password: 'Str0ng!Pass' })).statusCode).toBe(401);
  });

  it('drafts may be large but not over 1 MB', async () => {
    const id = JSON.parse((await post('/setup/drafts', {}, headers)).body).id as string;
    const patch = (chars: number) => app.inject({ method: 'PATCH', url: `/setup/drafts/${id}`, headers, payload: { draft: { notes: 'x'.repeat(chars) } } });
    expect((await patch(200_000)).statusCode).toBe(200);
    expect((await patch(300_000)).statusCode).toBe(413); // the existing 256 KB draft rule
    expect((await patch(1_200_000)).statusCode).toBe(413); // the body ceiling
  });
});
