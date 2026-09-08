import { describe, it, expect, vi, beforeEach } from 'vitest';

const deleteExpiredSessions = vi.fn(async () => {});
const deleteExpiredPasswordResetTokens = vi.fn(async () => {});
const deleteExpiredEmailConfirmationTokens = vi.fn(async () => {});

vi.mock('../../infrastructure/auth', () => ({
  authDb: {
    deleteExpiredSessions,
    deleteExpiredPasswordResetTokens,
    deleteExpiredEmailConfirmationTokens,
  },
}));

const redisSet = vi.fn();
let redisAvailable = false;

vi.mock('../../middleware/redis-client', () => ({
  getRedis: () => (redisAvailable ? { set: redisSet } : null),
  connectRedis: vi.fn(),
}));

const fakeLog = {
  info: vi.fn(),
  error: vi.fn(),
} as unknown as import('fastify').FastifyBaseLogger;

describe('cron auth-cleanup coordination lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisAvailable = false;
  });

  it('runs cleanup as before when Redis is not configured (no coordination possible or needed)', async () => {
    const { runCleanup } = await import('../../jobs/cron');
    await runCleanup(fakeLog);

    expect(deleteExpiredSessions).toHaveBeenCalledTimes(1);
    expect(deleteExpiredPasswordResetTokens).toHaveBeenCalledTimes(1);
    expect(deleteExpiredEmailConfirmationTokens).toHaveBeenCalledTimes(1);
  });

  it('runs cleanup when it wins the Redis lock (NX succeeds)', async () => {
    redisAvailable = true;
    redisSet.mockResolvedValue('OK');
    const { runCleanup } = await import('../../jobs/cron');
    await runCleanup(fakeLog);

    expect(redisSet).toHaveBeenCalledWith(
      'desk-api:cron:auth-cleanup:lock',
      expect.any(String),
      'PX',
      expect.any(Number),
      'NX',
    );
    expect(deleteExpiredSessions).toHaveBeenCalledTimes(1);
  });

  it('skips cleanup when another instance already holds the lock (NX fails)', async () => {
    redisAvailable = true;
    redisSet.mockResolvedValue(null); // another instance's key already exists
    const { runCleanup } = await import('../../jobs/cron');
    await runCleanup(fakeLog);

    expect(deleteExpiredSessions).not.toHaveBeenCalled();
    expect(deleteExpiredPasswordResetTokens).not.toHaveBeenCalled();
    expect(deleteExpiredEmailConfirmationTokens).not.toHaveBeenCalled();
    expect(fakeLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'cron_auth_cleanup_skipped' }),
      expect.any(String),
    );
  });

  it('fails open (runs cleanup) if the Redis lock call itself errors', async () => {
    redisAvailable = true;
    redisSet.mockRejectedValue(new Error('connection reset'));
    const { runCleanup } = await import('../../jobs/cron');
    await runCleanup(fakeLog);

    expect(deleteExpiredSessions).toHaveBeenCalledTimes(1);
  });
});
