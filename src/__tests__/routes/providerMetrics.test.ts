// Outside providers (OpenAI, Google Places, Resend) are counted by outcome, so a refused key or a used-up quota is visible.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { createFakeDb } from '../helpers/fake-db';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { pool } from '../../db';
import { buildApp } from '../../app';
import { config } from '../../config';
import { providerCallsTotal } from '../../modules/metrics';
import { outcomeForStatus } from '../../modules/provider-metrics';
import { sendPasswordResetEmail } from '../../infrastructure/email/resend';
import type { FastifyInstance } from 'fastify';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;
const realFetch = globalThis.fetch;
let app: FastifyInstance;
let headers: Record<string, string>;

const count = async (provider: string, outcome: string) => {
  const m = await providerCallsTotal.get();
  return m.values.find((v) => v.labels.provider === provider && v.labels.outcome === outcome)?.value ?? 0;
};
const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeAll(async () => {
  app = await buildApp();
  const now = new Date().toISOString();
  fakeDb.users.set('pm-user', { id: 'pm-user', email: 'pm@example.com', password_hash: 'x', first_name: 'P', last_name: 'M', email_confirmed_at: now, created_at: now, updated_at: now });
  fakeDb.seedSession('pm-token', { id: 'pm-s', user_id: 'pm-user', token: 'pm-token', expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now });
  headers = { authorization: 'Bearer pm-token' };
});
beforeEach(() => {
  config.googlePlacesApiKey = 'places-key';
  config.openaiApiKey = 'openai-key';
  config.resendApiKey = 'resend-key';
});
afterEach(() => {
  vi.stubGlobal('fetch', realFetch);
});

describe('outcomeForStatus', () => {
  it('classifies statuses', () => {
    expect(outcomeForStatus(200)).toBe('ok');
    expect(outcomeForStatus(204)).toBe('ok');
    expect(outcomeForStatus(401)).toBe('auth_error');
    expect(outcomeForStatus(403)).toBe('auth_error');
    expect(outcomeForStatus(429)).toBe('quota');
    expect(outcomeForStatus(500)).toBe('error');
    expect(outcomeForStatus(400)).toBe('error');
  });
});

describe('Google Places', () => {
  const search = () => app.inject({ method: 'POST', url: '/functions/v1/search-place-areas', headers, payload: { query: 'Denver' } });

  it('counts ok, a refused key (HTTP or in the body), a used-up quota and a network failure separately', async () => {
    const before = { ok: await count('google_places', 'ok'), auth: await count('google_places', 'auth_error'), quota: await count('google_places', 'quota'), err: await count('google_places', 'error') };
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { status: 'OK', predictions: [] })));
    await search();
    vi.stubGlobal('fetch', vi.fn(async () => reply(403)));
    await search();
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { status: 'REQUEST_DENIED' })));
    await search();
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { status: 'OVER_QUERY_LIMIT' })));
    await search();
    vi.stubGlobal('fetch', vi.fn(async () => reply(429)));
    await search();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    await search();
    expect(await count('google_places', 'ok')).toBe(before.ok + 1);
    expect(await count('google_places', 'auth_error')).toBe(before.auth + 2);
    expect(await count('google_places', 'quota')).toBe(before.quota + 2);
    expect(await count('google_places', 'error')).toBe(before.err + 1);
  });
});

describe('OpenAI', () => {
  const analyze = () => app.inject({ method: 'POST', url: '/functions/v1/analyze-business-setup', headers, payload: { action: 'classify_unregistered_business', businessIdea: 'A mobile dog grooming service', industries: ['Pet Services'] } });

  it('a refused key or used-up quota is counted even though the caller still gets the fallback answer', async () => {
    const before = { auth: await count('openai', 'auth_error'), quota: await count('openai', 'quota'), err: await count('openai', 'error') };
    vi.stubGlobal('fetch', vi.fn(async () => reply(401, { error: 'invalid key' })));
    expect((await analyze()).statusCode).toBe(200);
    vi.stubGlobal('fetch', vi.fn(async () => reply(429, { error: 'quota' })));
    expect((await analyze()).statusCode).toBe(200);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout'); }));
    expect((await analyze()).statusCode).toBe(200);
    expect(await count('openai', 'auth_error')).toBe(before.auth + 1);
    expect(await count('openai', 'quota')).toBe(before.quota + 1);
    expect(await count('openai', 'error')).toBe(before.err + 1);
  });
});

describe('Resend', () => {
  it('counts each email send by outcome', async () => {
    const before = { ok: await count('resend', 'ok'), auth: await count('resend', 'auth_error'), quota: await count('resend', 'quota') };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const status of [200, 401, 429]) {
      vi.stubGlobal('fetch', vi.fn(async () => reply(status)));
      await sendPasswordResetEmail(config, 'a@example.com', 'tok', 'req-1');
    }
    expect(await count('resend', 'ok')).toBe(before.ok + 1);
    expect(await count('resend', 'auth_error')).toBe(before.auth + 1);
    expect(await count('resend', 'quota')).toBe(before.quota + 1);
  });

  it('an unconfigured key sends nothing and counts nothing', async () => {
    config.resendApiKey = undefined;
    const before = await count('resend', 'ok');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sendPasswordResetEmail(config, 'a@example.com', 'tok', 'req-2');
    expect(await count('resend', 'ok')).toBe(before);
  });
});
