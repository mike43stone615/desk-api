// Content-Security-Policy on the three kinds of response, and a check that the pages we serve do not do anything the
// policy forbids (inline scripts, inline handlers, eval), so turning enforcement on cannot break them.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { buildApp } from '../../app';
import { CSP_HEADER, CSP_MODE, LIBRARY_UI_CSP, docsCsp, docsInlineScript } from '../../middleware/csp';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
});

const DOCS_KEY = { 'x-api-key': 'test-metrics-docs-key' };

describe('JSON API responses', () => {
  it('carry the strictest policy, always enforced', async () => {
    for (const url of ['/health', '/auth/session', '/nope', '/v1/health']) {
      const res = await app.inject({ method: 'GET', url });
      const policy = String(res.headers['content-security-policy']);
      for (const directive of ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]) expect(policy, url).toContain(directive);
      expect(res.headers['x-frame-options'], url).toBe('DENY');
    }
  });
});

describe('the library web pages', () => {
  it('send the library policy instead, under the configured header name, and no other policy', async () => {
    for (const url of ['/', '/login', '/developer', '/app.js', '/style.css', '/pages/auth.js', '/pages/developer.js', '/developer/teams', '/pages/teams.js', '/developer/webhooks', '/developer/apps', '/developer/billing', '/pages/webhooks.js', '/pages/apps.js', '/pages/billing.js']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers[CSP_HEADER], url).toBe(LIBRARY_UI_CSP);
      if (CSP_MODE === 'enforce') expect(res.headers['content-security-policy']).toBe(LIBRARY_UI_CSP);
      else expect(res.headers['content-security-policy'], url).toBeUndefined();
    }
  });

  it('the policy names only what the pages actually use', () => {
    expect(LIBRARY_UI_CSP).toContain("script-src 'self' https://browser.sentry-cdn.com");
    expect(LIBRARY_UI_CSP).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(LIBRARY_UI_CSP).not.toMatch(/script-src[^;]*unsafe-eval/);
    expect(LIBRARY_UI_CSP).toContain("frame-ancestors 'none'");
    expect(LIBRARY_UI_CSP).toContain("object-src 'none'");
    expect(LIBRARY_UI_CSP).toContain("base-uri 'none'");
  });

  it('the pages themselves use nothing the policy forbids', () => {
    const dir = join(__dirname, '..', '..', '..', 'library-ui');
    const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)]));
    for (const file of files(dir).filter((f) => /\.(html|js)$/.test(f))) {
      const text = readFileSync(file, 'utf8');
      expect(text, `${file}: inline event handler`).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
      expect(text, `${file}: javascript: URL`).not.toMatch(/javascript:/i);
      expect(text, `${file}: eval`).not.toMatch(/\beval\s*\(|new Function\s*\(/);
      if (file.endsWith('.html')) {
        const inline = [...text.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>/g)];
        expect(inline, `${file}: inline <script>`).toEqual([]);
        expect(text, `${file}: <style> block`).not.toMatch(/<style\b/i);
      }
    }
  });
});

describe('the docs page', () => {
  it('pins Swagger UI to an exact version and content hash, and allows its one inline script only by hash', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs', headers: DOCS_KEY });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/swagger-ui-dist@5\.\d+\.\d+\/swagger-ui\.css" integrity="sha384-[A-Za-z0-9+/=]{64}" crossorigin="anonymous"/);
    expect(res.body).toMatch(/swagger-ui-dist@5\.\d+\.\d+\/swagger-ui-bundle\.js" integrity="sha384-[A-Za-z0-9+/=]{64}" crossorigin="anonymous"/);
    expect(res.body).not.toContain('swagger-ui-dist@5/');
    const policy = String(res.headers[CSP_HEADER]);
    expect(policy).toBe(docsCsp(''));
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
    const hash = createHash('sha256').update(docsInlineScript(''), 'utf8').digest('base64');
    expect(policy).toContain(`'sha256-${hash}'`);
    // the script in the page is byte-for-byte the one that was hashed
    expect(res.body).toContain(`<script>${docsInlineScript('')}</script>`);
  });

  it('/v1/docs has its own matching hash', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/docs', headers: DOCS_KEY });
    const hash = createHash('sha256').update(docsInlineScript('/v1'), 'utf8').digest('base64');
    expect(String(res.headers[CSP_HEADER])).toContain(`'sha256-${hash}'`);
    expect(res.body).toContain(`<script>${docsInlineScript('/v1')}</script>`);
  });
});
