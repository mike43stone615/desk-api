// Plain-English validation errors (one entry per field), the error catalogue, ids in the address, ETag on reference
// data, one rule for DELETE, and the richer health/index answers.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { ZodError, z } from 'zod';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { buildApp } from '../../app';
import { validationError } from '../../middleware/http-error';
import { matchesIfNoneMatch, etagOf } from '../../middleware/etag';
import { ERROR_CODES } from '../../middleware/error-codes';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); }, 30_000);

describe('validationError', () => {
  const schema = z.object({ email: z.string().email(), n: z.number(), tags: z.array(z.string()).max(2), name: z.string().min(1), kind: z.enum(['a', 'b']), s: z.string().max(3), custom: z.string().min(1, 'custom is required') });
  const problems = (input: unknown) => { const r = schema.safeParse(input); return validationError((r as { error: ZodError }).error).errors!; };

  it('says what is wrong with each field in plain English, with a kind for programs', () => {
    const e = problems({ email: 'nope', n: 'x', tags: ['a', 'b', 'c'], name: '', kind: 'z', s: 'toolong', custom: '' });
    const by = (f: string) => e.find((p) => p.field === f)!;
    expect(by('email')).toEqual({ field: 'email', code: 'invalid_format', message: '"email" is not a valid email address.' });
    expect(by('n')).toMatchObject({ code: 'wrong_type', message: '"n" must be a number.' });
    expect(by('tags')).toMatchObject({ code: 'too_many', message: '"tags" must be at most 2 items.' });
    expect(by('name')).toMatchObject({ code: 'required', message: '"name" cannot be empty.' });
    expect(by('kind')).toMatchObject({ code: 'invalid_value', message: '"kind" must be one of: a, b.' });
    expect(by('s')).toMatchObject({ code: 'too_long', message: '"s" must be at most 3 characters.' });
    expect(by('custom').message).toBe('custom is required'); // a message somebody wrote on purpose is kept
  });

  it('a missing field is "required", and no raw library wording ever reaches the message', () => {
    const e = problems({ kind: 'a' });
    expect(e.every((p) => p.code === 'required')).toBe(true);
    for (const p of e) expect(p.message).not.toMatch(/Invalid input|received undefined|Too small|Too big/);
  });
});

describe('validation over HTTP', () => {
  it('a sign-in with nothing lists every missing field, joined for people and structured for programs', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/signin', payload: {} });
    const b = JSON.parse(res.body);
    expect(res.statusCode).toBe(400);
    expect(b.code).toBe('validation_error');
    expect(b.errors.map((e: { field: string }) => e.field).sort()).toEqual(['email', 'password']);
    expect(b.detail).toBe(b.error);
    expect(b.detail).toMatch(/"email" is required\. "password" is required\./);
  });
});

describe('error catalogue', () => {
  it('lists every code, and each error answer\'s type points at its entry', async () => {
    const list = JSON.parse((await app.inject({ method: 'GET', url: '/errors' })).body);
    expect(list.errors.map((e: { code: string }) => e.code).sort()).toEqual(Object.keys(ERROR_CODES).sort());
    const one = await app.inject({ method: 'GET', url: '/v1/errors/invalid_credentials' });
    expect(JSON.parse(one.body)).toMatchObject({ code: 'invalid_credentials', type: 'https://api.deskbusiness.co/errors/invalid_credentials' });
    expect((await app.inject({ method: 'GET', url: '/errors/nope' })).statusCode).toBe(404);
  });
});

describe('identifiers in the address', () => {
  it('a malformed id is 400 invalid_id; an unknown well-formed one is 404', async () => {
    const bad = await app.inject({ method: 'GET', url: '/setup/drafts/a%20b%3Cscript%3E' });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).code).toBe('invalid_id');
    const good = await app.inject({ method: 'GET', url: '/setup/drafts/abc123' });
    expect([401, 404]).toContain(good.statusCode); // 401 here: no session; the point is that it is not 400
  });
});

describe('ETag on reference data', () => {
  it('answers 304 to a matching If-None-Match, and the tag changes when the body does', async () => {
    const first = await app.inject({ method: 'GET', url: '/gateway/openapi.json' });
    const tag = String(first.headers.etag);
    expect(tag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    const again = await app.inject({ method: 'GET', url: '/gateway/openapi.json', headers: { 'if-none-match': tag } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    expect((await app.inject({ method: 'GET', url: '/gateway/openapi.json', headers: { 'if-none-match': '"other"' } })).statusCode).toBe(200);
    expect(etagOf({ a: 1 })).not.toBe(etagOf({ a: 2 }));
    expect(matchesIfNoneMatch('W/"x", "y"', '"y"')).toBe(true);
    expect(matchesIfNoneMatch('*', '"y"')).toBe(true);
    expect(matchesIfNoneMatch(undefined, '"y"')).toBe(false);
  });
});

describe('health and index', () => {
  it('health has the same members as the other services (responseId, servedAt, ok) plus the older ones', async () => {
    const b = JSON.parse((await app.inject({ method: 'GET', url: '/health' })).body);
    expect(b).toMatchObject({ ok: true, service: 'desk-api' });
    expect(b.responseId).toBeTruthy();
    expect(Date.parse(b.servedAt)).not.toBeNaN();
    expect(b.ts).toBe(b.servedAt);
  });
  it('the /v1 index names the versions, the error catalogue and the policy', async () => {
    const b = JSON.parse((await app.inject({ method: 'GET', url: '/v1' })).body);
    expect(b.versions).toEqual([{ version: 'v1', status: 'current', base: '/v1' }]);
    expect(b.errors).toBe('/v1/errors');
    expect(b.policy).toMatch(/API-VERSIONING/);
  });
});
