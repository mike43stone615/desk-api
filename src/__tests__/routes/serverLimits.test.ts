// Server timeouts (slow clients) and the limit headers on a refusal.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { buildApp } from '../../app';
import { config } from '../../config';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); }, 30_000);

describe('server timeouts', () => {
  it('headers must arrive within 10 s and the whole request within 30 s; idle connections close after 65 s', () => {
    expect(app.server.headersTimeout).toBe(10_000);
    expect(app.server.requestTimeout).toBe(30_000);
    expect(app.server.keepAliveTimeout).toBe(65_000);
    expect(app.server.headersTimeout).toBeLessThanOrEqual(app.server.requestTimeout);
  });
});

describe('a 429 carries the limit headers too', () => {
  beforeEach(() => { config.rateLimitPerMinute = 3; });
  it('shows the limit, zero remaining and when it resets, alongside Retry-After', async () => {
    let last;
    for (let i = 0; i < 6; i++) last = await app.inject({ method: 'GET', url: '/auth/session', headers: { 'cf-connecting-ip': '198.51.100.77' } });
    expect(last!.statusCode).toBe(429);
    expect(last!.headers['retry-after']).toBe('60');
    expect(last!.headers['x-ratelimit-limit']).toBe('3');
    expect(last!.headers['x-ratelimit-remaining']).toBe('0');
    expect(Number(last!.headers['x-ratelimit-reset'])).toBeGreaterThan(Date.now() / 1000 - 5);
  });
});
