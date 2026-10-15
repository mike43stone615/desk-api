// Plans, subscriptions, metering and invoices. There is NO payment provider yet: a plan is assigned by an administrator
// (subscriptions.provider = 'manual'), usage is metered exactly, and a draft invoice is produced for each subscription each
// month from that metering. Connecting a provider later means collecting the invoice, not redoing the counting.
//
// Everybody starts on the Free plan, whose limits are the ones that applied before plans existed, so nothing changes for
// anyone until they are moved to another plan.
import { randomUUID } from 'node:crypto';
import { pool } from '../../db';
import { config } from '../../config';
import { emitWebhookEvent, usageEvent } from '../webhooks/webhooks';
import { sendUsageThresholdEmail } from '../../infrastructure/email/resend';
import { extraCalls, METERED_SERVICES, monthTally, percentJustReached, type CallTally, type MeteredService } from './allowance';

const SERVICE_NAMES: Record<MeteredService, string> = { desk_api: 'Desk API', registry_api: 'Business Name Registry API', market_validation_api: 'Market Validation API' };

export type SubjectType = 'user' | 'team';

export interface Plan {
  id: string;
  name: string;
  description: string;
  monthlyPriceCents: number;
  includedAnalyses: number;
  overageCentsPerAnalysis: number | null;
  /** Kept for API compatibility: the same number as totalPerMinute (plans.per_minute_limit was dropped in 0034). */
  perMinuteLimit: number | null;
  maxKeys: number;
  maxWebhooks: number;
  maxApps: number;
  /** Calls a minute / a month to each API, and to all three together (migration 0030). */
  servicePerMinute: number;
  servicePerMonth: number;
  totalPerMinute: number;
  totalPerMonth: number;
  /** What one call beyond a monthly limit costs; null = such calls are refused (Free). */
  overageCentsPerCall: number | null;
}

interface PlanRow {
  id: string; name: string; description: string; monthly_price_cents: number; included_analyses: number;
  overage_cents_per_analysis: number | null; max_keys: number; max_webhooks: number;
  max_apps: number; service_per_minute: number; service_per_month: number; total_per_minute: number; total_per_month: number;
  overage_cents_per_call: number | null;
}
const PLAN_FIELDS = ['id', 'name', 'description', 'monthly_price_cents', 'included_analyses', 'overage_cents_per_analysis',
  'max_keys', 'max_webhooks', 'max_apps', 'service_per_minute', 'service_per_month', 'total_per_minute', 'total_per_month', 'overage_cents_per_call'];
const PLAN_COLUMNS = PLAN_FIELDS.join(', ');
const PLAN_COLUMNS_P = PLAN_FIELDS.map((f) => `p.${f}`).join(', ');
const toPlan = (r: PlanRow): Plan => ({
  id: r.id, name: r.name, description: r.description, monthlyPriceCents: r.monthly_price_cents, includedAnalyses: r.included_analyses,
  overageCentsPerAnalysis: r.overage_cents_per_analysis ?? null, perMinuteLimit: r.total_per_minute, maxKeys: r.max_keys, maxWebhooks: r.max_webhooks,
  maxApps: r.max_apps, servicePerMinute: r.service_per_minute, servicePerMonth: r.service_per_month, totalPerMinute: r.total_per_minute,
  totalPerMonth: r.total_per_month, overageCentsPerCall: r.overage_cents_per_call ?? null,
});

/** The plan used when nothing is recorded (and if the plans table cannot be read): the limits that applied before plans. */
export const FALLBACK_FREE_PLAN: Plan = {
  id: 'free', name: 'Free', description: '', monthlyPriceCents: 0, includedAnalyses: 5, overageCentsPerAnalysis: null, perMinuteLimit: 100, maxKeys: 10, maxWebhooks: 3,
  maxApps: 1, servicePerMinute: 60, servicePerMonth: 300, totalPerMinute: 100, totalPerMonth: 500, overageCentsPerCall: null,
};

export async function listPlans(): Promise<Plan[]> {
  const { rows } = await pool.query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM plans WHERE active ORDER BY sort_order, id`);
  return rows.map(toPlan);
}

export interface Subscription {
  id: string | null;
  subjectType: SubjectType;
  subjectId: string;
  plan: Plan;
  status: 'active' | 'past_due' | 'canceled';
  periodStart: string;
  periodEnd: string;
  provider: string;
  /** A change waiting for its date (a downgrade starts on the 1st of next month), or null. */
  scheduledChange: { planId: string; planName: string; effectiveAt: string } | null;
}

const monthStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const nextMonth = (start: Date) => new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

/** The subject's current subscription, or a virtual Free one when none is recorded. A change that has come due is applied first. */
export async function subscriptionFor(subjectType: SubjectType, subjectId: string): Promise<Subscription> {
  const start = monthStart();
  const virtual = (plan: Plan): Subscription => ({ id: null, subjectType, subjectId, plan, status: 'active', periodStart: start.toISOString(), periodEnd: nextMonth(start).toISOString(), provider: 'manual', scheduledChange: null });
  try {
    const read = () => pool.query<PlanRow & { sid: string; status: Subscription['status']; period_start: string; period_end: string; provider: string; scheduled_plan_id: string | null; scheduled_for: string | null; scheduled_name: string | null }>(
      `SELECT s.id AS sid, s.status, s.period_start, s.period_end, s.provider, s.scheduled_plan_id, s.scheduled_for, sp.name AS scheduled_name, ${PLAN_COLUMNS_P}
         FROM subscriptions s JOIN plans p ON p.id = s.plan_id LEFT JOIN plans sp ON sp.id = s.scheduled_plan_id
        WHERE s.subject_type = $1 AND s.subject_id = $2 AND s.status <> 'canceled'`,
      [subjectType, subjectId],
    );
    let r = (await read()).rows[0];
    // The job on the 1st applies due changes; this makes a lookup right after midnight never see a stale plan.
    if (r?.scheduled_for && Date.parse(r.scheduled_for) <= Date.now()) {
      await applyDueScheduledChanges(new Date(), { subjectType, subjectId });
      r = (await read()).rows[0];
    }
    if (r) {
      return {
        id: r.sid, subjectType, subjectId, plan: toPlan(r), status: r.status, periodStart: r.period_start, periodEnd: r.period_end, provider: r.provider,
        scheduledChange: r.scheduled_plan_id && r.scheduled_for ? { planId: r.scheduled_plan_id, planName: r.scheduled_name ?? r.scheduled_plan_id, effectiveAt: r.scheduled_for } : null,
      };
    }
    const free = (await pool.query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM plans WHERE id = 'free'`)).rows[0];
    return virtual(free ? toPlan(free) : FALLBACK_FREE_PLAN);
  } catch {
    return virtual(FALLBACK_FREE_PLAN);
  }
}

export class BillingError extends Error {
  constructor(public readonly code: 'unknown_plan' | 'not_found' | 'payment_method_required', message: string) {
    super(message);
    this.name = 'BillingError';
  }
}

async function planById(planId: string): Promise<Plan> {
  const { rows } = await pool.query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM plans WHERE id = $1 AND active`, [planId]);
  if (!rows[0]) throw new BillingError('unknown_plan', 'No such plan.');
  return toPlan(rows[0]);
}

/**
 * Switches at once: the current subscription ends now (canceled_at) and the new one starts now, so the month's invoice
 * charges each for its own part of the month. The old subscription is closed, not edited, so history stays.
 */
/**
 * Ends the current subscription and starts the new plan at `at`. With `claimScheduled` (a subscription id), it only does so
 * if that subscription still has its waiting change, locked first: a scheduled change is applied by whichever request
 * reads the subscription first on the 1st, and two at once used to apply it twice (two active subscriptions: a
 * Business -> Pro downgrade would then bill Pro twice). Returns false when another request got there first.
 */
async function switchNow(subjectType: SubjectType, subjectId: string, planId: string, at = new Date(), claimScheduled?: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (claimScheduled) {
      const claim = await client.query(
        `SELECT id FROM subscriptions WHERE id = $1 AND status <> 'canceled' AND scheduled_plan_id IS NOT NULL FOR UPDATE`,
        [claimScheduled],
      );
      if (claim.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }
    }
    await client.query(
      `UPDATE subscriptions SET status = 'canceled', canceled_at = $3, scheduled_plan_id = NULL, scheduled_for = NULL
        WHERE subject_type = $1 AND subject_id = $2 AND status <> 'canceled'`,
      [subjectType, subjectId, at.toISOString()],
    );
    if (planId !== 'free') {
      const start = monthStart(at);
      await client.query(
        `INSERT INTO subscriptions (id, subject_type, subject_id, plan_id, status, period_start, period_end, created_at) VALUES ($1, $2, $3, $4, 'active', $5, $6, $7)`,
        [randomUUID(), subjectType, subjectId, planId, start.toISOString(), nextMonth(start).toISOString(), at.toISOString()],
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function assertSubject(subjectType: SubjectType, subjectId: string): Promise<void> {
  // Teams no longer exist: only a person can hold a plan.
  const { rows } = subjectType === 'user' ? await pool.query(`SELECT 1 FROM users WHERE id = $1`, [subjectId]) : { rows: [] };
  if (!rows[0]) throw new BillingError('not_found', `No such ${subjectType}.`);
}

/** Puts a person or team on a plan at once (administrator action, and how an upgrade is applied). */
export async function assignPlan(subjectType: SubjectType, subjectId: string, planId: string): Promise<Subscription> {
  await planById(planId);
  await assertSubject(subjectType, subjectId);
  await switchNow(subjectType, subjectId, planId);
  return subscriptionFor(subjectType, subjectId);
}

/** True when the person has a payment method on file (migration 0038; added once a payment provider is connected). */
export async function hasPaymentMethod(userId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM payment_methods WHERE user_id = $1 LIMIT 1`, [userId]);
  return rows.length > 0;
}

/** Pure: a paid plan needs a payment method on file; Free never does, and neither does an administrator granting a plan. */
export function paymentMethodMissing(target: Pick<Plan, 'monthlyPriceCents'>, hasMethod: boolean, byAdministrator: boolean): boolean {
  return target.monthlyPriceCents > 0 && !hasMethod && !byAdministrator;
}

/**
 * A plan change the way a customer expects it:
 *   - an upgrade (a dearer plan) starts at once, and this month is charged for each plan's own part of it (prorated);
 *   - a downgrade (a cheaper plan) starts on the 1st of next month: the current plan, and everything it allows, stays
 *     until then. Asking again before then replaces the waiting change; asking for the current plan cancels it.
 * `when: 'now'` makes any change at once (an administrator correcting something).
 * A change to a paid plan needs a payment method on file, unless `byAdministrator` (granting a plan by hand).
 */
export async function changePlan(subjectType: SubjectType, subjectId: string, planId: string, when: 'auto' | 'now' = 'auto', byAdministrator = false): Promise<{ subscription: Subscription; effectiveAt: string; scheduled: boolean }> {
  const target = await planById(planId);
  await assertSubject(subjectType, subjectId);
  const current = await subscriptionFor(subjectType, subjectId);
  if (current.plan.id !== target.id && paymentMethodMissing(target, await hasPaymentMethod(subjectId), byAdministrator)) {
    throw new BillingError('payment_method_required', 'Add a payment method before switching to a paid plan.');
  }
  if (current.plan.id === target.id) {
    if (current.id) await pool.query(`UPDATE subscriptions SET scheduled_plan_id = NULL, scheduled_for = NULL WHERE id = $1`, [current.id]);
    return { subscription: await subscriptionFor(subjectType, subjectId), effectiveAt: new Date().toISOString(), scheduled: false };
  }
  if (when === 'auto' && target.monthlyPriceCents < current.plan.monthlyPriceCents && current.id) {
    const effectiveAt = nextMonth(monthStart()).toISOString();
    await pool.query(`UPDATE subscriptions SET scheduled_plan_id = $2, scheduled_for = $3 WHERE id = $1`, [current.id, target.id, effectiveAt]);
    return { subscription: await subscriptionFor(subjectType, subjectId), effectiveAt, scheduled: true };
  }
  await switchNow(subjectType, subjectId, target.id);
  return { subscription: await subscriptionFor(subjectType, subjectId), effectiveAt: new Date().toISOString(), scheduled: false };
}

/**
 * Applies every waiting change whose date has come (the job on the 1st; also any lookup after that date). The change
 * takes effect at its scheduled moment, not when this runs, so the invoices are exact even if the job runs late.
 * Returns the subjects changed (for their webhook and the key limiter).
 */
export async function applyDueScheduledChanges(now = new Date(), only?: { subjectType: SubjectType; subjectId: string }): Promise<Array<{ subjectType: SubjectType; subjectId: string; planId: string }>> {
  const { rows } = await pool.query<{ id: string; subject_type: SubjectType; subject_id: string; scheduled_plan_id: string; scheduled_for: string }>(
    `SELECT id, subject_type, subject_id, scheduled_plan_id, scheduled_for FROM subscriptions
      WHERE status <> 'canceled' AND scheduled_plan_id IS NOT NULL AND scheduled_for IS NOT NULL
        ${only ? 'AND subject_type = $1 AND subject_id = $2' : ''}`,
    only ? [only.subjectType, only.subjectId] : [],
  );
  const done: Array<{ subjectType: SubjectType; subjectId: string; planId: string }> = [];
  for (const r of rows) {
    const at = new Date(r.scheduled_for);
    if (Number.isNaN(at.getTime()) || at.getTime() > now.getTime()) continue;
    if (!(await switchNow(r.subject_type, r.subject_id, r.scheduled_plan_id, at, r.id))) continue; // applied by another request
    done.push({ subjectType: r.subject_type, subjectId: r.subject_id, planId: r.scheduled_plan_id });
    // "scheduled: false" = this change is now in effect (the notice sent when it was scheduled said "scheduled: true").
    if (r.subject_type === 'user') emitWebhookEvent({ userId: r.subject_id }, 'plan.changed', { subjectType: r.subject_type, subjectId: r.subject_id, plan: r.scheduled_plan_id, scheduled: false, effectiveAt: at.toISOString() });
  }
  return done;
}

/** Counts one market analysis for the person, or for the team when the key belongs to one. Fire-and-forget. */
export function meterAnalysis(subjectType: SubjectType, subjectId: string): void {
  void (async () => {
    const { rows } = await pool.query<{ quantity: number }>(
      `INSERT INTO usage_meter (subject_type, subject_id, month, metric, quantity) VALUES ($1, $2, $3, 'market_analyses', 1)
       ON CONFLICT (subject_type, subject_id, month, metric) DO UPDATE SET quantity = usage_meter.quantity + 1
       RETURNING quantity`,
      [subjectType, subjectId, monthKey()],
    );
    const used = rows[0]?.quantity;
    if (used !== undefined) await checkUsageThreshold(subjectType, subjectId, used);
  })().catch(() => {});
}

/**
 * A daily-metered analysis just pushed this month's count to exactly the 80% or the 100% mark of the plan's included
 * amount (checked against the exact new total, so this fires once per threshold, not on every call afterward). Tells
 * whoever should know: a webhook event, and an e-mail to the account (or every accepted owner/admin of a team).
 */
async function checkUsageThreshold(subjectType: SubjectType, subjectId: string, used: number): Promise<void> {
  const { plan } = await subscriptionFor(subjectType, subjectId);
  if (plan.includedAnalyses <= 0) return;
  const percent = percentJustReached(used, plan.includedAnalyses);
  if (percent === null) return;
  emitWebhookEvent({ userId: subjectId }, usageEvent('market_analyses', percent), { percent, used, included: plan.includedAnalyses, month: monthKey() });
  const recipients = (await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [subjectId])).rows.map((r) => r.email);
  for (const email of recipients) sendUsageThresholdEmail(config, email, percent, used, plan.includedAnalyses).catch(() => {});
}

export async function analysesInMonth(subjectType: SubjectType, subjectId: string, month = monthKey()): Promise<number> {
  const { rows } = await pool.query<{ quantity: number }>(
    `SELECT quantity FROM usage_meter WHERE subject_type = $1 AND subject_id = $2 AND month = $3 AND metric = 'market_analyses'`,
    [subjectType, subjectId, month],
  );
  return Number(rows[0]?.quantity ?? 0);
}

export interface InvoiceLine { description: string; quantity: number; unitCents: number; totalCents: number }
/** `number` is the running invoice number (1, 2, 3 ...), never reused: shown as INV-000001. */
export interface Invoice {
  id: string; number: number; subjectType: SubjectType; subjectId: string; planId: string; periodStart: string; periodEnd: string; currency: string;
  lines: InvoiceLine[]; subtotalCents: number; status: 'draft' | 'open' | 'paid' | 'void'; createdAt: string;
  /** The plan's name as it is now (e.g. "Pro"). */
  planName: string;
}

/** The lines of one month's invoice for a subscription, from exact metering. Pure. */
export function invoiceLines(plan: Plan, analyses: number, calls?: CallTally): InvoiceLine[] {
  const lines: InvoiceLine[] = [];
  if (plan.monthlyPriceCents > 0) lines.push({ description: `${plan.name} plan, one month`, quantity: 1, unitCents: plan.monthlyPriceCents, totalCents: plan.monthlyPriceCents });
  const extra = Math.max(0, analyses - plan.includedAnalyses);
  if (extra > 0 && plan.overageCentsPerAnalysis) {
    lines.push({ description: `Uncached market validation analyses beyond the ${plan.includedAnalyses.toLocaleString('en-US')} included`, quantity: extra, unitCents: plan.overageCentsPerAnalysis, totalCents: extra * plan.overageCentsPerAnalysis });
  }
  // One line per API over its own monthly limit, then (only if the all-APIs limit was passed by more than those add up to)
  // one line for the rest: together exactly extraCalls(). Each says how many calls were included, so the total can be checked.
  if (calls && plan.overageCentsPerCall) {
    let counted = 0;
    for (const service of METERED_SERVICES) {
      const over = Math.max(0, calls[service] - plan.servicePerMonth);
      if (over <= 0) continue;
      counted += over;
      lines.push({ description: `${SERVICE_NAMES[service]} calls beyond the ${plan.servicePerMonth.toLocaleString('en-US')} included`, quantity: over, unitCents: plan.overageCentsPerCall, totalCents: over * plan.overageCentsPerCall });
    }
    const rest = extraCalls(plan, calls) - counted;
    if (rest > 0) {
      lines.push({ description: `API calls beyond the ${plan.totalPerMonth.toLocaleString('en-US')} included across all APIs`, quantity: rest, unitCents: plan.overageCentsPerCall, totalCents: rest * plan.overageCentsPerCall });
    }
  }
  return lines;
}

/** One plan's stretch of a month: from `from` to `to` (milliseconds), within the month. */
export interface PlanSegment { plan: Plan; from: number; to: number }

const dayLabel = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * The lines of one month's invoice when the plan may have changed during it. Pure.
 *   - each paid plan's fee for the part of the month it was active (the whole fee for a whole month);
 *   - usage beyond the limits of the plan active at the end of the month (the one the month's usage was allowed under).
 */
export function invoiceLinesForMonth(segments: PlanSegment[], monthStartMs: number, monthEndMs: number, analyses: number, calls?: CallTally): InvoiceLine[] {
  const lines: InvoiceLine[] = [];
  const monthMs = monthEndMs - monthStartMs;
  const monthDays = Math.round(monthMs / 86_400_000);
  for (const seg of segments) {
    if (seg.plan.monthlyPriceCents <= 0 || seg.to <= seg.from) continue;
    if (seg.from <= monthStartMs && seg.to >= monthEndMs) {
      lines.push({ description: `${seg.plan.name} plan, one month`, quantity: 1, unitCents: seg.plan.monthlyPriceCents, totalCents: seg.plan.monthlyPriceCents });
      continue;
    }
    const cents = Math.round((seg.plan.monthlyPriceCents * (seg.to - seg.from)) / monthMs);
    if (cents <= 0) continue;
    // To a tenth of a day: two halves of a 31-day month read "15.5 of 31 days" each (whole days rounded both up to 16).
    const days = Math.max(0.1, Math.round((seg.to - seg.from) / 8_640_000) / 10);
    lines.push({
      description: `${seg.plan.name} plan, ${dayLabel(seg.from)} to ${dayLabel(seg.to - 1)} (${days} of ${monthDays} days)`,
      quantity: 1, unitCents: cents, totalCents: cents,
    });
  }
  const last = segments[segments.length - 1];
  if (last) lines.push(...invoiceLines({ ...last.plan, monthlyPriceCents: 0 }, analyses, calls));
  return lines;
}

/** Each subscription's stretch within the month, in order. Pure. A subscription canceled without a time (before 0035) counts as nothing. */
export function segmentsInMonth(rows: Array<{ plan: Plan; createdAt: string; canceledAt: string | null; canceled: boolean }>, monthStartMs: number, monthEndMs: number): PlanSegment[] {
  return rows
    .map((r) => {
      const begun = Date.parse(r.createdAt);
      const ended = r.canceled ? (r.canceledAt ? Date.parse(r.canceledAt) : begun) : monthEndMs;
      return { plan: r.plan, from: Math.max(begun, monthStartMs), to: Math.min(ended, monthEndMs) };
    })
    .filter((x) => !Number.isNaN(x.from) && !Number.isNaN(x.to) && x.to > x.from)
    .sort((a, b) => a.from - b.from);
}

/**
 * Makes the draft invoice for every person or team that had a paid plan during the given month (YYYY-MM, default: last
 * month), charging each plan for its own part of the month. Safe to run again: one invoice per subject per month.
 * Returns how many were created.
 */
export async function generateInvoices(month?: string): Promise<number> {
  const now = new Date();
  const target = month ?? monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  const start = new Date(`${target}-01T00:00:00Z`);
  const end = nextMonth(start);
  // Changes due by the end of that month belong to it (normally already applied by the job at 00:05 on the 1st).
  await applyDueScheduledChanges(end);
  const { rows } = await pool.query<PlanRow & { subject_type: SubjectType; subject_id: string; created_at: string; canceled_at: string | null; status: string }>(
    `SELECT s.subject_type, s.subject_id, s.created_at, s.canceled_at, s.status, ${PLAN_COLUMNS_P}
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.created_at < $1 AND (s.status <> 'canceled' OR s.canceled_at > $2)`,
    [end.toISOString(), start.toISOString()],
  );
  const bySubject = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.subject_type}:${r.subject_id}`;
    bySubject.set(k, [...(bySubject.get(k) ?? []), r]);
  }
  let made = 0;
  for (const subjectRows of bySubject.values()) {
    const { subject_type: subjectType, subject_id: subjectId } = subjectRows[0];
    const segments = segmentsInMonth(subjectRows.map((r) => ({ plan: toPlan(r), createdAt: r.created_at, canceledAt: r.canceled_at, canceled: r.status === 'canceled' })), start.getTime(), end.getTime());
    if (segments.length === 0) continue;
    const calls = subjectType === 'user' ? await monthTally(subjectId, target) : undefined;
    const lines = invoiceLinesForMonth(segments, start.getTime(), end.getTime(), await analysesInMonth(subjectType, subjectId, target), calls);
    if (lines.length === 0) continue;
    const plan = segments[segments.length - 1].plan;
    const total = lines.reduce((n, l) => n + l.totalCents, 0);
    const res = await pool.query(
      `INSERT INTO invoices (id, subject_type, subject_id, plan_id, period_start, period_end, lines, subtotal_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (subject_type, subject_id, period_start) DO NOTHING`,
      [randomUUID(), subjectType, subjectId, plan.id, start.toISOString(), end.toISOString(), JSON.stringify(lines), total],
    );
    made += res.rowCount ?? 0;
    if (res.rowCount && subjectType === 'user') {
      emitWebhookEvent({ userId: subjectId }, 'invoice.available', { period: target, plan: plan.id, subtotalCents: total });
    }
  }
  return made;
}

/** One page of the subject's invoices, newest first. Asks for one more than `limit` to know whether more follow. */
export async function invoicesFor(subjectType: SubjectType, subjectId: string, page: { limit?: number; offset?: number } = {}): Promise<{ invoices: Invoice[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(page.limit ?? 10, 1), 50);
  const offset = Math.max(page.offset ?? 0, 0);
  const { rows } = await pool.query<{ id: string; number: string; plan_id: string; period_start: string; period_end: string; currency: string; lines: string; subtotal_cents: number; status: Invoice['status']; created_at: string; plan_name: string | null }>(
    `SELECT i.id, i.number, i.plan_id, i.period_start, i.period_end, i.currency, i.lines, i.subtotal_cents, i.status, i.created_at, p.name AS plan_name
       FROM invoices i LEFT JOIN plans p ON p.id = i.plan_id
      WHERE i.subject_type = $1 AND i.subject_id = $2 ORDER BY i.period_start DESC, i.id LIMIT $3 OFFSET $4`,
    [subjectType, subjectId, limit + 1, offset],
  );
  const invoices = rows.slice(0, limit).map((r) => ({ id: r.id, number: Number(r.number), subjectType, subjectId, planId: r.plan_id, periodStart: r.period_start, periodEnd: r.period_end, currency: r.currency, lines: JSON.parse(r.lines) as InvoiceLine[], subtotalCents: r.subtotal_cents, status: r.status, createdAt: r.created_at, planName: r.plan_name ?? r.plan_id }));
  return { invoices, hasMore: rows.length > limit };
}

export async function setInvoiceStatus(id: string, status: Invoice['status']): Promise<boolean> {
  const res = await pool.query(`UPDATE invoices SET status = $2 WHERE id = $1`, [id, status]);
  return (res.rowCount ?? 0) > 0;
}
