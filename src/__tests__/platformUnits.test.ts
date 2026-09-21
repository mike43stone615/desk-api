// Pure parts of the platform features: the changelog reader and feed, the status page with incidents, GraphQL query measuring,
// OAuth scope and redirect rules, and the PKCE challenge.
import { describe, it, expect } from 'vitest';
import { parse } from 'graphql';
import { changelogAtom, parseChangelog } from '../domain/status/changelog';
import { buildStatus, statusHtml } from '../domain/health/status';
import { measureQuery } from '../routes/graphql';
import { parseScopes, pkceChallenge, validRedirectUri } from '../domain/oauth/oauth';

const MD = `# Changelog

Intro text that is not an entry.

## 2026-09-21: round 4

- **Requests:** a body over the limit now gets a clean 413,
  and a NUL character is a 400.
- **Housekeeping:** expired records are deleted.

## 2026-09-20/21: round 3
- **Keys:** scopes.

## Older
- something
`;

describe('changelog', () => {
  it('reads each release with its date, title and bullets (continuation lines joined, markdown marks removed)', () => {
    const e = parseChangelog(MD);
    expect(e.map((x) => x.title)).toEqual(['round 4', 'round 3', 'Older']);
    expect(e.map((x) => x.date)).toEqual(['2026-09-21', '2026-09-20', null]);
    expect(e[0].items).toEqual(['Requests: a body over the limit now gets a clean 413, and a NUL character is a 400.', 'Housekeeping: expired records are deleted.']);
  });
  it('makes a valid-looking Atom feed with escaped text', () => {
    const feed = changelogAtom(parseChangelog('## 2026-09-21: a <b> & c\n- one "two"\n'), 'https://x.example/v1/changelog.atom');
    expect(feed).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(feed).toContain('<title>a &lt;b&gt; &amp; c</title>');
    expect(feed).toContain('<updated>2026-09-21T00:00:00Z</updated>');
    expect(feed).not.toContain('<b>');
  });
  it('an empty or unreadable file gives an empty list', () => {
    expect(parseChangelog('')).toEqual([]);
  });
});

describe('status page with incidents', () => {
  const inc = (severity: 'minor' | 'major', status: 'investigating' | 'resolved') => ({ id: 'i', title: 'Slow name checks', severity, status, startedAt: '2026-09-21T10:00:00Z', resolvedAt: null, updates: [{ status, message: 'Looking into it', at: '2026-09-21T10:05:00Z' }] });
  it('an open major incident stops the page saying everything works, even when every check passes', () => {
    const view = buildStatus('ok', {}, 'https://help', new Date(), { active: [inc('major', 'investigating')], recent: [] });
    expect(view.status).toBe('degraded');
    expect(statusHtml(view)).toContain('Slow name checks');
    expect(statusHtml(view)).toContain('Looking into it');
  });
  it('a minor incident is shown but does not change the overall state; no incidents says so', () => {
    expect(buildStatus('ok', {}, 'h', new Date(), { active: [inc('minor', 'investigating')], recent: [] }).status).toBe('operational');
    expect(statusHtml(buildStatus('ok', {}, 'h'))).toContain('No incidents in the last 30 days');
  });
  it('a failing check still wins over incidents', () => {
    expect(buildStatus('error', {}, 'h').status).toBe('down');
  });
});

describe('GraphQL query measuring', () => {
  it('counts depth, fields and aliases', () => {
    const m = measureQuery(parse('{ a: viewer { id } b: viewer { id firstName } teams { members { email } } }'));
    expect(m).toEqual({ depth: 3, fields: 8, aliases: 2 });
  });
  it('expands fragments and skips introspection', () => {
    const m = measureQuery(parse('query { ...F } fragment F on Query { teams { name } }'));
    expect(m.depth).toBe(2);
    expect(measureQuery(parse('{ __schema { types { name fields { name type { ofType { ofType { name } } } } } } }')).fields).toBe(0);
  });
});

describe('OAuth rules', () => {
  it('scopes: known names only, at least one, duplicates ignored', () => {
    expect(parseScopes('profile drafts profile')).toEqual(['profile', 'drafts']);
    expect(parseScopes('profile,businesses')).toEqual(['profile', 'businesses']);
    expect(() => parseScopes('')).toThrow();
    expect(() => parseScopes('profile admin')).toThrow(/Ask for/);
  });
  it('redirect addresses: https, or http only on this machine; no fragments or credentials', () => {
    for (const ok of ['https://app.example.com/cb', 'http://localhost:8080/cb', 'http://127.0.0.1/cb']) expect(validRedirectUri(ok), ok).toBe(true);
    for (const bad of ['http://app.example.com/cb', 'https://app.example.com/cb#frag', 'https://u:p@app.example.com/', 'javascript:alert(1)', 'not a url', 'myapp://cb']) expect(validRedirectUri(bad), bad).toBe(false);
  });
  it('PKCE: the challenge is base64url(SHA-256(verifier)), the RFC 7636 example', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});
