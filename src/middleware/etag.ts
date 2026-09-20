// Reference data (the API description, the service list, the error catalogue) changes only when a new version is
// deployed, so callers can ask "has it changed?" instead of downloading it again: every answer carries an ETag and a
// matching If-None-Match gets an empty 304.
import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export function etagOf(body: unknown): string {
  return `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 27)}"`;
}

/** True when the If-None-Match header lists this tag (or *). Weak validators compare equal, as HTTP specifies for GET. */
export function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
}

export function sendWithEtag(request: FastifyRequest, reply: FastifyReply, body: unknown): FastifyReply {
  const etag = etagOf(body);
  reply.header('ETag', etag);
  reply.header('Cache-Control', 'private, no-cache'); // may be stored, but must be revalidated: a deploy shows at once
  if (matchesIfNoneMatch(request.headers['if-none-match'], etag)) return reply.status(304).send();
  return reply.send(body);
}
