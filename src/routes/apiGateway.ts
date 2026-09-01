// Transparent proxy to registry-api (/registry/*) — ported as-is from the
// original api/routes/api-gateway.ts (Hono). Registered as a wildcard route
// in app.ts. The equivalent compliance-os proxy (/compliance/*) was removed
// (see cross-20 in the audit): unauthenticated, forwarded the caller's own
// API key verbatim, and exposed compliance-os's known SSRF/DoS issues to the
// public internet with no real product ever calling it — the app talks to
// compliance-os through the separately-authenticated /integrations/compliance/*
// routes instead.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../middleware/http-error';
import { config } from '../config';

function stripMountedPrefix(path: string, prefix: string): string {
  const stripped = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  return stripped || '/';
}

// Judgment call: the original Hono proxy forwarded `req.body` as a raw
// ReadableStream, making it a byte-for-byte transparent proxy for any
// content type. Fastify parses `application/json` bodies into a JS object
// by default before a route handler ever sees them, so this port
// re-serializes `request.body` with JSON.stringify instead of streaming raw
// bytes — a transparent proxy in spirit, not in the strict byte-for-byte
// sense, for JSON request bodies specifically. Both proxied services
// (compliance-os, registry-api) only expose JSON APIs at the paths this
// gateway forwards to, so this is not expected to matter in practice; a
// non-JSON body (e.g. a future file upload route) would need a raw-body
// content-type parser registered for these two routes specifically.
async function proxyUpstream(request: FastifyRequest, reply: FastifyReply, targetBase: string, path: string) {
  const search = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
  const url = `${targetBase.replace(/\/$/, '')}${path}${search}`;

  const headers = new Headers();
  const skip = new Set(['host', 'connection', 'transfer-encoding', 'te', 'upgrade', 'keep-alive', 'content-length']);
  for (const [key, value] of Object.entries(request.headers)) {
    if (skip.has(key.toLowerCase()) || value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }

  const method = request.method;
  const hasBody = !['GET', 'HEAD'].includes(method);
  const upstreamResp = await fetch(url, {
    method,
    headers,
    body: hasBody ? JSON.stringify(request.body ?? undefined) : undefined,
  });

  const buffer = Buffer.from(await upstreamResp.arrayBuffer());
  reply.status(upstreamResp.status);
  const contentType = upstreamResp.headers.get('content-type');
  if (contentType) reply.header('content-type', contentType);
  return reply.send(buffer);
}

export async function registryGatewayHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!config.registryApiUrl) throw new HttpError(503, 'Registry service is not configured.');
  const path = stripMountedPrefix(request.url.split('?')[0], '/registry');
  return proxyUpstream(request, reply, config.registryApiUrl, path);
}
