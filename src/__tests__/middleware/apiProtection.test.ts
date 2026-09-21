// The rate limiter's own rules, tested directly: each window (minute, hour, day, month) refuses when used up and refills when
// its time has passed, the Redis path counts and fails open, and the client address is taken only from trusted headers.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const redisState = vi.hoisted(() => ({ redis: null as unknown }));
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => redisState.redis, connectRedis: vi.fn() }));

import { checkRateBucket, getClientIp } from '../../middleware/api-protection';
import { config } from '../../config';

const saved = { m: config.rateLimitPerMinute, h: config.rateLimitPerHour, d: config.rateLimitDaily, mo: config.rateLimitMonthly, proxies: config.trustedProxyCount, redisUrl: config.redisUrl };
let n = 0;
const fresh = () => `test-bucket-${++n}`;

beforeEach(() => {
  config.rateLimitPerMinute = 3;
  config.rateLimitPerHour = 5;
  config.rateLimitDaily = 7;
  config.rateLimitMonthly = 9;
  redisState.redis = null;
});
afterEach(() => {
  vi.useRealTimers();
  config.rateLimitPerMinute = saved.m;
  config.rateLimitPerHour = saved.h;
  config.rateLimitDaily = saved.d;
  config.rateLimitMonthly = saved.mo;
  config.trustedProxyCount = saved.proxies;
  config.redisUrl = saved.redisUrl;
});

describe('in-memory limiter', () => {
  it('lets the limit through, counting down, then refuses', async () => {
    const key = fresh();
    expect((await checkRateBucket(key)).remaining).toBe(2);
    expect((await checkRateBucket(key)).remaining).toBe(1);
    expect((await checkRateBucket(key)).remaining).toBe(0);
    const refused = await checkRateBucket(key);
    expect(refused).toMatchObject({ allowed: false, remaining: 0, reason: 'Rate limit exceeded (per-minute).' });
  });

  it('a factor makes a bucket bigger or smaller', async () => {
    const small = fresh();
    expect((await checkRateBucket(small, 0.34)).remaining).toBe(1); // ceil(3 * 0.34) = 2 tokens, 1 left after the first
    const big = fresh();
    expect((await checkRateBucket(big, 2)).remaining).toBe(5); // 6 tokens
  });

  it('the minute window refills after a minute, but the hour window still holds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-21T10:00:00Z'));
    const key = fresh();
    for (let i = 0; i < 3; i++) await checkRateBucket(key);
    expect((await checkRateBucket(key)).allowed).toBe(false);
    vi.setSystemTime(new Date('2026-09-21T10:01:01Z'));
    expect((await checkRateBucket(key)).allowed).toBe(true); // minute refilled; 2 of 5 hour tokens used
    for (let i = 0; i < 2; i++) await checkRateBucket(key);
    vi.setSystemTime(new Date('2026-09-21T10:02:05Z'));
    const hourRefused = await checkRateBucket(key);
    expect(hourRefused).toMatchObject({ allowed: false, reason: 'Rate limit exceeded (per-hour).' });
  });

  it('the hour, day and month windows each refill on their own schedule', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    config.rateLimitPerMinute = 100;
    config.rateLimitPerHour = 2;
    config.rateLimitDaily = 100;
    config.rateLimitMonthly = 100;
    const hourly = fresh();
    await checkRateBucket(hourly); await checkRateBucket(hourly);
    expect((await checkRateBucket(hourly)).reason).toBe('Rate limit exceeded (per-hour).');
    vi.setSystemTime(new Date('2026-09-01T01:00:05Z'));
    expect((await checkRateBucket(hourly)).allowed).toBe(true);

    config.rateLimitPerHour = 100;
    config.rateLimitDaily = 2;
    const daily = fresh();
    await checkRateBucket(daily); await checkRateBucket(daily);
    expect((await checkRateBucket(daily)).reason).toBe('Daily quota exceeded.');
    vi.setSystemTime(new Date('2026-09-02T01:00:10Z'));
    expect((await checkRateBucket(daily)).allowed).toBe(true);

    config.rateLimitDaily = 100;
    config.rateLimitMonthly = 2;
    const monthly = fresh();
    await checkRateBucket(monthly); await checkRateBucket(monthly);
    expect((await checkRateBucket(monthly)).reason).toBe('Monthly quota exceeded.');
    vi.setSystemTime(new Date('2026-10-05T00:00:00Z'));
    expect((await checkRateBucket(monthly)).allowed).toBe(true);
  });

  it('a bucket idle for a day and a quarter of an hour is forgotten by the sweep (the next call starts fresh)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    const key = fresh();
    for (let i = 0; i < 3; i++) await checkRateBucket(key);
    expect((await checkRateBucket(key)).allowed).toBe(false);
    await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000); // fires the 15-minute sweeps; the caller has been idle over a day
    expect((await checkRateBucket(key)).remaining).toBe(2);
  });
});

describe('Redis limiter', () => {
  const pipeline = (counts: Record<string, number>, calls: string[]) => (key?: string) => {
    let currentKey = '';
    const p = {
      zremrangebyscore: (k: string) => { currentKey = k; calls.push(`clean ${k}`); return p; },
      zcard: () => p,
      zadd: () => p,
      pexpire: () => p,
      exec: async () => [[null, 0], [null, counts[currentKey] ?? 0], [null, 1], [null, 1]],
    };
    void key;
    return p;
  };

  it('counts each window and allows while every one is under its limit', async () => {
    const calls: string[] = [];
    redisState.redis = { pipeline: pipeline({}, calls) };
    const res = await checkRateBucket('redis-a');
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(2);
    expect(calls).toEqual(['clean rl:min:redis-a', 'clean rl:hr:redis-a', 'clean rl:day:redis-a', 'clean rl:mo:redis-a']);
  });

  it('refuses, naming the window, when a window is full', async () => {
    redisState.redis = { pipeline: pipeline({ 'rl:hr:redis-b': 5 }, []) };
    expect(await checkRateBucket('redis-b')).toMatchObject({ allowed: false, reason: 'Rate limit exceeded (per-hour).', remaining: 0 });
  });

  it('lets the request through when Redis errors (fail open)', async () => {
    redisState.redis = { pipeline: () => ({ zremrangebyscore() { return this; }, zcard() { return this; }, zadd() { return this; }, pexpire() { return this; }, exec: async () => { throw new Error('down'); } }) };
    expect((await checkRateBucket('redis-c')).allowed).toBe(true);
  });

  it('falls back to memory when Redis is configured but not answering', async () => {
    config.redisUrl = 'redis://localhost:6379';
    redisState.redis = null;
    expect((await checkRateBucket(fresh())).allowed).toBe(true);
  });
});

describe('getClientIp', () => {
  const req = (headers: Record<string, string>, ip = '10.0.0.1') => ({ headers, ip }) as never;

  it('prefers the address Cloudflare sets', () => {
    expect(getClientIp(req({ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '1.1.1.1' }))).toBe('198.51.100.7');
  });
  it('ignores X-Forwarded-For unless proxies are trusted', () => {
    config.trustedProxyCount = 0;
    expect(getClientIp(req({ 'x-forwarded-for': '1.1.1.1' }))).toBe('10.0.0.1');
  });
  it('counts trusted hops from the right, so a client cannot invent its own address', () => {
    config.trustedProxyCount = 1;
    expect(getClientIp(req({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }))).toBe('203.0.113.9');
    config.trustedProxyCount = 2;
    expect(getClientIp(req({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }))).toBe('6.6.6.6');
    config.trustedProxyCount = 5;
    expect(getClientIp(req({ 'x-forwarded-for': '6.6.6.6' }))).toBe('6.6.6.6');
  });
});
