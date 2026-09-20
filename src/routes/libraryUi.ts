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
};

/** Client-side routes of the copied single-page app: all answered with index.html. */
export const LIBRARY_UI_PAGES = ['/', '/login', '/developer'] as const;

function listFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
  );
}

export function registerLibraryUi(app: FastifyInstance): void {
  let files: string[];
  try {
    files = listFiles(UI_DIR);
  } catch {
    app.log.warn({ dir: UI_DIR }, 'library-ui/ not found; the API Library web pages are not being served');
    return;
  }

  const send = (body: Buffer, type: string) => async (_req: unknown, reply: { header: (k: string, v: string) => unknown; removeHeader: (k: string) => unknown; send: (b: Buffer) => unknown }) => {
    reply.header('Content-Type', type);
    applyHtmlCsp(reply, LIBRARY_UI_CSP);
    // Always revalidate, so a deploy is visible immediately.
    reply.header('Cache-Control', 'no-cache');
    return reply.send(body);
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
