import { describe, expect, it } from 'vitest';
import { FALLBACK_FREE_PLAN, invoiceLines, type Plan } from '../domain/billing/plans';
import { analysisRefusal, callRefusal, eightyPercentOf, extraCalls, limitError, percentJustReached, secondsToNextMonth, type CallCounts, type CallTally } from '../domain/billing/allowance';
import { limitsFor } from '../domain/gateway/usage';
import { USAGE_METERS, WEBHOOK_EVENTS, usageEvent } from '../domain/webhooks/webhooks';

const FREE = FALLBACK_FREE_PLAN;
const PRO: Plan = {
  ...FREE, id: 'developer', name: 'Pro', monthlyPriceCents: 1500, includedAnalyses: 75, overageCentsPerAnalysis: 15, maxApps: 3,
  servicePerMinute: 600, servicePerMonth: 3000, totalPerMinute: 1000, totalPerMonth: 5000, overageCentsPerCall: 5,
};
const tally = (t: Partial<CallTally> = {}): CallTally => ({ desk_api: 0, registry_api: 0, market_validation_api: 0, total: 0, ...t });
const counts = (minute: Partial<CallTally> = {}, month: Partial<CallTally> = {}): CallCounts => ({ minute: tally(minute), month: tally(month) });
const AT = new Date('2026-10-07T14:05:20Z');

describe('plan call limits', () => {
  it('lets a call through while every limit has room', () => {
    expect(callRefusal(FREE, counts({ registry_api: 59, total: 99 }, { registry_api: 299, total: 499 }), 'registry_api', AT)).toBeNull();
  });

  it('refuses at a per-minute limit, for one API or all together, on every plan, until the minute ends', () => {
    const one = callRefusal(PRO, counts({ desk_api: 600, total: 600 }), 'desk_api', AT);
    expect(one).toMatchObject({ code: 'plan_minute_limit', retryAfterSeconds: 40 });
    expect(one?.message).toMatch(/600 calls a minute to the Desk API/);
    expect(callRefusal(PRO, counts({ desk_api: 10, total: 1000 }), 'desk_api', AT)?.message).toMatch(/1000 calls a minute across all APIs/);
  });

  it('stops Free at a monthly limit (each API, then all together) until next month', () => {
    const r = callRefusal(FREE, counts({}, { market_validation_api: 300, total: 300 }), 'market_validation_api', AT);
    expect(r).toMatchObject({ code: 'plan_monthly_limit', retryAfterSeconds: secondsToNextMonth(AT) });
    expect(callRefusal(FREE, counts({}, { market_validation_api: 300, total: 300 }), 'desk_api', AT)).toBeNull(); // the others still have room
    expect(callRefusal(FREE, counts({}, { desk_api: 250, registry_api: 250, total: 500 }), 'market_validation_api', AT)?.message).toMatch(/500 calls this month across all APIs/);
  });

  it('keeps a paid plan going past its monthly limits (the extra is billed)', () => {
    expect(callRefusal(PRO, counts({}, { registry_api: 9000, total: 9000 }), 'registry_api', AT)).toBeNull();
  });

  it('counts each call beyond any monthly limit once', () => {
    expect(extraCalls(PRO, tally({ registry_api: 3010, total: 3010 }))).toBe(10);
    expect(extraCalls(PRO, tally({ desk_api: 2000, registry_api: 2000, market_validation_api: 2000, total: 6000 }))).toBe(1000);
    expect(extraCalls(PRO, tally({ desk_api: 3500, registry_api: 2000, total: 5500 }))).toBe(500);
    expect(extraCalls(PRO, tally({ desk_api: 100, total: 100 }))).toBe(0);
  });

  it('bills extra calls on an invoice, and never on Free', () => {
    expect(invoiceLines(PRO, 0, tally({ registry_api: 3010, total: 3010 }))).toEqual([
      { description: 'Pro plan, one month', quantity: 1, unitCents: 1500, totalCents: 1500 },
      { description: "API calls beyond the plan's monthly limits", quantity: 10, unitCents: 5, totalCents: 50 },
    ]);
    expect(invoiceLines(FREE, 0, tally({ registry_api: 9000, total: 9000 }))).toEqual([]);
  });

  it('stops Free at its included market analyses; paid plans bill the extra', () => {
    expect(analysisRefusal(FREE, 4, AT)).toBeNull();
    expect(analysisRefusal(FREE, 5, AT)).toMatchObject({ code: 'plan_analysis_limit' });
    expect(analysisRefusal(PRO, 500, AT)).toBeNull();
  });

  it('turns a refusal into a 429 that says when to come back', () => {
    const err = limitError({ code: 'plan_minute_limit', message: 'slow down', retryAfterSeconds: 12 });
    expect(err).toMatchObject({ status: 429, code: 'plan_minute_limit', retryAfterSeconds: 12, message: 'slow down' });
  });

  it('works out the wait until next month', () => {
    expect(secondsToNextMonth(new Date('2026-12-31T23:59:30Z'))).toBe(30);
  });
});

describe('the plans make money even at the worst case', () => {
  // A market analysis is the only call a key can make that costs Desk per call: about $0.12 at worst (Google Places text
  // search, up to 3 pages, plus Foursquare). Every other key-callable route reads Desk's own or free government data.
  const WORST_ANALYSIS_CENTS = 12;
  it('each paid plan covers its included analyses, and each extra analysis or call costs more than it costs Desk', () => {
    for (const plan of [PRO, { ...PRO, name: 'Business', monthlyPriceCents: 5000, includedAnalyses: 350, overageCentsPerCall: 3 }]) {
      expect(plan.includedAnalyses * WORST_ANALYSIS_CENTS).toBeLessThan(plan.monthlyPriceCents);
      expect(plan.overageCentsPerAnalysis!).toBeGreaterThan(WORST_ANALYSIS_CENTS);
      expect(plan.overageCentsPerCall!).toBeGreaterThan(0);
    }
    expect(FREE.includedAnalyses * WORST_ANALYSIS_CENTS).toBeLessThanOrEqual(60); // Free costs at most $0.60 a month
  });
});

describe('the limit notes shown when picking an API for a key', () => {
  const note = (plan: Plan, service: string) => limitsFor(plan).find((l) => l.service === service)!.note;
  it("state the person's own plan's numbers, not one fixed number", () => {
    expect(note(FREE, 'desk_api')).toContain('Your Free plan allows 60 calls a minute and 300 a month to the Desk API');
    expect(note(PRO, 'desk_api')).toContain('Your Pro plan allows 600 calls a minute and 3,000 a month to the Desk API');
    expect(note(PRO, 'registry_api')).toContain('to the Business Name Registry API');
    expect(note(PRO, 'desk_api')).toContain('All three APIs together: 1,000 a minute and 5,000 a month.');
  });
  it('say what happens past a monthly limit on that plan', () => {
    expect(note(FREE, 'desk_api')).toContain('calls are refused until next month');
    expect(note(PRO, 'desk_api')).toContain('cost $0.05 each');
    expect(note(PRO, 'market_validation_api')).toContain('75 market analyses a month; each extra one costs $0.15');
    expect(note(FREE, 'market_validation_api')).toContain('5 market analyses a month; after that they are refused');
  });
});

describe('monthly usage marks (80% and 100%)', () => {
  it('is 80% rounded up, only when that is below the limit', () => {
    expect(eightyPercentOf(300)).toBe(240);
    expect(eightyPercentOf(5)).toBe(4);
    expect(eightyPercentOf(1)).toBeNull();
    expect(eightyPercentOf(0)).toBeNull();
  });
  it('fires on exactly the mark a call reaches, once', () => {
    expect(percentJustReached(239, 300)).toBeNull();
    expect(percentJustReached(240, 300)).toBe(80);
    expect(percentJustReached(241, 300)).toBeNull();
    expect(percentJustReached(300, 300)).toBe(100);
    expect(percentJustReached(301, 300)).toBeNull();
    expect(percentJustReached(5, 0)).toBeNull();
  });
  it('has a webhook event for each meter at each mark, in the list people choose from', () => {
    for (const meter of USAGE_METERS) for (const p of [80, 100] as const) expect(WEBHOOK_EVENTS).toContain(usageEvent(meter, p));
    expect(WEBHOOK_EVENTS).toContain('invoice.available');
    expect(WEBHOOK_EVENTS).not.toContain('usage.cap_reached');
    expect(WEBHOOK_EVENTS).not.toContain('usage.threshold_reached');
  });
});
