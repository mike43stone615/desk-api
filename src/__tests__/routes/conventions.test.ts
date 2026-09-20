// /v1 conventions and request-id handling.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { createFakeDb } from '../helpers/fake-db';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { pool } from '../../db';
import { buildApp, acceptableRequestId } from '../../app';
import type { FastifyInstance } from 'fastify';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;
let app: FastifyInstance;
let headers: Record<string, string>;
beforeAll(async () => {
  app = await buildApp();
  const now = new Date().toISOString();
  fakeDb.users.set('cv-user', { id: 'cv-user', email: 'cv@example.com', password_hash: 'x', first_name: 'C', last_name: 'V', email_confirmed_at: now, created_at: now, updated_at: now });
  fakeDb.seedSession('cv-token', { id: 'cv-s', user_id: 'cv-user', token: 'cv-token', expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now });
  headers = { authorization: 'Bearer cv-token' };
});

const newDraft = async (prefix: string) => JSON.parse((await app.inject({ method: 'POST', url: `${prefix}/setup/drafts`, headers, payload: {} })).body).id as string;

describe('successful DELETE', () => {
  it('is 204 with no body under /v1', async () => {
    const id = await newDraft('/v1');
    const res = await app.inject({ method: 'DELETE', url: `/v1/setup/drafts/${id}`, headers });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(res.headers['content-type']).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: `/v1/setup/drafts/${id}`, headers })).statusCode).toBe(404);
  });

  it('stays 200 {"ok":true} on the unprefixed routes, so existing clients are unaffected', async () => {
    const id = await newDraft('');
    const res = await app.inject({ method: 'DELETE', url: `/setup/drafts/${id}`, headers });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('a failed DELETE under /v1 is still its error (404 with a body)', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/v1/setup/drafts/does-not-exist', headers });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('draft_not_found');
  });

  it('other methods under /v1 are untouched (a POST answering ok stays 200)', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/signout', headers, payload: {} });
    expect(res.statusCode).toBe(200);
  });
});

describe('x-request-id', () => {
  it('echoes a plain id the caller supplied', async () => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'trace-abc_123.xyz:1' } });
    expect(res.headers['x-request-id']).toBe('trace-abc_123.xyz:1');
  });

  it('replaces anything unsafe with a fresh id', async () => {
    for (const bad of ['short', 'x'.repeat(65), 'has space in it', '<script>alert(1)</script>', 'a;b;c;d;e;f;g;h', 'id-with-ümläut-chars']) {
      const res = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': bad } });
      const id = String(res.headers['x-request-id']);
      expect(id, JSON.stringify(bad)).not.toBe(bad);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('generates one when none is sent, different each time', async () => {
    const a = String((await app.inject({ method: 'GET', url: '/health' })).headers['x-request-id']);
    const b = String((await app.inject({ method: 'GET', url: '/health' })).headers['x-request-id']);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it('is echoed on error answers too', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope', headers: { 'x-request-id': 'my-request-0001' } });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-request-id']).toBe('my-request-0001');
  });

  it('acceptableRequestId accepts exactly the documented alphabet and length', () => {
    expect(acceptableRequestId('abcdefgh')).toBe('abcdefgh');
    expect(acceptableRequestId('a'.repeat(64))).toBeDefined();
    expect(acceptableRequestId('a'.repeat(7))).toBeUndefined();
    expect(acceptableRequestId(['abcdefgh'])).toBeUndefined();
    expect(acceptableRequestId(undefined)).toBeUndefined();
  });
});
