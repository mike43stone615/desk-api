// /metrics must not grow without bound: a series per URL (draft ids, scanner probes, random strings) would.
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { buildApp } from '../../app';
import { methodLabel, routeLabel } from '../../modules/metrics';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
});

const KEY = { 'x-api-key': 'test-metrics-docs-key' };
async function series(): Promise<string[]> {
  const res = await app.inject({ method: 'GET', url: '/metrics', headers: KEY });
  return res.body.split('\n').filter((l) => l.startsWith('desk_http_requests_total{'));
}
const label = (line: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(line)?.[1];

describe('routeLabel / methodLabel', () => {
  it('uses the route pattern, drops /v1, and folds everything unmatched into one label', () => {
    expect(routeLabel({ routeOptions: { url: '/setup/drafts/:id' } })).toBe('/setup/drafts/:id');
    expect(routeLabel({ routeOptions: { url: '/v1/setup/drafts/:id' } })).toBe('/setup/drafts/:id');
    expect(routeLabel({ routeOptions: { url: '/v1' } })).toBe('/');
    expect(routeLabel({ routeOptions: { url: '/gateway/registry/*' } })).toBe('/gateway/registry/*');
    expect(routeLabel({ routeOptions: { url: '*' } })).toBe('unmatched');
    expect(routeLabel({ routeOptions: {}, is404: true })).toBe('unmatched');
    expect(routeLabel({})).toBe('unmatched');
  });

  it('keeps standard methods and folds anything else into OTHER', () => {
    expect(methodLabel('GET')).toBe('GET');
    expect(methodLabel('PATCH')).toBe('PATCH');
    expect(methodLabel('BREW')).toBe('OTHER');
    expect(methodLabel('x'.repeat(50))).toBe('OTHER');
  });
});

describe('the request metrics', () => {
  it('one series per route, however many different ids or paths were requested', async () => {
    const before = (await series()).length;
    for (let i = 0; i < 60; i++) {
      await app.inject({ method: 'GET', url: `/setup/drafts/id-${i}-${Math.random().toString(36).slice(2)}` });
      await app.inject({ method: 'GET', url: `/definitely/not/a/route/${i}?token=${i}` });
      await app.inject({ method: 'GET', url: `/v1/gateway/registry/thing-${i}` });
    }
    const after = await series();
    // 60 different draft ids, 60 different junk URLs, 60 different gateway paths: a handful of new series in total.
    expect(after.length - before).toBeLessThanOrEqual(4);
    const routes = new Set(after.map((l) => label(l, 'route')));
    expect(routes.has('/setup/drafts/:id')).toBe(true);
    expect(routes.has('unmatched')).toBe(true);
    expect(routes.has('/gateway/registry/*')).toBe(true);
    for (const r of routes) {
      expect(r, 'no raw id or query string leaks into a label').not.toMatch(/id-\d|token=|thing-\d|not\/a\/route/);
    }
  });

  it('a made-up HTTP verb or a very long URL cannot add series', async () => {
    const before = (await series()).length;
    for (let i = 0; i < 20; i++) {
      await app.inject({ method: 'GET', url: `/${'a'.repeat(200)}${i}` });
      await app.inject({ method: 'PUT', url: `/setup/drafts/x${i}` }); // wrong verb: 405
    }
    expect((await series()).length - before).toBeLessThanOrEqual(3);
  });

  it('/v1 and unprefixed spellings of a route share one series', async () => {
    await app.inject({ method: 'GET', url: '/health' });
    await app.inject({ method: 'GET', url: '/v1/health' });
    const health = (await series()).filter((l) => label(l, 'route') === '/health' && label(l, 'status_code') === '200' && label(l, 'method') === 'GET');
    expect(health).toHaveLength(1);
  });
});
