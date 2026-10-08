// Small formatting helpers shared by the Billing, Webhooks and Apps pages (pure, so they can be tested).
export function formatMoney(cents, currency = 'usd') {
  const value = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: value % 1 === 0 ? 0 : 2 }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
}

/** How much of the included allowance has been used, as a whole percent capped at 100, and whether it has gone over. */
export function usageShare(used, included) {
  const u = Math.max(0, Number(used) || 0);
  const inc = Math.max(0, Number(included) || 0);
  if (inc === 0) return { percent: u > 0 ? 100 : 0, over: u > 0, extra: u };
  return { percent: Math.min(100, Math.round((u / inc) * 100)), over: u > inc, extra: Math.max(0, u - inc) };
}

// Listed in the order the Webhooks page shows them (the server's WEBHOOK_EVENTS order).
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
  'invoice.available': 'An invoice is available',
  'usage.desk_api_80': 'Monthly Desk API usage reached 80% of the plan',
  'usage.desk_api_100': 'Monthly Desk API usage reached 100% of the plan',
  'usage.registry_api_80': 'Monthly Business Name Registry API usage reached 80% of the plan',
  'usage.registry_api_100': 'Monthly Business Name Registry API usage reached 100% of the plan',
  'usage.market_validation_api_80': 'Monthly Market Validation API usage reached 80% of the plan',
  'usage.market_validation_api_100': 'Monthly Market Validation API usage reached 100% of the plan',
  'usage.market_analyses_80': 'Uncached Market Validation Analyses usage reached 80% of the plan',
  'usage.market_analyses_100': 'Uncached Market Validation Analyses usage reached 100% of the plan',
  'usage.total_80': 'Monthly total API calls usage reached 80% of the plan',
  'usage.total_100': 'Monthly total API calls usage reached 100% of the plan',
  'oauth.app_authorized': 'An app is authorized',
  'oauth.app_removed': 'An app is removed',
  'oauth.app_secret_rotated': 'An app secret is rotated',
  'oauth.redirect_added': 'A redirect address for an app is added',
  'oauth.redirect_removed': 'A redirect address for an app is removed',
  'oauth.scope_added': 'A readable for an app is added',
  'oauth.scope_removed': 'A readable for an app is removed',
  // Events that existed before: still labeled, so an old delivery in the history table does not show a raw code.
  'usage.cap_reached': 'A daily usage cap is reached',
  'usage.threshold_reached': 'Monthly usage reaches 80% or 100% of the plan',
  'webhook.test': 'Test event', // not offered as a subscribable event (see WEBHOOK_EVENTS.filter in webhooks.js) -- this only
  // labels it where a test delivery can still show up: the deliveries history table.
};

/** What an app may read (the server's own list: APP_SCOPES in src/domain/oauth/scopes.ts), grouped for the registration form.
    A card with `children` is a parent: its sub-checkboxes are details OF that list and only make sense with it, so ticking a
    child ticks its parent and unticking the parent unticks its children. `info` is the only extra text; most cards need none. */
export const SCOPE_GROUPS = [
  { title: 'Profile', scopes: [
    { id: 'profile:name', name: 'Name' },
    { id: 'profile:email', name: 'Email address' },
  ] },
  { title: 'Desk Business', scopes: [
    { id: 'businesses:basic', name: 'Business list', info: "Only businesses the person owns. An app never sees businesses they were only invited into, or anyone else's.", children: [
      { id: 'businesses:industry', name: 'Industry' },
      { id: 'businesses:location', name: 'Address' },
      { id: 'businesses:legal_entity', name: 'Legal entity' },
      { id: 'businesses:tax_election', name: 'Federal tax election' },
      { id: 'businesses:special_designation', name: 'Special legal designation' },
      { id: 'businesses:regulatory_status', name: 'Regulatory status' },
    ] },
  ] },
  { title: 'Desk API Library', scopes: [
    { id: 'keys:name', name: 'API key names', children: [
      { id: 'keys:dates', name: 'Key dates' },
      { id: 'keys:apis', name: 'APIs each key can call' },
      { id: 'usage:read', name: 'Monthly usage', info: "Each key's total calls and errors for a month. Never anything more detailed, like a single day." },
    ] },
    { id: 'webhooks:list', name: 'Webhook list', children: [
      { id: 'webhooks:events', name: 'Events' },
      { id: 'webhooks:dates', name: 'Webhook date' },
      { id: 'webhooks:active', name: 'Active/inactive' },
      { id: 'webhooks:deliveries', name: 'Deliveries' },
    ] },
  ] },
];

const flattenScopes = (items, parent = null) => items.flatMap((i) => [{ ...i, parent }, ...flattenScopes(i.children ?? [], i.id)]);
/** Every app scope as a flat list, each with its parent's id (or null). */
export const APP_SCOPE_LIST = SCOPE_GROUPS.flatMap((g) => flattenScopes(g.scopes));

export const SCOPE_LABELS = {
  ...Object.fromEntries(APP_SCOPE_LIST.map((x) => [x.id, x.name])),
  profile: 'Your name and email address',
  drafts: 'Unfinished setups (no longer available)',
  businesses: 'Business names and industries',
  teams: 'API key names, dates, APIs and usage',
};

/** A period as a short range for tight places: "Oct 1 - Oct 31, 2026" (or with both years when it spans two). */
export function periodShort(start, end) {
  const first = new Date(start);
  const last = new Date(new Date(end).getTime() - 86_400_000);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return '';
  const part = (d, year) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' });
  const sameYear = first.getUTCFullYear() === last.getUTCFullYear();
  return `${part(first, !sameYear)} - ${part(last, true)}`;
}

/** One redirect address per line (or comma) -> a clean list; blank lines dropped, duplicates removed. */
export function parseLines(text) {
  return [...new Set(String(text || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean))];
}

export function statusChip(delivery) {
  return { delivered: 'Delivered', pending: 'Waiting to retry', failed: 'Failed' }[delivery.status] || delivery.status;
}

/** "July 20, 2026 - August 19, 2026": a period's first and last day (its stored end is the next period's first moment). */
export function periodText(start, end) {
  const fmt = (d) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const first = new Date(start);
  const last = new Date(new Date(end).getTime() - 86_400_000);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return '';
  return `${fmt(first)} - ${fmt(last)}`;
}
