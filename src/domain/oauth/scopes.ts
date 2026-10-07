// What an app (OAuth) or an API Library key may read, one small piece at a time. Everything here is read-only.
//
// Two lists:
//   * APP_SCOPES — what a third-party app may register for and a person may approve. Deliberately narrow: an app sees only
//     the person's own businesses (ones they own), and never data that is really someone else's to share (members,
//     partners), or that a person would not expect an app to collect (their business idea, plan, research, compliance
//     work, unfinished setups, their plan, or any part of an API key's secret, including its prefix).
//   * GRANULAR_SCOPES — every piece, including the internal ones above that only a person's OWN API Library key (and a
//     signed-in session) can read. A key's Desk scopes expand to these (expandKeyScopes).
//
// The four original scopes (profile, drafts, businesses, teams) are still accepted from apps that already use them; each
// expands only to app-allowed pieces (LEGACY_OAUTH_EXPANSION), so nothing an app could read is wider than APP_SCOPES.

export const APP_SCOPES = [
  'profile:name',
  'profile:email',
  'businesses:basic',
  'businesses:industry',
  'businesses:location',
  'businesses:legal_entity',
  'businesses:tax_election',
  'businesses:special_designation',
  'businesses:regulatory_status',
  'keys:name',
  'keys:dates',
  'keys:apis',
  'usage:read',
] as const;
export type AppScope = (typeof APP_SCOPES)[number];

/** Readable only through the person's own API key or a signed-in session — never by an app. */
const INTERNAL_SCOPES = [
  'businesses:role',
  'businesses:partners',
  'businesses:idea',
  'businesses:plan',
  'businesses:requirements',
  'businesses:name_check',
  'businesses:market_research',
  'businesses:registered_agent',
  'businesses:members',
  'businesses:invites',
  'drafts:basic',
  'keys:prefix',
  'plan:read',
] as const;

export const GRANULAR_SCOPES = [...APP_SCOPES, ...INTERNAL_SCOPES] as const;
export type GranularScope = (typeof GRANULAR_SCOPES)[number];

export const LEGACY_SCOPES = ['profile', 'drafts', 'businesses', 'teams'] as const;
export type LegacyScope = (typeof LEGACY_SCOPES)[number];

/** For an OAuth app: what each original scope still opens, limited to app-allowed pieces. */
const LEGACY_OAUTH_EXPANSION: Record<LegacyScope, AppScope[]> = {
  profile: ['profile:name', 'profile:email'],
  drafts: [],
  businesses: ['businesses:basic', 'businesses:industry'],
  teams: ['keys:name', 'keys:dates', 'keys:apis', 'usage:read'],
};

/** For an API Library key: its owner reading their own data, so "businesses" covers every business detail. */
const KEY_SCOPE_EXPANSION: Record<'profile' | 'drafts' | 'businesses', GranularScope[]> = {
  profile: ['profile:name', 'profile:email'],
  drafts: ['drafts:basic'],
  businesses: GRANULAR_SCOPES.filter((s) => s.startsWith('businesses:')),
};

/** Plain-English description of each scope, shown on the consent page (only app scopes and the original four can appear there). */
export const SCOPE_DESCRIPTIONS: Record<GranularScope | LegacyScope, string> = {
  'profile:name': 'Your first and last name',
  'profile:email': 'Your email address and whether it is confirmed',
  'businesses:basic': 'The names of the businesses you own',
  'businesses:industry': "Each of your businesses' industry",
  'businesses:location': "Each of your businesses' formation address, city and state",
  'businesses:legal_entity': "Each of your businesses' legal entity",
  'businesses:tax_election': "Each of your businesses' federal tax election",
  'businesses:special_designation': "Each of your businesses' special legal designation",
  'businesses:regulatory_status': "Each of your businesses' regulatory statuses",
  'keys:name': 'The names of your API keys (never the keys themselves)',
  'keys:dates': 'When each of your API keys was created, last used and expires',
  'keys:apis': 'Which APIs each of your API keys can call',
  'usage:read': 'Daily call and error counts for your API keys',
  'businesses:role': 'Your role in each business',
  'businesses:partners': "Whether each business has partners, and how many",
  'businesses:idea': "Each business's idea and scope",
  'businesses:plan': "Each business's plan",
  'businesses:requirements': "Each business's compliance requirements",
  'businesses:name_check': "Each business's name-availability results",
  'businesses:market_research': "Each business's market research",
  'businesses:registered_agent': "Each business's registered agent",
  'businesses:members': 'The people in each business',
  'businesses:invites': 'Invitations you have received to join a business',
  'drafts:basic': 'Your unfinished business setups',
  'keys:prefix': "Your API keys' prefixes",
  'plan:read': 'Your API Library plan and its limits',
  profile: 'Your name and email address',
  drafts: 'Unfinished business setups (no longer available to apps)',
  businesses: 'The names and industries of the businesses you own',
  teams: 'Your API key names, dates, APIs and usage',
};

/** Every scope an app may register or ask for. */
export const ALL_OAUTH_SCOPES = [...APP_SCOPES, ...LEGACY_SCOPES] as const;
export type OAuthScope = (typeof ALL_OAUTH_SCOPES)[number];

const isLegacy = (s: string): s is LegacyScope => (LEGACY_SCOPES as readonly string[]).includes(s);

/** The app-allowed granular scopes an app's (possibly legacy) scope list amounts to. Internal scopes never come out. */
export function expandOAuthScopes(scopes: Iterable<string>): Set<GranularScope> {
  const out = new Set<GranularScope>();
  for (const s of scopes) {
    if (isLegacy(s)) LEGACY_OAUTH_EXPANSION[s].forEach((g) => out.add(g));
    else if ((APP_SCOPES as readonly string[]).includes(s)) out.add(s as AppScope);
  }
  return out;
}

/** The granular scopes an API Library key's Desk scopes amount to. */
export function expandKeyScopes(deskScopes: Iterable<string>): Set<GranularScope> {
  const out = new Set<GranularScope>();
  for (const s of deskScopes) (KEY_SCOPE_EXPANSION[s as keyof typeof KEY_SCOPE_EXPANSION] ?? []).forEach((g) => out.add(g));
  return out;
}
