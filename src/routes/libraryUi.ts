// Serves the API Library's web pages from api.deskbusiness.co itself: sign-in and the API Library pages (keys, teams, webhooks, apps,
// plans and billing, and the administrator pages). The files live in library-ui/ at the repo root. They began as a copy of
// web_app/public in the desk_business repo (see docs/ADR-002-api-library.md) and have since grown into their own app: nothing keeps
// the two in step any more, so a fix to a shared piece (sign-in, the admin table editor) has to be made in both places by hand.
//
// Same origin as the API, so the session cookie is first-party and no CORS is
// involved. Every route is registered from a fixed scan of library-ui/ at
// startup -- nothing is ever built from the request path, so there is no path
// to traverse. Anything not listed falls through to the API's normal 404.
import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { FastifyInstance } from 'fastify';
import { applyHtmlCsp, LIBRARY_UI_CSP } from '../middleware/csp';
import { LIBRARY_UI_STATIC_PATHS } from '../middleware/static-paths';

const UI_DIR = join(__dirname, '..', '..', 'library-ui');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Client-side routes of the copied single-page app: all answered with index.html. */
export const LIBRARY_UI_PAGES = ['/', '/login', '/developer', '/developer/teams', '/developer/webhooks', '/developer/apps', '/developer/billing', '/developer/admin', '/developer/authorize', '/confirm-email', '/reset-password'] as const;

/**
 * First path segments that belong to the API, now or in future. A web page (or a file in library-ui/) may never use one:
 * that would shadow an API route, or be shadowed by one added later. Checked when the server starts.
 */
export const RESERVED_API_ROOTS = [
  'auth', 'setup', 'gateway', 'admin', 'integrations', 'functions', 'health', 'metrics', 'docs', 'errors', 'status',
  'webhooks', 'teams', 'billing', 'changelog', 'v1', 'v2', 'api', '.well-known', 'openapi.json', 'internal', 'oauth', 'graphql',
] as const;

/** The reserved API roots this path collides with, or null. */
export function reservedRootOf(path: string): string | null {
  const first = path.replace(/^\/+/, '').split('/')[0].toLowerCase();
  return (RESERVED_API_ROOTS as readonly string[]).includes(first) ? first : null;
}

/**
 * If-None-Match may carry several tags, "*", and weak tags (W/"..."): Cloudflare turns the ETag of a file it compresses into a weak
 * one, and a browser sends back exactly what it was given, so a plain equality test would never answer 304 in production.
 */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (!value) return false;
  if (value.trim() === '*') return true;
  return value.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag);
}

// Cloudflare-only infrastructure files that live in library-ui/ for the edge deployment (worker.js, its config, and the
// .assetsignore that hides them from Cloudflare's own static assets) but are not pages of the app: .assetsignore has no
// effect on this Fastify-side scan, so without this exclusion they'd otherwise be served here as real, unauthenticated
// routes (worker.js in particular would leak the Worker's proxy target, api-origin.deskbusiness.co).
const NOT_A_PAGE = new Set(['worker.js', 'wrangler.jsonc', '.assetsignore']);

function listFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => prefix !== '' || !NOT_A_PAGE.has(entry.name))
    .flatMap((entry) => (entry.isDirectory() ? listFiles(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]));
}

export function registerLibraryUi(app: FastifyInstance): void {
  for (const page of LIBRARY_UI_PAGES) {
    const clash = reservedRootOf(page);
    if (clash) throw new Error(`Web page ${page} collides with the reserved API root "${clash}"`);
  }
  let files: string[];
  try {
    files = listFiles(UI_DIR);
  } catch {
    app.log.warn({ dir: UI_DIR }, 'library-ui/ not found; the API Library web pages are not being served');
    return;
  }

  const send = (body: Buffer, type: string) => {
    const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 24)}"`;
    return async (req: { headers: Record<string, string | string[] | undefined> }, reply: { header: (k: string, v: string) => unknown; removeHeader: (k: string) => unknown; code: (n: number) => unknown; send: (b?: Buffer) => unknown }) => {
      reply.header('Content-Type', type);
      applyHtmlCsp(reply, LIBRARY_UI_CSP);
      // "private" keeps Cloudflare from storing these files (its default browser-cache time for .js/.css is four hours, which
      // hid a deploy from returning visitors); "no-cache" makes the browser ask every time, and the ETag makes that ask cheap.
      reply.header('Cache-Control', 'private, no-cache');
      reply.header('ETag', etag);
      if (etagMatches(req.headers['if-none-match'], etag)) {
        reply.code(304);
        return reply.send();
      }
      return reply.send(body);
    };
  };

  for (const rel of files) {
    const type = CONTENT_TYPES[rel.slice(rel.lastIndexOf('.'))];
    if (!type) continue;
    const body = readFileSync(join(UI_DIR, rel));
    if (rel === 'index.html') {
      for (const page of LIBRARY_UI_PAGES) { app.get(page, send(body, type)); LIBRARY_UI_STATIC_PATHS.add(page); }
    } else {
      app.get(`/${rel}`, send(body, type));
      LIBRARY_UI_STATIC_PATHS.add(`/${rel}`);
    }
  }
}
