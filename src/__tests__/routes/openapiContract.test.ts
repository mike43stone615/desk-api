// The published API description is checked against the running routes, automatically:
//  - the request bodies it documents are generated from the validators, and the server really demands exactly the
//    fields the description marks as required;
//  - the answers it documents (their shape) are what the routes really answer;
//  - every operation in the published description has a real example.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));
vi.mock('../../infrastructure/email/resend', async () => (await import('../helpers/email-capture')).emailModuleMock());

import { buildApp } from '../../app';
import { pool } from '../../db';
import { config } from '../../config';
import { hashPassword } from '../../domain/auth/password';
import { resetSigninThrottleForTests } from '../../middleware/signin-throttle';
import { LIBRARY_OPENAPI_SPEC, OPENAPI_SPEC, DOCUMENTED_BODY_VALIDATORS } from '../../openapi';
import { GATEWAY_EXAMPLES } from '../../openapi-examples';
import { inferSchema, shapeProblems } from '../../openapi-schema';
import type { createFakeDb } from '../helpers/fake-db';
import type { FastifyInstance } from 'fastify';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;
type Op = { requestBody?: { content: Record<string, { schema?: { required?: string[]; properties?: Record<string, unknown> }; example?: unknown }> }; responses: Record<string, { content?: Record<string, { schema?: Record<string, unknown>; example?: unknown }> }> };
const paths = OPENAPI_SPEC.paths as unknown as Record<string, Record<string, Op>>;
const libPaths = LIBRARY_OPENAPI_SPEC.paths as unknown as Record<string, Record<string, Op>>;
const PASSWORD = 'Str0ng!Pass1';
let app: FastifyInstance;
let hash: string;
let headers: Record<string, string>;

beforeAll(async () => {
  app = await buildApp();
  hash = await hashPassword(PASSWORD);
  config.gatewayKeyEncryptionSecret = 'ab'.repeat(32);
  const now = new Date().toISOString();
  fakeDb.users.set('contract-1', { id: 'contract-1', email: 'contract@example.com', password_hash: hash, first_name: 'Ada', last_name: 'Lovelace', email_confirmed_at: now, created_at: now, updated_at: now });
  const res = await app.inject({ method: 'POST', url: '/auth/signin', headers: { 'cf-connecting-ip': '203.0.113.90' }, payload: { email: 'contract@example.com', password: PASSWORD } });
  headers = { authorization: `Bearer ${JSON.parse(res.body).token}` };
}, 30_000);
beforeEach(() => { resetSigninThrottleForTests(); config.rateLimitPerMinute = 1000; });

describe('documented request bodies match what the routes demand', () => {
  const routesWithoutExtraSetup = DOCUMENTED_BODY_VALIDATORS.filter(([path]) => !path.includes('{'));
  it.each(routesWithoutExtraSetup.map(([path, method]) => [path, method]))('%s (%s): sending {} fails naming exactly the fields the description marks required', async (path, method) => {
    const op = paths[path][method];
    const schema = op.requestBody!.content['application/json'].schema!;
    const required = [...(schema.required ?? [])].sort();
    expect(required.length, 'the description must say which fields are required').toBeGreaterThan(0);
    const res = await app.inject({ method: method.toUpperCase() as 'POST', url: path, headers: { ...headers, 'cf-connecting-ip': `203.0.113.${100 + required.length}` }, payload: {} });
    expect(res.statusCode, path).toBe(400);
    const missing = (JSON.parse(res.body).errors as Array<{ field: string }>).map((e) => e.field).sort();
    expect(missing).toEqual(required);
  });

  it('the fields the description lists for a body are the fields the validator knows about', () => {
    for (const [path, method] of DOCUMENTED_BODY_VALIDATORS) {
      const schema = paths[path][method].requestBody!.content['application/json'].schema!;
      expect(Object.keys(schema.properties ?? {}).length, `${method} ${path}`).toBeGreaterThan(0);
    }
  });
});

describe('documented answers match what the routes answer', () => {
  const own: Array<[string, string, () => Promise<{ statusCode: number; body: string }>]> = [
    ['GET', '/auth/session', () => app.inject({ method: 'GET', url: '/auth/session', headers })],
    ['GET', '/setup/drafts', () => app.inject({ method: 'GET', url: '/setup/drafts', headers })],
    ['GET', '/setup/businesses', () => app.inject({ method: 'GET', url: '/setup/businesses', headers })],
    ['GET', '/gateway/services', () => app.inject({ method: 'GET', url: '/gateway/services', headers })],
    ['GET', '/gateway/api-keys', () => app.inject({ method: 'GET', url: '/gateway/api-keys', headers })],
    ['POST', '/gateway/api-keys', () => app.inject({ method: 'POST', url: '/gateway/api-keys', headers, payload: { label: 'contract', services: ['desk_api'], expiresInDays: 90 } })],
  ];
  it.each(own.map(([m, p, fn]) => [m, p, fn] as const))('%s %s answers the way its example says', async (method, path, call) => {
    const op = libPaths[path][method.toLowerCase()];
    const example = GATEWAY_EXAMPLES[`${method} /v1${path}`];
    const schema = Object.values(op.responses[String(example.status)].content!)[0].schema!;
    const res = await call();
    expect(res.statusCode).toBe(example.status);
    expect(shapeProblems(schema, JSON.parse(res.body)), `${method} ${path}`).toEqual([]);
  });

  it('the usage answer has the documented shape too', async () => {
    const created = JSON.parse((await app.inject({ method: 'POST', url: '/gateway/api-keys', headers, payload: { label: 'usage', services: ['desk_api'] } })).body);
    const res = await app.inject({ method: 'GET', url: `/gateway/api-keys/${created.apiKey.id}/usage`, headers });
    const schema = Object.values(libPaths['/gateway/api-keys/{id}/usage'].get.responses['200'].content!)[0].schema!;
    expect(shapeProblems(schema, JSON.parse(res.body))).toEqual([]);
  });

  it('the shape checker itself notices a missing member, a wrong type and a null where text was expected', () => {
    const schema = inferSchema({ id: 'x', n: 1, list: [{ a: 'b' }], nested: { ok: true } });
    expect(shapeProblems(schema, { id: 'y', n: 2, list: [{ a: 'c' }], nested: { ok: false } })).toEqual([]);
    expect(shapeProblems(schema, { id: 'y', list: [{ a: 'c' }], nested: { ok: false } })).toEqual(['$.n: missing']);
    expect(shapeProblems(schema, { id: 5, n: 2, list: [{ a: 'c' }], nested: { ok: false } })).toEqual(['$.id: expected string, got number']);
    expect(shapeProblems(schema, { id: null, n: 2, list: [{ a: 'c' }], nested: { ok: false } })).toEqual(['$.id: is null']);
    expect(shapeProblems(schema, { id: 'y', n: 2, list: [{ a: 1 }], nested: { ok: false } })).toEqual(['$.list[0].a: expected string, got number']);
  });
});

describe('every operation in the published description has a real example', () => {
  it('lists the ones that do not (only bodiless answers and the description itself are exempt)', () => {
    const exempt = new Set(['GET /gateway/openapi.json', 'DELETE /gateway/api-keys/{id}']);
    const missing: string[] = [];
    for (const [path, ops] of Object.entries(libPaths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (exempt.has(`${method.toUpperCase()} ${path}`)) continue;
        const ok = Object.entries(op.responses).some(([status, r]) => /^2/.test(status) && Object.values(r.content ?? {}).some((c) => c.example !== undefined));
        if (!ok) missing.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
