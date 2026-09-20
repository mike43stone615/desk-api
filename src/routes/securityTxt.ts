// RFC 9116 security.txt: the standard place a security researcher looks for "who do I tell?". It is only served once
// the owner has chosen a contact (SECURITY_CONTACT); until then the path answers 404 like any unknown page, so the
// service never advertises a contact nobody has agreed to.
import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { HttpError } from '../middleware/http-error';

export const SECURITY_TXT_PATH = '/.well-known/security.txt';
/** RFC 9116 requires an Expires date; it is always this far ahead of the request, so the file never goes stale. */
const VALID_DAYS = 180;

/** An email address becomes mailto:, a web address stays as it is. Anything else is not a usable contact. */
export function normalizeSecurityContact(raw: string): string | null {
  const v = raw.trim();
  if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(v)) return v;
  if (/^https:\/\/[^\s]+$/i.test(v)) return v;
  if (/^[^\s@:]+@[^\s@]+\.[^\s@]+$/.test(v)) return `mailto:${v}`;
  return null;
}

export function buildSecurityTxt(contact: string, baseUrl: string, now: Date = new Date()): string {
  const expires = new Date(now.getTime() + VALID_DAYS * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return [`Contact: ${contact}`, `Expires: ${expires}`, 'Preferred-Languages: en', `Canonical: ${baseUrl}${SECURITY_TXT_PATH}`, ''].join('\n');
}

export function registerSecurityTxt(app: FastifyInstance, rawContact: string | undefined = config.securityContact, baseUrl = 'https://api.deskbusiness.co'): void {
  const contact = rawContact ? normalizeSecurityContact(rawContact) : null;
  app.get(SECURITY_TXT_PATH, async (_request, reply) => {
    if (!contact) throw new HttpError(404, 'Not found', 'not_found');
    reply.header('Content-Type', 'text/plain; charset=utf-8').header('Cache-Control', 'public, max-age=3600');
    return reply.send(buildSecurityTxt(contact, baseUrl));
  });
}
