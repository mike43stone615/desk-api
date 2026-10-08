// What each API key has been used for: one row per key per day (migration 0017). A developer sees their own numbers
// (GET /gateway/api-keys/:id/usage); nothing here is per-caller detail, only counts.
import { pool } from '../../db';
import { gatewayCallsTotal } from '../../modules/metrics';
import { KEY_IDLE_DAYS } from './keys';
import type { Plan } from '../billing/plans';

const today = () => new Date().toISOString().slice(0, 10);

/** Counts one call made with a key. Fire-and-forget: counting must never slow down or break the call itself. */
export function recordKeyUsage(keyId: string, service: string, status: number): void {
  const outcome = status === 429 ? 'rate_limited' : status >= 500 ? 'server_error' : status >= 400 ? 'client_error' : 'ok';
  gatewayCallsTotal.inc({ service, outcome });
  Promise.resolve(
    pool.query(
      `INSERT INTO gateway_key_usage (api_key_id, day, calls, errors) VALUES ($1, $2, 1, $3)
       ON CONFLICT (api_key_id, day) DO UPDATE SET calls = gateway_key_usage.calls + 1, errors = gateway_key_usage.errors + $3`,
      [keyId, today(), status >= 400 ? 1 : 0],
    ),
  ).catch(() => {});
}

export interface DailyUsage { day: string; calls: number; errors: number }

/** The last `days` days (newest first) that had any calls. The caller must already have checked the key is theirs. */
export async function keyUsage(keyId: string, days: number): Promise<DailyUsage[]> {
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const { rows } = await pool.query<{ day: string; calls: number; errors: number }>(
    `SELECT day, calls, errors FROM gateway_key_usage WHERE api_key_id = $1 AND day >= $2 ORDER BY day DESC`,
    [keyId, since],
  );
  return rows.map((r) => ({ day: r.day, calls: Number(r.calls), errors: Number(r.errors) }));
}

export interface MonthlyUsage { month: string; calls: number; errors: number }

/** The last `months` calendar months (newest first, this one included) that had any calls: monthly totals only, no per-day detail. */
export async function keyUsageMonthly(keyId: string, months: number, now = new Date()): Promise<MonthlyUsage[]> {
  const first = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1);
  const days = Math.ceil((now.getTime() - first) / 86_400_000) + 1;
  const byMonth = new Map<string, MonthlyUsage>();
  for (const d of await keyUsage(keyId, days)) {
    const month = d.day.slice(0, 7);
    const row = byMonth.get(month) ?? { month, calls: 0, errors: 0 };
    row.calls += d.calls; row.errors += d.errors;
    byMonth.set(month, row);
  }
  return [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month));
}

const num = (n: number) => n.toLocaleString('en-US');
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * What a developer needs to know about limits, for THEIR plan (docs/API-LIMITS.md says the same). The limits belong to the
 * plan and are counted per person across all their keys, so every line is the plan's number, not a per-key one. One line
 * per fact (the page shows a line each in the hover note).
 */
export function limitsFor(plan: Plan): Array<{ service: string; perMinute: number; note: string }> {
  const together = `All three APIs together: ${num(plan.totalPerMinute)} a minute and ${num(plan.totalPerMonth)} a month.`;
  const pastMonthly = plan.overageCentsPerCall === null
    ? 'Past a monthly limit, calls are refused until next month.'
    : `Past a monthly limit, calls keep working and cost ${dollars(plan.overageCentsPerCall)} each.`;
  const lines = (api: string, extra: string[] = []) => [
    `Your ${plan.name} plan allows ${num(plan.servicePerMinute)} calls a minute and ${num(plan.servicePerMonth)} a month to the ${api}, shared by all your keys.`,
    together,
    pastMonthly,
    ...extra,
  ].join('\n');
  const analyses = plan.overageCentsPerAnalysis === null
    ? `Your plan includes ${num(plan.includedAnalyses)} market analyses a month; after that they are refused until next month.`
    : `Your plan includes ${num(plan.includedAnalyses)} market analyses a month; each extra one costs ${dollars(plan.overageCentsPerAnalysis)}.`;
  return [
    { service: 'desk_api', perMinute: plan.servicePerMinute, note: lines('Desk API') },
    { service: 'registry_api', perMinute: plan.servicePerMinute, note: lines('Business Name Registry API', ['The answers carry X-RateLimit-* headers.']) },
    { service: 'market_validation_api', perMinute: plan.servicePerMinute, note: lines('Market Validation API', [analyses, 'A key can run 2 market analyses at once.']) },
  ];
}

export const IDLE_DAYS = KEY_IDLE_DAYS;
