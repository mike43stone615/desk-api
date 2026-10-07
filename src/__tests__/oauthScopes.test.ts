import { describe, expect, it } from 'vitest';
import { ALL_OAUTH_SCOPES, APP_SCOPES, GRANULAR_SCOPES, SCOPE_DESCRIPTIONS, expandKeyScopes, expandOAuthScopes } from '../domain/oauth/scopes';

describe('granular OAuth scopes', () => {
  it('describes every scope in plain English', () => {
    for (const s of [...ALL_OAUTH_SCOPES, ...GRANULAR_SCOPES]) expect(SCOPE_DESCRIPTIONS[s]).toMatch(/\w/);
  });

  it('never lets an app ask for private or someone-else\'s data', () => {
    for (const s of ['businesses:members', 'businesses:partners', 'businesses:idea', 'businesses:plan', 'businesses:requirements',
      'businesses:market_research', 'businesses:name_check', 'businesses:registered_agent', 'businesses:invites', 'drafts:basic',
      'keys:prefix', 'plan:read', 'businesses:role']) {
      expect((APP_SCOPES as readonly string[]).includes(s)).toBe(false);
      expect((ALL_OAUTH_SCOPES as readonly string[]).includes(s)).toBe(false);
    }
  });

  it('expands an app\'s original scopes only to app-allowed pieces', () => {
    expect([...expandOAuthScopes(['profile'])].sort()).toEqual(['profile:email', 'profile:name']);
    expect([...expandOAuthScopes(['businesses'])].sort()).toEqual(['businesses:basic', 'businesses:industry']);
    expect([...expandOAuthScopes(['teams'])].sort()).toEqual(['keys:apis', 'keys:dates', 'keys:name', 'usage:read']);
    expect(expandOAuthScopes(['drafts']).size).toBe(0); // unfinished setups are no longer open to apps
  });

  it('drops internal and unknown scopes even if an app somehow holds them', () => {
    expect([...expandOAuthScopes(['profile:name', 'businesses:plan', 'keys:prefix', 'nonsense'])]).toEqual(['profile:name']);
  });

  it('gives an API key\'s own "businesses" scope every business detail (the owner reading their own data)', () => {
    const all = expandKeyScopes(['businesses']);
    for (const s of GRANULAR_SCOPES.filter((x) => x.startsWith('businesses:'))) expect(all.has(s)).toBe(true);
    expect(all.has('profile:name')).toBe(false);
    expect(expandKeyScopes(['profile', 'drafts']).has('keys:name')).toBe(false);
  });
});
