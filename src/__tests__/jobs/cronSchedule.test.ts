// Which background jobs start, and when. Until 2026-10-13 a misplaced bracket registered the webhook worker, the mail
// outbox, the invoice run and the clean-ups INSIDE the 5-minute backend-key sweep: none of them ran until the first
// 5-minute mark after a start, and every sweep tick added another copy of each.
import { describe, it, expect, vi } from 'vitest';

const scheduled: Array<{ expression: string; run: () => unknown }> = [];
vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn((expression: string, run: () => unknown) => {
      scheduled.push({ expression, run });
      return { stop: vi.fn() };
    }),
  },
}));
vi.mock('../../db', () => ({ pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), connect: vi.fn() } }));
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));
vi.mock('../../domain/gateway/orphans', () => ({ sweepBackendKeys: vi.fn(async () => ({ revoked: 0, failed: 0 })) }));
vi.mock('../../domain/webhooks/webhooks', () => ({ processDueDeliveries: vi.fn(async () => 0), deleteOldDeliveries: vi.fn(async () => 0) }));
vi.mock('../../domain/email/outbox', () => ({ processOutbox: vi.fn(async () => ({ sent: 0, gaveUp: 0, waiting: 0 })) }));
vi.mock('../../domain/email/key-check', () => ({ checkMailKeyIfChanged: vi.fn(async () => 'not_configured') }));

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as import('fastify').FastifyBaseLogger;

describe('background jobs', () => {
  it('are all registered at start, once, and the 5-minute sweep adds none', async () => {
    const { startCleanupCron, stopCleanupCron } = await import('../../jobs/cron');
    startCleanupCron(log);
    const atStart = scheduled.map((s) => s.expression);
    // webhooks every 10 s, mail every minute, the sweep, nightly clean-up, delivery clean-up, usage prune, invoices, mail-key check
    for (const expr of ['*/10 * * * * *', '* * * * *', '*/5 * * * *', '0 2 * * *', '31 3 * * *', '50 4 * * *', '5 0 1 * *', '20 4 1 * *', '43 * * * *']) {
      expect(atStart, expr).toContain(expr);
    }
    expect(atStart.filter((e) => e === '*/10 * * * * *')).toHaveLength(1);
    expect(atStart.filter((e) => e === '20 4 1 * *')).toHaveLength(1);

    const sweep = scheduled.find((s) => s.expression === '*/5 * * * *')!;
    for (let i = 0; i < 3; i++) await sweep.run();
    expect(scheduled.map((s) => s.expression)).toEqual(atStart);
    stopCleanupCron();
  });

  it('does not start a webhook run while the previous one is still going', async () => {
    const { processDueDeliveries } = await import('../../domain/webhooks/webhooks');
    let finish!: () => void;
    vi.mocked(processDueDeliveries).mockImplementationOnce(() => new Promise<number>((r) => { finish = () => r(0); }));
    const tick = scheduled.find((s) => s.expression === '*/10 * * * * *')!;
    const before = vi.mocked(processDueDeliveries).mock.calls.length;
    tick.run();
    tick.run();
    expect(vi.mocked(processDueDeliveries).mock.calls.length).toBe(before + 1);
    finish();
    await new Promise((r) => setTimeout(r, 0));
    tick.run();
    expect(vi.mocked(processDueDeliveries).mock.calls.length).toBe(before + 2);
  });
});
