// A month's invoice when the plan changed during it: each plan pays for its own part of the month; usage is judged by
// the plan in force at the end of the month.
import { describe, it, expect } from 'vitest';
import { FALLBACK_FREE_PLAN, invoiceLinesForMonth, segmentsInMonth, type Plan } from '../domain/billing/plans';

const PRO: Plan = { ...FALLBACK_FREE_PLAN, id: 'developer', name: 'Pro', monthlyPriceCents: 1500, includedAnalyses: 75, overageCentsPerAnalysis: 15, servicePerMonth: 3000, totalPerMonth: 5000, overageCentsPerCall: 5 };
const BIZ: Plan = { ...PRO, id: 'business', name: 'Business', monthlyPriceCents: 5000, includedAnalyses: 350, servicePerMonth: 15000, totalPerMonth: 15000, overageCentsPerCall: 3 };
const OCT = Date.parse('2026-10-01T00:00:00Z');
const NOV = Date.parse('2026-11-01T00:00:00Z');
const at = (iso: string) => Date.parse(iso);

describe('segmentsInMonth', () => {
  it('cuts each subscription to the month and orders them', () => {
    const segs = segmentsInMonth([
      { plan: BIZ, createdAt: '2026-10-28T00:00:00Z', canceledAt: null, canceled: false },
      { plan: PRO, createdAt: '2026-09-15T00:00:00Z', canceledAt: '2026-10-28T00:00:00Z', canceled: true },
    ], OCT, NOV);
    expect(segs.map((s) => [s.plan.id, new Date(s.from).toISOString(), new Date(s.to).toISOString()])).toEqual([
      ['developer', '2026-10-01T00:00:00.000Z', '2026-10-28T00:00:00.000Z'],
      ['business', '2026-10-28T00:00:00.000Z', '2026-11-01T00:00:00.000Z'],
    ]);
  });

  it('a subscription ended before the month, begun after it, or canceled with no time (before 0035) counts for nothing', () => {
    expect(segmentsInMonth([
      { plan: PRO, createdAt: '2026-08-01T00:00:00Z', canceledAt: '2026-09-20T00:00:00Z', canceled: true },
      { plan: PRO, createdAt: '2026-11-03T00:00:00Z', canceledAt: null, canceled: false },
      { plan: PRO, createdAt: '2026-10-05T00:00:00Z', canceledAt: null, canceled: true },
    ], OCT, NOV)).toEqual([]);
  });
});

describe('invoiceLinesForMonth', () => {
  it('a whole month on one plan: the plan fee once, as before', () => {
    expect(invoiceLinesForMonth([{ plan: PRO, from: OCT, to: NOV }], OCT, NOV, 0)).toEqual([{ description: 'Pro plan, one month', quantity: 1, unitCents: 1500, totalCents: 1500 }]);
  });

  it('an upgrade from Free on the 28th pays only for the days on Pro (4 of 31)', () => {
    const lines = invoiceLinesForMonth([{ plan: FALLBACK_FREE_PLAN, from: OCT, to: at('2026-10-28T00:00:00Z') }, { plan: PRO, from: at('2026-10-28T00:00:00Z'), to: NOV }], OCT, NOV, 0);
    expect(lines).toEqual([{ description: 'Pro plan, Oct 28 to Oct 31 (4 of 31 days)', quantity: 1, unitCents: 194, totalCents: 194 }]);
  });

  it('Pro to Business mid-month: each plan for its own days, adding up to the right total', () => {
    const mid = at('2026-10-16T12:00:00Z');
    const lines = invoiceLinesForMonth([{ plan: PRO, from: OCT, to: mid }, { plan: BIZ, from: mid, to: NOV }], OCT, NOV, 0);
    expect(lines.map((l) => l.description)).toEqual(['Pro plan, Oct 1 to Oct 16 (15.5 of 31 days)', 'Business plan, Oct 16 to Oct 31 (15.5 of 31 days)']);
    expect(lines.map((l) => l.totalCents)).toEqual([750, 2500]); // exactly half a month each
  });

  it('extra usage is charged at the rates of the plan in force at the end of the month', () => {
    const tally = { desk_api: 3100, registry_api: 0, market_validation_api: 0, total: 3100 };
    const lines = invoiceLinesForMonth([{ plan: PRO, from: OCT, to: at('2026-10-20T00:00:00Z') }, { plan: BIZ, from: at('2026-10-20T00:00:00Z'), to: NOV }], OCT, NOV, 400, tally);
    // Business: 15,000 calls and 350 analyses included -> 50 extra analyses at 15c, no extra calls
    expect(lines.slice(2)).toEqual([{ description: 'Uncached market validation analyses beyond the 350 included', quantity: 50, unitCents: 15, totalCents: 750 }]);
  });

  it('a free plan for the whole month gives no lines', () => {
    expect(invoiceLinesForMonth([{ plan: FALLBACK_FREE_PLAN, from: OCT, to: NOV }], OCT, NOV, 5)).toEqual([]);
  });
});
