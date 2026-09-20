// Verifies the deliberately-simplified market-research proxy (see
// src/routes/integrations/marketResearch.ts's header comment): success
// passes the upstream body through, and any failure mode (misconfigured,
// non-OK status, network error) returns a clean 503 — never a locally
// computed fallback score.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { pool } from '../../db';
import { buildApp } from '../../app';
import { createFakeDb } from '../helpers/fake-db';
import { seedSignedIn } from '../helpers/signed-in';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let auth: Record<string, string>;
const originalFetch = global.fetch;

beforeAll(async () => {
  app = await buildApp();
  auth = seedSignedIn(pool as unknown as ReturnType<typeof createFakeDb>);
});

afterEach(() => {
  global.fetch = originalFetch;
});

const BODY = { businessIdea: 'A mobile dog grooming service', formationState: 'CO' };

describe('POST /integrations/market-research/analyze', () => {
  it('allows the upstream request 75 seconds', async () => {
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(new AbortController().signal);
    global.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 })) as typeof fetch;
    try {
      const response = await app.inject({
        method: 'POST',
        headers: auth,
        url: '/integrations/market-research/analyze',
        payload: BODY,
      });
      expect(response.statusCode).toBe(200);
      expect(timeoutSpy).toHaveBeenCalledWith(75000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('passes through a successful upstream response', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ overallScore: 70 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ) as unknown as typeof fetch;

    const res = await app.inject({
      method: 'POST',
      headers: auth,
      url: '/integrations/market-research/analyze',
      payload: BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ overallScore: 70 });
  });

  it('turns an upstream validation rejection into a 400 with the reason, not a "service unavailable"', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'businessIdea must be at most 2000 characters' }), {
        status: 400,
        headers: { 'content-type': 'application/problem+json' },
      }),
    ) as unknown as typeof fetch;

    const res = await app.inject({ method: 'POST', headers: auth, url: '/integrations/market-research/analyze', payload: BODY });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).detail).toBe('businessIdea must be at most 2000 characters');
  });

  it('forwards the request id so the call can be traced into market-validation-api', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await app.inject({ method: 'POST', headers: auth, url: '/integrations/market-research/analyze', payload: BODY });
    const sent = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(sent['x-request-id']).toBe(res.headers['x-request-id']);
  });

  it('returns 503 (not a crash, not a computed fallback) when the upstream call throws', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const res = await app.inject({
      method: 'POST',
      headers: auth,
      url: '/integrations/market-research/analyze',
      payload: BODY,
    });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.detail).toMatch(/temporarily unavailable/i);
  });

  it('returns 503 when the upstream responds with a non-OK status', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('error', { status: 500 })) as unknown as typeof fetch;

    const res = await app.inject({
      method: 'POST',
      headers: auth,
      url: '/integrations/market-research/analyze',
      payload: BODY,
    });
    expect(res.statusCode).toBe(503);
  });
});

describe('MARKET_API_URL unset', () => {
  it('fails closed with 503 rather than attempting a request', async () => {
    const original = process.env.MARKET_API_URL;
    delete process.env.MARKET_API_URL;
    vi.resetModules();
    try {
      const { buildApp: buildFreshApp } = await import('../../app');
      const freshApp = await buildFreshApp();
      const { pool: freshPool } = await import('../../db');
      const freshAuth = seedSignedIn(freshPool as unknown as ReturnType<typeof createFakeDb>);
      const res = await freshApp.inject({
        method: 'POST',
        headers: freshAuth,
        url: '/integrations/market-research/analyze',
        payload: BODY,
      });
      expect(res.statusCode).toBe(503);
      await freshApp.close();
    } finally {
      process.env.MARKET_API_URL = original;
      vi.resetModules();
    }
  });
});
