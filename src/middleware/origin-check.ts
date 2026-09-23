// Refuses cross-site requests that change something.
//
// The browser session cookie is SameSite=Lax, which keeps it off requests from other websites, but pages on sibling
// subdomains (app., oracle., compliance-api.) count as the SAME site and would still send it. So every request that
// changes data must also come from an origin we trust:
//   - a browser always sends an Origin header on POST/PUT/PATCH/DELETE, and it must be the app, this site itself, or
//     another configured origin;
//   - a request with no Origin is a server or native app (nothing ambient to forge), unless the browser says in
//     Sec-Fetch-Site that it is cross-site.
// Safe methods (GET, HEAD, OPTIONS) are never blocked.
import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { HttpError } from './http-error';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// api-origin.deskbusiness.co is not a real origin a browser ever sends: it's the internal-only hostname the
// api.deskbusiness.co Cloudflare Worker (desk-api/library-ui/worker.js) proxies real backend traffic through, so it
// doesn't recurse into itself now that it's the thing api.deskbusiness.co's DNS points at. A request arriving with
// that Host still carries the *browser's* real Origin (api.deskbusiness.co, or another allowed one) -- only the Host
// changed in transit -- so it needs its own case here rather than the plain self-reference check below.
const INTERNAL_PROXY_HOST = 'api-origin.deskbusiness.co';
const PUBLIC_HOST_FOR_PROXY = 'api.deskbusiness.co';

export function isAllowedOrigin(origin: string, host: string | undefined, allowed: readonly string[]): boolean {
  if (allowed.includes(origin)) return true;
  if (!host) return false;
  if (host === INTERNAL_PROXY_HOST) host = PUBLIC_HOST_FOR_PROXY;
  try {
    // This site calling itself (the API Library pages are served from the same host as the API).
    return new URL(origin).host === host;
  } catch {
    return false; // "null" and anything that is not a URL
  }
}

export function registerOriginCheck(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    if (!UNSAFE.has(request.method)) return;

    const origin = request.headers.origin;
    if (typeof origin === 'string') {
      if (!isAllowedOrigin(origin, request.headers.host, config.corsOrigins)) {
        request.log.warn({ level: 'audit', event: 'cross_site_request_refused', origin, requestId: request.id });
        throw new HttpError(403, 'Requests from this origin are not allowed.', 'origin_not_allowed');
      }
      return;
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      throw new HttpError(403, 'Cross-site requests are not allowed.', 'cross_site_blocked');
    }
  });
}
