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
  'key.rotated': 'An API key is rotated',
  'key.suspended': 'An API key is switched off',
  'key.resumed': 'An API key is switched on',
  'key.revoked': 'An API key is revoked',
  'key.service_added': 'An API is enabled on an existing key',
  'key.service_removed': 'An API is disabled on an existing key',
  'key.share_invited': 'Someone is invited to a key',
  'key.share_accepted': 'Someone joins a shared key',
  'key.share_removed': 'Someone is removed from a shared key',
  'plan.changed': 'A plan changes',
  'oauth.app_authorized': 'An app is authorized',
  'usage.cap_reached': 'A daily usage cap is reached',
  'usage.threshold_reached': 'Monthly usage reaches 80% or 100% of the plan',
  'webhook.test': 'Test event', // not offered as a subscribable event (see WEBHOOK_EVENTS.filter in webhooks.js) -- this only
  // labels it where a test delivery can still show up: the deliveries history table.
};

/** What an app may read, one narrow piece each (the server's own list: src/domain/oauth/scopes.ts), grouped for the
    registration form: [scope, short name, what it covers]. */
export const SCOPE_GROUPS = [
  { title: 'Profile', scopes: [
    ['profile:name', 'Name', 'Your first and last name'],
    ['profile:email', 'Email address', 'Your email address and whether it is confirmed'],
  ] },
  { title: 'Businesses', scopes: [
    ['businesses:basic', 'Business list', "Your businesses' names and industries, and your role in each"],
    ['businesses:formation', 'Formation details', 'Legal entity, tax election, special designation, state and city of formation, and partners'],
    ['businesses:location', 'Address', "Each business's formation address"],
    ['businesses:idea', 'Idea and scope', 'What each business does, its customers and their problem, where it sells, and other industries'],
    ['businesses:plan', 'Business plan', 'Plan sections, pricing, competitors and validation plan'],
    ['businesses:requirements', 'Compliance requirements', 'Compliance requirements and regulatory statuses, and which ones you have marked'],
    ['businesses:name_check', 'Name check', 'Name-availability results'],
    ['businesses:market_research', 'Market research', 'Market research results'],
    ['businesses:registered_agent', 'Registered agent', "Each business's registered agent"],
    ['businesses:members', 'Members', 'The people in each business: their names, email addresses and roles'],
    ['businesses:invites', 'Invitations', "Invitations you have received to join someone else's business"],
  ] },
  { title: 'Unfinished setups', scopes: [
    ['drafts:basic', 'Unfinished setups', 'Their names, how far along they are, and when they were last changed'],
  ] },
  { title: 'API Library', scopes: [
    ['keys:read', 'API keys', 'Names, prefixes, dates and which APIs they can call (never the keys themselves)'],
    ['plan:read', 'Plan', 'Your API Library plan and its limits'],
    ['usage:read', 'Usage', 'Daily call and error counts for your API keys'],
  ] },
];

/** A short name for every scope an app can hold: the granular ones, plus the four original ones older apps still use. */
export const SCOPE_LABELS = {
  ...Object.fromEntries(SCOPE_GROUPS.flatMap((g) => g.scopes.map(([id, name]) => [id, name]))),
  profile: 'Your name and email address',
  drafts: 'Unfinished business setups',
  businesses: 'Businesses and their members',
  teams: 'Your API keys, plan and usage (GraphQL)',
};

/** One redirect address per line (or comma) -> a clean list; blank lines dropped, duplicates removed. */
export function parseLines(text) {
  return [...new Set(String(text || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean))];
}

export function statusChip(delivery) {
  return { delivered: 'Delivered', pending: 'Waiting to retry', failed: 'Failed' }[delivery.status] || delivery.status;
}
