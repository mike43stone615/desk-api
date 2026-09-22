import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { buildApp } from '../../app';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
});

const UI_DIR = join(__dirname, '..', '..', '..', 'library-ui');
const onDisk = (rel: string) => readFileSync(join(UI_DIR, rel), 'utf8');

describe('API Library web pages (served from api.deskbusiness.co)', () => {
  it.each(['/', '/login', '/developer', '/developer/teams', '/developer/webhooks', '/developer/apps', '/developer/billing', '/developer/admin'])('%s serves the app shell, titled "Desk API Library"', async (url) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<title>Desk API Library</title>');
    expect(res.body).not.toContain('Desk Business');
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{24}"$/);
  });

  it('recognises the file whether the tag arrives plain, weak (as Cloudflare rewrites it), in a list, or as *', async () => {
    const { etagMatches } = await import('../../routes/libraryUi');
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"x", W/"abc" , "y"', '"abc"')).toBe(true);
    expect(etagMatches('*', '"abc"')).toBe(true);
    expect(etagMatches('"other"', '"abc"')).toBe(false);
    expect(etagMatches(undefined, '"abc"')).toBe(false);
    expect(etagMatches(['"a"', 'W/"abc"'], '"abc"')).toBe(true);
    const first = await app.inject({ method: 'GET', url: '/style.css' });
    const weak = await app.inject({ method: 'GET', url: '/style.css', headers: { 'if-none-match': `W/${first.headers.etag}` } });
    expect(weak.statusCode).toBe(304);
  });

  it('answers 304 when the browser already has the current file, and the full file when it does not', async () => {
    const first = await app.inject({ method: 'GET', url: '/style.css' });
    const again = await app.inject({ method: 'GET', url: '/style.css', headers: { 'if-none-match': first.headers.etag as string } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    const stale = await app.inject({ method: 'GET', url: '/style.css', headers: { 'if-none-match': '"old"' } });
    expect(stale.statusCode).toBe(200);
    expect(stale.body.length).toBeGreaterThan(1000);
  });

  it('serves every script, the stylesheet and the logo with the right content type', async () => {
    const expected: Record<string, RegExp> = {
      '/app.js': /javascript/,
      '/pages/auth.js': /javascript/,
      '/pages/confirm-email.js': /javascript/,
      '/pages/reset-password.js': /javascript/,
      '/pages/developer.js': /javascript/,
      '/pages/teams.js': /javascript/,
      '/pages/webhooks.js': /javascript/,
      '/pages/apps.js': /javascript/,
      '/pages/billing.js': /javascript/,
      '/pages/admin.js': /javascript/,
      '/tabs.js': /javascript/,
      '/format.js': /javascript/,
      '/team-rules.js': /javascript/,
      '/style.css': /text\/css/,
      '/desk_logo.png': /image\/png/,
    };
    for (const [url, type] of Object.entries(expected)) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type'], url).toMatch(type);
    }
  });

  it('a session that ends mid-action sends the person to sign-in with an explanation and brings them back afterwards', async () => {
    const appJs = (await app.inject({ method: 'GET', url: '/app.js' })).body;
    const auth = (await app.inject({ method: 'GET', url: '/pages/auth.js' })).body;
    expect(appJs).toContain('rememberReturnPath(new URL(location.href));');
    expect(appJs).toContain("navigate('/login', { replace: true });");
    expect(auth).toContain('Your session ended, so you were signed out.');
    expect(auth).toContain("takeReturnPath() || '/developer'");
  });

  it('the sign-in page says "Desk API Library" and, once signed in, leads to the API Library page', async () => {
    const auth = (await app.inject({ method: 'GET', url: '/pages/auth.js' })).body;
    expect(auth).toContain('<span class="brand-business">API Library</span>');
    expect(auth).not.toContain('>Business</span>');
    expect(auth).toContain("takeReturnPath() || '/developer'");
    expect(auth).not.toContain("'/businesses'");
    expect(auth).toContain("signIn: 'Build on business data with your own API keys.'");
    expect(auth).not.toContain('Start and run your business');
  });

  it('the app shell calls this same origin, and defaults to the API Library page', async () => {
    const js = (await app.inject({ method: 'GET', url: '/app.js' })).body;
    expect(js).toContain("export const API_BASE = '';");
    expect(js).toContain("url.pathname === '/' ? '/developer'");
    expect(js).not.toContain("import('./pages/businesses.js')");
  });

  it('serves the files exactly as they are on disk', async () => {
    for (const rel of ['app.js', 'style.css', 'pages/auth.js', 'pages/developer.js', 'index.html']) {
      const url = rel === 'index.html' ? '/' : `/${rel}`;
      expect((await app.inject({ method: 'GET', url })).body, rel).toBe(onDisk(rel));
    }
  });

  it('exposes nothing beyond the listed files: no traversal, no repo files, no direct index.html', async () => {
    for (const url of [
      '/package.json', '/src/config.ts', '/.env', '/library-ui/app.js', '/index.html', '/pages/',
      '/pages/../package.json', '/pages/%2e%2e/package.json', '/%2e%2e/.env', '/pages/sessions.js',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type'], url).toMatch(/json/);
    }
  });

  it('leaves the API itself alone', async () => {
    expect((await app.inject({ method: 'GET', url: '/auth/session' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/gateway/services' })).statusCode).toBe(401);
  });

  it('still sends the usual security headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/login' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeTruthy();
  });
});

describe('reserved names', () => {
  it('no web page or library file uses a name reserved for the API, and the check itself works', async () => {
    const { LIBRARY_UI_PAGES, RESERVED_API_ROOTS, reservedRootOf } = await import('../../routes/libraryUi');
    for (const page of LIBRARY_UI_PAGES) expect(reservedRootOf(page), page).toBeNull();
    for (const root of RESERVED_API_ROOTS) expect(reservedRootOf(`/${root}/anything`), root).toBe(root);
    expect(reservedRootOf('/Auth')).toBe('auth');
    expect(reservedRootOf('/developer')).toBeNull();
  });
});
