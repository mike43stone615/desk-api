// Serves the API Library's web pages from api.deskbusiness.co itself: the
// desk_business sign-in page (branded "Desk API Library") and the API Library
// page it leads to. The files live in library-ui/ at the repo root and are a
// copy of web_app/public in the desk_business repo, differing only in the brand
// text and where sign-in leads (see docs/ADR-002-api-library.md).
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

function listFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
  );
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
      if (req.headers['if-none-match'] === etag) {
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
      for (const page of LIBRARY_UI_PAGES) app.get(page, send(body, type));
    } else {
      app.get(`/${rel}`, send(body, type));
    }
  }
}
