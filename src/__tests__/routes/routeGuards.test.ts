// A guard on the guards: EVERY route the service registers must refuse an anonymous caller, unless it is on the short,
// reviewed list of routes that are public on purpose. A new route that forgets its sign-in check fails this test the
// moment it is added, instead of shipping open (this is how the setup-wizard helper routes stayed open for so long).
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { buildApp } from '../../app';
import { registeredRoutes } from '../../middleware/not-found';
import { GATEWAY_KEY_ALLOWED_ROUTES } from '../../middleware/auth';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
});

const unversioned = (url: string) => (url === '/v1' ? '/' : url.startsWith('/v1/') ? url.slice(3) : url);
const fill = (url: string) => url.replace(/:[A-Za-z]+/g, 'x').replace(/\*/g, 'x');

/** "METHOD /pattern" (no /v1) -> why anyone may call it without signing in. Adding to this list is a security decision. */
const PUBLIC: Record<string, string> = {
  'GET /health': 'liveness/readiness probes (no data)',
  'GET /health/live': 'liveness probe',
  'GET /health/ready': 'readiness probe',
  'POST /auth/signup': 'creating an account happens before there is a session',
  'POST /auth/signin': 'signing in happens before there is a session',
  'POST /auth/signout': 'only clears the caller\'s own cookie/session; harmless without one',
  'POST /auth/email-confirmation/request': 'pre-sign-in flow; answers identically for every address',
  'POST /auth/email-confirmation/confirm': 'pre-sign-in flow; authorised by the emailed token',
  'POST /auth/password-reset/request': 'pre-sign-in flow; answers identically for every address',
  'POST /auth/password-reset/confirm': 'pre-sign-in flow; authorised by the emailed token',
  'POST /webhooks/resend': 'the mail provider calls this; authorised by its signature only (404 until configured, 401 for a bad signature)',
  'GET /status': 'the public status page (operational / degraded / down per part; no detail)',
  'GET /errors': 'catalogue of error codes (documentation only)',
  'GET /errors/:code': 'one error code explained (documentation only)',
  'GET /.well-known/security.txt': 'RFC 9116 contact file for security researchers (404 until a contact is chosen)',
  'GET /gateway/openapi.json': 'the published description of the API Library (documentation only)',
  'GET /billing/plans': 'the plan catalogue (public information)',
  'GET /oauth/authorize': 'starts an OAuth flow: validates the request, then redirects to the consent page (which needs a sign-in)',
  'POST /oauth/token': 'OAuth token endpoint: authenticated by the app\'s own client credentials and a one-time code',
  'POST /oauth/revoke': 'OAuth token revocation: authenticated by the app\'s own client credentials',
  'GET /.well-known/oauth-authorization-server': 'OAuth discovery document (documentation only)',
  'GET /status/incidents': 'public status page incidents (no personal data)',
  'GET /changelog': 'public changelog',
  'GET /changelog.atom': 'public changelog feed',
  'GET /developer/authorize': 'API Library web page (the OAuth consent screen)',
  'GET /pages/authorize.js': 'API Library web asset',
  // The API Library's own web pages: static files, no data.
  'GET /': 'API Library web page',
  'GET /login': 'API Library web page',
  'GET /developer': 'API Library web page',
  'GET /developer/teams': 'API Library web page (Teams tab)',
  'GET /developer/webhooks': 'API Library web page (Webhooks tab)',
  'GET /developer/apps': 'API Library web page (Apps tab)',
  'GET /developer/billing': 'API Library web page (Plans & billing tab)',
  'GET /pages/webhooks.js': 'API Library web asset',
  'GET /pages/apps.js': 'API Library web asset',
  'GET /pages/billing.js': 'API Library web asset',
  'GET /tabs.js': 'API Library web asset',
  'GET /format.js': 'API Library web asset',
  'GET /confirm-email': 'API Library web page (the link in the confirmation e-mail)',
  'GET /reset-password': 'API Library web page (the link in the reset e-mail)',
  'GET /app.js': 'API Library web asset',
  'GET /style.css': 'API Library web asset',
  'GET /desk_logo.png': 'API Library web asset',
  'GET /pages/auth.js': 'API Library web asset',
  'GET /pages/developer.js': 'API Library web asset',
  'GET /pages/teams.js': 'API Library web asset',
  'GET /team-rules.js': 'API Library web asset',
  'GET /fonts/inter-latin-wght-normal.woff2': 'API Library web asset (font)',
  'GET /fonts/inter-latin-ext-wght-normal.woff2': 'API Library web asset (font)',
  'GET /fonts/OFL-Inter-LICENSE.txt': 'API Library web asset (font licence)',
};

describe('route guards', () => {
  const routes = () => registeredRoutes(app).map((r) => ({ ...r, key: `${r.method} ${unversioned(r.url)}` }));

  it('finds the routes (so an empty list can never make this test pass)', () => {
    expect(routes().length).toBeGreaterThan(60);
  });

  it('every route not on the public list refuses an anonymous caller with 401', async () => {
    const open: string[] = [];
    for (const r of routes()) {
      if (PUBLIC[r.key]) continue;
      const res = await app.inject({ method: r.method as 'GET', url: fill(r.url) });
      if (res.statusCode !== 401 && res.statusCode !== 403) open.push(`${r.key} answered ${res.statusCode}`);
    }
    expect(open, 'routes reachable without signing in').toEqual([]);
  });

  it('...and refuses a made-up session and a made-up API key too', async () => {
    const open: string[] = [];
    for (const r of routes()) {
      if (PUBLIC[r.key]) continue;
      for (const headers of [{ authorization: `Bearer ${'0'.repeat(40)}` }, { 'x-api-key': `deskgw_${'0'.repeat(48)}` }]) {
        const res = await app.inject({ method: r.method as 'GET', url: fill(r.url), headers });
        if (res.statusCode !== 401 && res.statusCode !== 403) open.push(`${r.key} answered ${res.statusCode} to ${Object.keys(headers)[0]}`);
      }
    }
    expect(open).toEqual([]);
  });

  it('the public list has no stale entries: each one is a real route', () => {
    const real = new Set(routes().map((r) => r.key));
    const stale = Object.keys(PUBLIC).filter((k) => !real.has(k));
    expect(stale).toEqual([]);
  });

  it('every public route that changes data is one of the pre-sign-in account routes', () => {
    const mutating = Object.keys(PUBLIC).filter((k) => !k.startsWith('GET '));
    // ...plus the one signature-authorised webhook (404 until configured, 401 unless correctly signed).
    expect(mutating.every((k) => k.startsWith('POST /auth/') || k === 'POST /webhooks/resend' || k === 'POST /oauth/token' || k === 'POST /oauth/revoke')).toBe(true);
  });

  it('the routes an API Library key may call all exist and are read-only', () => {
    const real = new Set(routes().map((r) => r.key));
    for (const allowed of GATEWAY_KEY_ALLOWED_ROUTES) {
      expect(real.has(allowed), allowed).toBe(true);
      // Read-only, with one exception: GraphQL is a POST by design, but it only accepts queries (tested in oauthGraphql.e2e).
      expect(allowed.startsWith('GET ') || allowed === 'POST /graphql', allowed).toBe(true);
    }
  });

  it('every admin route refuses a signed-in non-admin and an API Library key', async () => {
    const { pool } = await import('../../db');
    const db = pool as unknown as ReturnType<typeof import('../helpers/fake-db').createFakeDb>;
    const now = new Date().toISOString();
    db.users.set('rg-user', { id: 'rg-user', email: 'plain@example.com', password_hash: 'x', first_name: 'P', last_name: 'U', email_confirmed_at: now, created_at: now, updated_at: now });
    db.seedSession('rg-token', { id: 'rg-s', user_id: 'rg-user', token: 'rg-token', expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now });
    for (const r of routes().filter((x) => x.key.split(' ')[1].startsWith('/admin'))) {
      const res = await app.inject({ method: r.method as 'GET', url: fill(r.url), headers: { authorization: 'Bearer rg-token' } });
      expect(res.statusCode, r.key).toBe(403);
    }
  });
});
