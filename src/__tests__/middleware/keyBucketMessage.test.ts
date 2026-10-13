// A key that goes over its own per-minute bucket is told its plan's limit in words, not a bare "Rate limit exceeded
// (per-minute)." (found by a live test 2026-10-13: the 101st call of a Free key got the generic wording).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';

vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));
vi.mock('../../domain/gateway/keys', () => ({
  GATEWAY_KEY_PREFIX: 'deskgw_',
  keyBucketInfo: vi.fn(async (key: string) =>
    key === 'deskgw_free'
      ? { factor: 2 / 3, known: true, minuteRefusal: 'Your Free plan allows 2 calls a minute across all APIs. Try again in a minute.' }
      : { factor: null },
  ),
}));

import { registerApiProtection } from '../../middleware/api-protection';
import { config } from '../../config';

const saved = config.rateLimitPerMinute;
const app = Fastify();
beforeAll(async () => {
  config.rateLimitPerMinute = 3;
  registerApiProtection(app);
  app.get('/v1/thing', async () => ({ ok: true }));
  await app.ready();
});
afterAll(async () => {
  config.rateLimitPerMinute = saved;
  await app.close();
});

describe('key bucket refusal', () => {
  it("names the plan's limit", async () => {
    const hit = () => app.inject({ method: 'GET', url: '/v1/thing', headers: { 'x-api-key': 'deskgw_free' } });
    expect((await hit()).statusCode).toBe(200);
    expect((await hit()).statusCode).toBe(200);
    const refused = await hit();
    expect(refused.statusCode).toBe(429);
    expect(refused.json().detail).toBe('Your Free plan allows 2 calls a minute across all APIs. Try again in a minute.');
  });
});
