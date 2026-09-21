// Plans, subscriptions, metering and invoices. There is NO payment provider yet: a plan is assigned by an administrator
// (subscriptions.provider = 'manual'), usage is metered exactly, and a draft invoice is produced for each subscription each
// month from that metering. Connecting a provider later means collecting the invoice, not redoing the counting.
//
// Everybody starts on the Free plan, whose limits are the ones that applied before plans existed, so nothing changes for
// anyone until they are moved to another plan.
import { randomUUID } from 'node:crypto';
import { pool } from '../../db';

export type SubjectType = 'user' | 'team';

export interface Plan {
  id: string;
  name: string;
  description: string;
  monthlyPriceCents: number;
  includedAnalyses: number;
  overageCentsPerAnalysis: number | null;
  perMinuteLimit: number | null;
  maxKeys: number;
  maxWebhooks: number;
}

interface PlanRow {
  id: string; name: string; description: string; monthly_price_cents: number; included_analyses: number;
  overage_cents_per_analysis: number | null; per_minute_limit: number | null; max_keys: number; max_webhooks: number;
}
const PLAN_COLUMNS = 'id, name, description, monthly_price_cents, included_analyses, overage_cents_per_analysis, per_minute_limit, max_keys, max_webhooks';
const toPlan = (r: PlanRow): Plan => ({
  id: r.id, name: r.name, description: r.description, monthlyPriceCents: r.monthly_price_cents, includedAnalyses: r.included_analyses,
  overageCentsPerAnalysis: r.overage_cents_per_analysis ?? null, perMinuteLimit: r.per_minute_limit ?? null, maxKeys: r.max_keys, maxWebhooks: r.max_webhooks,
});

/** The plan used when nothing is recorded (and if the plans table cannot be read): the limits that applied before plans. */
export const FALLBACK_FREE_PLAN: Plan = {
  id: 'free', name: 'Free', description: '', monthlyPriceCents: 0, includedAnalyses: 300, overageCentsPerAnalysis: null, perMinuteLimit: null, maxKeys: 10, maxWebhooks: 3,
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
}

const monthStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const nextMonth = (start: Date) => new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

/** The subject's current subscription, or a virtual Free one when none is recorded. */
export async function subscriptionFor(subjectType: SubjectType, subjectId: string): Promise<Subscription> {
  const start = monthStart();
  const virtual = (plan: Plan): Subscription => ({ id: null, subjectType, subjectId, plan, status: 'active', periodStart: start.toISOString(), periodEnd: nextMonth(start).toISOString(), provider: 'manual' });
  try {
    const { rows } = await pool.query<PlanRow & { sid: string; status: Subscription['status']; period_start: string; period_end: string; provider: string }>(
      `SELECT s.id AS sid, s.status, s.period_start, s.period_end, s.provider, p.id, p.name, p.description, p.monthly_price_cents, p.included_analyses,
              p.overage_cents_per_analysis, p.per_minute_limit, p.max_keys, p.max_webhooks
         FROM subscriptions s JOIN plans p ON p.id = s.plan_id
        WHERE s.subject_type = $1 AND s.subject_id = $2 AND s.status <> 'canceled'`,
      [subjectType, subjectId],
    );
    const r = rows[0];
    if (r) return { id: r.sid, subjectType, subjectId, plan: toPlan(r), status: r.status, periodStart: r.period_start, periodEnd: r.period_end, provider: r.provider };
    const free = (await pool.query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM plans WHERE id = 'free'`)).rows[0];
    return virtual(free ? toPlan(free) : FALLBACK_FREE_PLAN);
  } catch {
    return virtual(FALLBACK_FREE_PLAN);
  }
}

export class BillingError extends Error {
  constructor(public readonly code: 'unknown_plan' | 'not_found', message: string) {
    super(message);
    this.name = 'BillingError';
  }
}

/** Puts a person or team on a plan (administrator action). The old subscription is closed, not edited, so history stays. */
export async function assignPlan(subjectType: SubjectType, subjectId: string, planId: string): Promise<Subscription> {
  const { rows: p } = await pool.query(`SELECT 1 FROM plans WHERE id = $1 AND active`, [planId]);
  if (!p[0]) throw new BillingError('unknown_plan', 'No such plan.');
  const { rows: subject } = await pool.query(subjectType === 'user' ? `SELECT 1 FROM users WHERE id = $1` : `SELECT 1 FROM teams WHERE id = $1`, [subjectId]);
  if (!subject[0]) throw new BillingError('not_found', `No such ${subjectType}.`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE subscriptions SET status = 'canceled' WHERE subject_type = $1 AND subject_id = $2 AND status <> 'canceled'`, [subjectType, subjectId]);
    if (planId !== 'free') {
      const start = monthStart();
      await client.query(
        `INSERT INTO subscriptions (id, subject_type, subject_id, plan_id, status, period_start, period_end) VALUES ($1, $2, $3, $4, 'active', $5, $6)`,
        [randomUUID(), subjectType, subjectId, planId, start.toISOString(), nextMonth(start).toISOString()],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return subscriptionFor(subjectType, subjectId);
}

/** Counts one market analysis for the person, or for the team when the key belongs to one. Fire-and-forget. */
export function meterAnalysis(subjectType: SubjectType, subjectId: string): void {
  Promise.resolve(
    pool.query(
      `INSERT INTO usage_meter (subject_type, subject_id, month, metric, quantity) VALUES ($1, $2, $3, 'market_analyses', 1)
       ON CONFLICT (subject_type, subject_id, month, metric) DO UPDATE SET quantity = usage_meter.quantity + 1`,
      [subjectType, subjectId, monthKey()],
    ),
  ).catch(() => {});
}

export async function analysesInMonth(subjectType: SubjectType, subjectId: string, month = monthKey()): Promise<number> {
  const { rows } = await pool.query<{ quantity: number }>(
    `SELECT quantity FROM usage_meter WHERE subject_type = $1 AND subject_id = $2 AND month = $3 AND metric = 'market_analyses'`,
    [subjectType, subjectId, month],
  );
  return Number(rows[0]?.quantity ?? 0);
}

export interface InvoiceLine { description: string; quantity: number; unitCents: number; totalCents: number }
export interface Invoice {
  id: string; subjectType: SubjectType; subjectId: string; planId: string; periodStart: string; periodEnd: string; currency: string;
  lines: InvoiceLine[]; subtotalCents: number; status: 'draft' | 'open' | 'paid' | 'void'; createdAt: string;
}

/** The lines of one month's invoice for a subscription, from exact metering. Pure. */
export function invoiceLines(plan: Plan, analyses: number): InvoiceLine[] {
  const lines: InvoiceLine[] = [];
  if (plan.monthlyPriceCents > 0) lines.push({ description: `${plan.name} plan, one month`, quantity: 1, unitCents: plan.monthlyPriceCents, totalCents: plan.monthlyPriceCents });
  const extra = Math.max(0, analyses - plan.includedAnalyses);
  if (extra > 0 && plan.overageCentsPerAnalysis) {
    lines.push({ description: `Market analyses beyond the ${plan.includedAnalyses.toLocaleString('en-US')} included`, quantity: extra, unitCents: plan.overageCentsPerAnalysis, totalCents: extra * plan.overageCentsPerAnalysis });
  }
  return lines;
}

/**
 * Makes the draft invoice for every active paid subscription for the given month (YYYY-MM, default: last month).
 * Safe to run again: one invoice per subject per month. Returns how many were created.
 */
export async function generateInvoices(month?: string): Promise<number> {
  const now = new Date();
  const target = month ?? monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  const start = new Date(`${target}-01T00:00:00Z`);
  const end = nextMonth(start);
  const { rows } = await pool.query<PlanRow & { subject_type: SubjectType; subject_id: string }>(
    `SELECT s.subject_type, s.subject_id, p.id, p.name, p.description, p.monthly_price_cents, p.included_analyses, p.overage_cents_per_analysis,
            p.per_minute_limit, p.max_keys, p.max_webhooks
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.status <> 'canceled' AND s.created_at < $1`,
    [end.toISOString()],
  );
  let made = 0;
  for (const r of rows) {
    const plan = toPlan(r);
    const lines = invoiceLines(plan, await analysesInMonth(r.subject_type, r.subject_id, target));
    if (lines.length === 0) continue;
    const res = await pool.query(
      `INSERT INTO invoices (id, subject_type, subject_id, plan_id, period_start, period_end, lines, subtotal_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (subject_type, subject_id, period_start) DO NOTHING`,
      [randomUUID(), r.subject_type, r.subject_id, plan.id, start.toISOString(), end.toISOString(), JSON.stringify(lines), lines.reduce((n, l) => n + l.totalCents, 0)],
    );
    made += res.rowCount ?? 0;
  }
  return made;
}

export async function invoicesFor(subjectType: SubjectType, subjectId: string): Promise<Invoice[]> {
  const { rows } = await pool.query<{ id: string; plan_id: string; period_start: string; period_end: string; currency: string; lines: string; subtotal_cents: number; status: Invoice['status']; created_at: string }>(
    `SELECT id, plan_id, period_start, period_end, currency, lines, subtotal_cents, status, created_at FROM invoices
      WHERE subject_type = $1 AND subject_id = $2 ORDER BY period_start DESC LIMIT 60`,
    [subjectType, subjectId],
  );
  return rows.map((r) => ({ id: r.id, subjectType, subjectId, planId: r.plan_id, periodStart: r.period_start, periodEnd: r.period_end, currency: r.currency, lines: JSON.parse(r.lines) as InvoiceLine[], subtotalCents: r.subtotal_cents, status: r.status, createdAt: r.created_at }));
}

export async function setInvoiceStatus(id: string, status: Invoice['status']): Promise<boolean> {
  const res = await pool.query(`UPDATE invoices SET status = $2 WHERE id = $1`, [id, status]);
  return (res.rowCount ?? 0) > 0;
}
