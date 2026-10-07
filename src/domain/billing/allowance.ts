// What a plan allows each person to call with their API Library keys (migration 0030): a per-minute and a per-month limit
// for each API, the same two for all three APIs together, and on Free a hard stop at the monthly limits. Paid plans keep
// working past a monthly limit and the extra calls are billed (invoiceLines in plans.ts). Per-minute limits always refuse.
//
// Counted per person (the key's owner), not per key: the limits are the plan's. A call is checked before it runs and
// counted after it succeeds (status below 400), so refused and failed calls never use up the allowance or cost money.
// Sandbox keys are never checked or counted (they call nothing). Two near-simultaneous calls can both pass the check at
// the very edge of a limit; that overshoot of one or two calls is accepted rather than locking on every call.
import { pool } from '../../db';
import { HttpError } from '../../middleware/http-error';
import { subscriptionFor, type Plan } from './plans';

export const METERED_SERVICES = ['desk_api', 'registry_api', 'market_validation_api'] as const;
export type MeteredService = (typeof METERED_SERVICES)[number];
export type CallTally = Record<MeteredService | 'total', number>;
export interface CallCounts { minute: CallTally; month: CallTally }

const minuteWindow = (now: Date) => `m${now.toISOString().slice(0, 16)}`;
const monthWindow = (now: Date) => `M${now.toISOString().slice(0, 7)}`;
const emptyTally = (): CallTally => ({ desk_api: 0, registry_api: 0, market_validation_api: 0, total: 0 });

/** This person's calls in the current minute and the current month (UTC), per API and in total. */
export async function callCounts(userId: string, now = new Date()): Promise<CallCounts> {
  const minute = minuteWindow(now);
  const counts: CallCounts = { minute: emptyTally(), month: emptyTally() };
  const { rows } = await pool.query<{ window_key: string; service: MeteredService; calls: number }>(
    `SELECT window_key, service, calls FROM api_usage WHERE user_id = $1 AND window_key IN ($2, $3)`,
    [userId, minute, monthWindow(now)],
  );
  for (const r of rows) {
    const tally = r.window_key === minute ? counts.minute : counts.month;
    tally[r.service] += Number(r.calls);
    tally.total += Number(r.calls);
  }
  return counts;
}

/** Seconds until the next UTC month starts (when a Free plan's monthly limits reset). */
export function secondsToNextMonth(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

const SERVICE_NAMES: Record<MeteredService, string> = {
  desk_api: 'the Desk API', registry_api: 'the Business Name Registry API', market_validation_api: 'the Market Validation API',
};

/** Pure: why one more call to `service` must be refused right now, or null when it may go ahead. */
export function callRefusal(plan: Plan, counts: CallCounts, service: MeteredService, now = new Date()): { code: string; message: string; retryAfterSeconds: number } | null {
  const toNextMinute = Math.max(1, 60 - now.getUTCSeconds());
  if (counts.minute[service] >= plan.servicePerMinute) {
    return { code: 'plan_minute_limit', message: `Your ${plan.name} plan allows ${plan.servicePerMinute} calls a minute to ${SERVICE_NAMES[service]}. Try again in a minute.`, retryAfterSeconds: toNextMinute };
  }
  if (counts.minute.total >= plan.totalPerMinute) {
    return { code: 'plan_minute_limit', message: `Your ${plan.name} plan allows ${plan.totalPerMinute} calls a minute across all APIs. Try again in a minute.`, retryAfterSeconds: toNextMinute };
  }
  if (plan.overageCentsPerCall !== null) return null; // a paid plan keeps going past its monthly limits; the extra is billed
  if (counts.month[service] >= plan.servicePerMonth) {
    return { code: 'plan_monthly_limit', message: `Your ${plan.name} plan's ${plan.servicePerMonth} calls this month to ${SERVICE_NAMES[service]} are used up. Upgrade your plan to keep calling it.`, retryAfterSeconds: secondsToNextMonth(now) };
  }
  if (counts.month.total >= plan.totalPerMonth) {
    return { code: 'plan_monthly_limit', message: `Your ${plan.name} plan's ${plan.totalPerMonth} calls this month across all APIs are used up. Upgrade your plan to keep calling.`, retryAfterSeconds: secondsToNextMonth(now) };
  }
  return null;
}

/** Pure: why one more market analysis must be refused, or null. Only a plan that does not bill extra analyses stops. */
export function analysisRefusal(plan: Plan, usedThisMonth: number, now = new Date()): { code: string; message: string; retryAfterSeconds: number } | null {
  if (plan.overageCentsPerAnalysis !== null || usedThisMonth < plan.includedAnalyses) return null;
  return { code: 'plan_analysis_limit', message: `Your ${plan.name} plan's ${plan.includedAnalyses} market analyses this month are used up. Upgrade your plan to run more.`, retryAfterSeconds: secondsToNextMonth(now) };
}

/** A 429 the error handler turns into a problem answer with a Retry-After header. */
export function limitError(refusal: { code: string; message: string; retryAfterSeconds: number }): HttpError {
  return Object.assign(new HttpError(429, refusal.message, refusal.code), { retryAfterSeconds: refusal.retryAfterSeconds });
}

/** Throws a 429 when the person's plan does not allow one more call to `service` now. */
export async function enforceCallAllowance(userId: string, service: MeteredService): Promise<void> {
  const [{ plan }, counts] = await Promise.all([subscriptionFor('user', userId), callCounts(userId)]);
  const refusal = callRefusal(plan, counts, service);
  if (refusal) throw limitError(refusal);
}

/** Counts one call that went through. Fire-and-forget: counting must never slow down or break the call itself. */
export function recordCall(userId: string, service: MeteredService, now = new Date()): void {
  Promise.resolve(
    pool.query(
      `INSERT INTO api_usage (user_id, service, window_key, calls) VALUES ($1, $2, $3, 1), ($1, $2, $4, 1)
       ON CONFLICT (user_id, window_key, service) DO UPDATE SET calls = api_usage.calls + 1`,
      [userId, service, minuteWindow(now), monthWindow(now)],
    ),
  ).catch(() => {});
}

/** Pure: how many of a month's calls are billed as extra — each call beyond any monthly limit, counted once. */
export function extraCalls(plan: Plan, month: CallTally): number {
  const beyondEach = METERED_SERVICES.reduce((n, s) => n + Math.max(0, month[s] - plan.servicePerMonth), 0);
  return Math.max(beyondEach, Math.max(0, month.total - plan.totalPerMonth));
}

/** One month's call counts for a person, for invoicing (month = YYYY-MM). */
export async function monthTally(userId: string, month: string): Promise<CallTally> {
  const tally = emptyTally();
  const { rows } = await pool.query<{ service: MeteredService; calls: number }>(`SELECT service, calls FROM api_usage WHERE user_id = $1 AND window_key = $2`, [userId, `M${month}`]);
  for (const r of rows) { tally[r.service] += Number(r.calls); tally.total += Number(r.calls); }
  return tally;
}

/** Deletes per-minute rows older than a day (run daily). Returns how many went. */
export async function pruneMinuteUsage(now = new Date()): Promise<number> {
  const res = await pool.query(`DELETE FROM api_usage WHERE window_key LIKE 'm%' AND window_key < $1`, [minuteWindow(new Date(now.getTime() - 86_400_000))]);
  return res.rowCount ?? 0;
}

/** How many webhook endpoints and (not revoked) apps the person has: what the plan's limits are counted against. */
export async function ownedCounts(userId: string): Promise<{ webhooks: number; apps: number }> {
  const { rows } = await pool.query<{ webhooks: string; apps: string }>(
    `SELECT (SELECT COUNT(*) FROM webhook_endpoints WHERE owner_user_id = $1) AS webhooks,
            (SELECT COUNT(*) FROM oauth_clients WHERE owner_user_id = $1 AND revoked_at IS NULL) AS apps`,
    [userId],
  );
  return { webhooks: Number(rows[0]?.webhooks ?? 0), apps: Number(rows[0]?.apps ?? 0) };
}
