// What an app (OAuth) or an API Library key may read, one small piece at a time. A person approving an app sees exactly these
// pieces, so each one names a narrow slice of their data (their name separately from their email, a business's formation
// details separately from its plan, and so on). Everything here is read-only.
//
// The four original scopes (profile, drafts, businesses, teams) are still accepted from apps that already use them, and still
// mean what the person agreed to at the time: each expands to the pieces it covered then (see LEGACY_OAUTH_EXPANSION). New
// apps register the granular scopes.

export const GRANULAR_SCOPES = [
  'profile:name',
  'profile:email',
  'businesses:basic',
  'businesses:formation',
  'businesses:location',
  'businesses:idea',
  'businesses:plan',
  'businesses:requirements',
  'businesses:name_check',
  'businesses:market_research',
  'businesses:registered_agent',
  'businesses:members',
  'businesses:invites',
  'drafts:basic',
  'keys:read',
  'plan:read',
  'usage:read',
] as const;
export type GranularScope = (typeof GRANULAR_SCOPES)[number];

export const LEGACY_SCOPES = ['profile', 'drafts', 'businesses', 'teams'] as const;
export type LegacyScope = (typeof LEGACY_SCOPES)[number];

/** For an OAuth app: exactly what each original scope covered when a person approved it — never more. */
const LEGACY_OAUTH_EXPANSION: Record<LegacyScope, GranularScope[]> = {
  profile: ['profile:name', 'profile:email'],
  drafts: ['drafts:basic'],
  businesses: ['businesses:basic', 'businesses:members', 'businesses:invites'],
  teams: ['keys:read', 'plan:read', 'usage:read'],
};

/** For an API Library key: its owner reading their own data, so "businesses" covers every business detail. */
const KEY_SCOPE_EXPANSION: Record<'profile' | 'drafts' | 'businesses', GranularScope[]> = {
  profile: ['profile:name', 'profile:email'],
  drafts: ['drafts:basic'],
  businesses: GRANULAR_SCOPES.filter((s) => s.startsWith('businesses:')),
};

/** Plain-English description of each scope, shown on the consent page and the app registration form. */
export const SCOPE_DESCRIPTIONS: Record<GranularScope | LegacyScope, string> = {
  'profile:name': 'Your first and last name',
  'profile:email': 'Your email address and whether it is confirmed',
  'businesses:basic': "Your businesses' names and industries, and your role in each",
  'businesses:formation': 'How each business is set up: legal entity, tax election, special designation, state and city of formation, and partners',
  'businesses:location': "Each business's formation address",
  'businesses:idea': "Each business's idea and scope: what it does, its customers and their problem, where it sells, and other industries",
  'businesses:plan': "Each business's plan: its sections, pricing, competitors and validation plan",
  'businesses:requirements': "Each business's compliance requirements and regulatory statuses, and which ones you have marked",
  'businesses:name_check': "Each business's name-availability results",
  'businesses:market_research': "Each business's market research results",
  'businesses:registered_agent': "Each business's registered agent",
  'businesses:members': 'The people in each business: their names, email addresses and roles',
  'businesses:invites': "Invitations you have received to join someone else's business",
  'drafts:basic': 'Your unfinished business setups: their names, how far along they are, and when they were last changed',
  'keys:read': 'Your API keys: names, prefixes, dates and which APIs they can call (never the keys themselves)',
  'plan:read': 'Your API Library plan and its limits',
  'usage:read': 'Daily call and error counts for your API keys',
  profile: 'Your name and email address',
  drafts: 'Unfinished business setups',
  businesses: 'Businesses and their members',
  teams: 'Your API keys, plan and usage (GraphQL)',
};

export const ALL_OAUTH_SCOPES = [...GRANULAR_SCOPES, ...LEGACY_SCOPES] as const;
export type OAuthScope = (typeof ALL_OAUTH_SCOPES)[number];

const isLegacy = (s: string): s is LegacyScope => (LEGACY_SCOPES as readonly string[]).includes(s);

/** The granular scopes an app's (possibly legacy) scope list amounts to. */
export function expandOAuthScopes(scopes: Iterable<string>): Set<GranularScope> {
  const out = new Set<GranularScope>();
  for (const s of scopes) {
    if (isLegacy(s)) LEGACY_OAUTH_EXPANSION[s].forEach((g) => out.add(g));
    else if ((GRANULAR_SCOPES as readonly string[]).includes(s)) out.add(s as GranularScope);
  }
  return out;
}

/** The granular scopes an API Library key's Desk scopes amount to. */
export function expandKeyScopes(deskScopes: Iterable<string>): Set<GranularScope> {
  const out = new Set<GranularScope>();
  for (const s of deskScopes) (KEY_SCOPE_EXPANSION[s as keyof typeof KEY_SCOPE_EXPANSION] ?? []).forEach((g) => out.add(g));
  return out;
}
