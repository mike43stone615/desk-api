// Awkward request bodies: too big, and text the database cannot store.
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { buildApp } from '../../app';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); }, 30_000);

const NUL = String.fromCharCode(0);

describe('oversize bodies', () => {
  it('a 3 MB body is refused with 413 and a problem document', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/setup/drafts', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, payload: JSON.stringify({ data: { blob: 'x'.repeat(3_000_000) } }) });
    expect(res.statusCode).toBe(413);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    expect(res.json().code).toBe('payload_too_large');
  });

  it('the small routes keep their own, lower ceiling (16 KB)', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/signin', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'a@example.com', password: 'x'.repeat(40_000) }) });
    expect(res.statusCode).toBe(413);
  });
});

describe('the NUL character', () => {
  it('is refused with 400 in a value, however deep, instead of failing in the database with a 500', async () => {
    for (const payload of [
      { email: 'a@example.com', password: 'Zx9!abcdefghQq7#', firstName: `A${NUL}B`, lastName: 'C' },
      { email: 'a@example.com', password: 'Zx9!abcdefghQq7#', firstName: 'A', lastName: 'C', extra: { deep: ['x', { y: `p${NUL}q` }] } },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/v1/auth/signup', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('invalid_characters');
    }
  });

  it('is refused in a key name too (never a 500)', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/gateway/api-keys', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ label: `bad${NUL}name`, services: ['desk_api'] }) });
    expect([400, 401]).toContain(res.statusCode);
  });
});
