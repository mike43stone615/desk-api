// Small formatting helpers shared by the Billing, Webhooks and Apps pages (pure, so they can be tested).
export function formatMoney(cents, currency = 'usd') {
  const value = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: value % 1 === 0 ? 0 : 2 }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
}

/** "September 2026" for a period start such as 2026-09-01T00:00:00.000Z (UTC, so the month never shifts with the reader's time zone). */
export function monthLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** How much of the included allowance has been used, as a whole percent capped at 100, and whether it has gone over. */
export function usageShare(used, included) {
  const u = Math.max(0, Number(used) || 0);
  const inc = Math.max(0, Number(included) || 0);
  if (inc === 0) return { percent: u > 0 ? 100 : 0, over: u > 0, extra: u };
  return { percent: Math.min(100, Math.round((u / inc) * 100)), over: u > inc, extra: Math.max(0, u - inc) };
}

export const EVENT_LABELS = {
  'key.created': 'An API key is created',
  'key.revoked': 'An API key is revoked',
  'team.member_joined': 'Someone joins a team',
  'team.member_removed': 'Someone is removed from a team',
  'plan.changed': 'A plan changes',
  'oauth.app_authorized': 'An app is authorized',
  'usage.cap_reached': 'A daily usage cap is reached',
  'usage.threshold_reached': 'Monthly usage reaches 80% or 100% of the plan',
  'webhook.test': 'Test event', // not offered as a subscribable event (see WEBHOOK_EVENTS.filter in webhooks.js) -- this only
  // labels it where a test delivery can still show up: the deliveries history table.
};

export const SCOPE_LABELS = {
  profile: 'Your name and email address',
  drafts: 'Unfinished business setups',
  businesses: 'Businesses and their members',
  teams: 'Teams and their keys (GraphQL)',
};

/** One redirect address per line (or comma) -> a clean list; blank lines dropped, duplicates removed. */
export function parseLines(text) {
  return [...new Set(String(text || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean))];
}

export function statusChip(delivery) {
  return { delivered: 'Delivered', pending: 'Waiting to retry', failed: 'Failed' }[delivery.status] || delivery.status;
}
