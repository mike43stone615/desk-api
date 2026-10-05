import { describe, expect, it } from 'vitest';
import { ALL_OAUTH_SCOPES, GRANULAR_SCOPES, SCOPE_DESCRIPTIONS, expandKeyScopes, expandOAuthScopes } from '../domain/oauth/scopes';

describe('granular OAuth scopes', () => {
  it('describes every scope in plain English', () => {
    for (const s of ALL_OAUTH_SCOPES) expect(SCOPE_DESCRIPTIONS[s]).toMatch(/\w/);
  });

  it('expands an app\'s original scopes to exactly what they covered when the person approved them', () => {
    expect([...expandOAuthScopes(['profile'])].sort()).toEqual(['profile:email', 'profile:name']);
    expect([...expandOAuthScopes(['businesses'])].sort()).toEqual(['businesses:basic', 'businesses:invites', 'businesses:members']);
    expect([...expandOAuthScopes(['teams'])].sort()).toEqual(['keys:read', 'plan:read', 'usage:read']);
    // the newer business details were never part of "businesses" for an app
    expect(expandOAuthScopes(['businesses']).has('businesses:plan')).toBe(false);
  });

  it('keeps granular scopes as they are and drops anything unknown', () => {
    expect([...expandOAuthScopes(['profile:name', 'nonsense'])]).toEqual(['profile:name']);
  });

  it('gives an API key\'s own "businesses" scope every business detail (the owner reading their own data)', () => {
    const all = expandKeyScopes(['businesses']);
    for (const s of GRANULAR_SCOPES.filter((x) => x.startsWith('businesses:'))) expect(all.has(s)).toBe(true);
    expect(all.has('profile:name')).toBe(false);
    expect(expandKeyScopes(['profile', 'drafts']).has('keys:read')).toBe(false);
  });
});
