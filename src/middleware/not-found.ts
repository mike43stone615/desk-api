// Unknown URLs and wrong methods, in the same RFC 7807 shape as every other
// error. A URL that exists but not for the method used answers 405 with an
// Allow header (not a misleading 404), so a client can tell "typo in the path"
// from "right path, wrong verb".
//
// Routes are recorded as they are registered (the onRoute hook must be added
// before any route is), then matched by pattern -- `:param` is one segment, `*`
// is anything -- when a request finds no handler.
import type { FastifyInstance } from 'fastify';
import { problemBody } from './http-error';

interface RecordedRoute {
  method: string;
  pattern: RegExp;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function patternFor(url: string): RegExp {
  const source = url
    .split('/')
    .map((segment) => (segment === '*' ? '.*' : segment.startsWith(':') ? '[^/]+' : escapeRegex(segment)))
    .join('/');
  return new RegExp(`^${source}/?$`);
}

export function registerNotFound(app: FastifyInstance): void {
  const routes: RecordedRoute[] = [];

  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const pattern = patternFor(route.url);
    // OPTIONS is the CORS plugin's catch-all, not a real endpoint; HEAD is implied by GET.
    for (const method of methods) if (method !== 'OPTIONS') routes.push({ method, pattern });
  });

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0];
    const allowed = new Set<string>();
    for (const route of routes) {
      if (route.pattern.test(path)) allowed.add(route.method);
    }
    reply.header('Content-Type', 'application/problem+json');

    if (allowed.size > 0 && !allowed.has(request.method)) {
      allowed.add('OPTIONS');
      const allow = [...allowed].sort().join(', ');
      return reply
        .status(405)
        .header('Allow', allow)
        .send(problemBody(request.url, 405, `${request.method} is not allowed here. Allowed: ${allow}.`));
    }
    return reply.status(404).send(problemBody(request.url, 404, `Route ${request.method}:${path} not found.`));
  });
}
