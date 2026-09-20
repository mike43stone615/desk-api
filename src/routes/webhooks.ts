// The mail provider (Resend) tells us when an address bounced permanently or someone marked a message as spam; we then
// stop emailing that address (email_suppressions). The call is authorised ONLY by its signature (Svix scheme: the
// signed text is "<id>.<timestamp>.<raw body>", HMAC-SHA256 with the webhook secret, base64): without
// a webhook secret (RESEND_WEBHOOK_SECRET, or the one the provider holds for the registered webhook) the endpoint answers 404, and a wrong or stale signature is a 401.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getWebhookSecret, webhookSecretIsConfigured } from '../domain/email/webhook-secret';
import { pool } from '../db';
import { HttpError } from '../middleware/http-error';

const MAX_AGE_SECONDS = 5 * 60;

/** True when `signatureHeader` ("v1,<base64> v1,<base64>") contains a valid signature of this message. */
export function verifySvixSignature(secret: string, id: string, timestamp: string, rawBody: string, signatureHeader: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > MAX_AGE_SECONDS) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest();
  return signatureHeader.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const given = Buffer.from(sig, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export interface SuppressionEvent { emails: string[]; reason: 'bounced' | 'complained' }

/** What an event means for us: permanent bounces and spam complaints stop mail; everything else is ignored. */
export function suppressionFrom(event: unknown): SuppressionEvent | null {
  const e = event as { type?: string; data?: { to?: unknown; bounce?: { type?: string } } } | null;
  const to = Array.isArray(e?.data?.to) ? (e!.data!.to as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  if (to.length === 0) return null;
  if (e?.type === 'email.complained') return { emails: to.map((x) => x.trim().toLowerCase()), reason: 'complained' };
  if (e?.type === 'email.bounced' && /permanent/i.test(e.data?.bounce?.type ?? '')) return { emails: to.map((x) => x.trim().toLowerCase()), reason: 'bounced' };
  return null;
}

export function registerWebhooks(app: FastifyInstance): void {
  // Inside its own scope so the raw text of the body is available for the signature check.
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    scope.post('/webhooks/resend', { bodyLimit: 65_536 }, async (request: FastifyRequest, reply: FastifyReply) => {
      const secret = await getWebhookSecret();
      if (!secret) throw new HttpError(404, 'Not found', 'not_found');
      const raw = String(request.body ?? '');
      const h = request.headers;
      const signedBy = (s: string) => typeof h['svix-id'] === 'string' && typeof h['svix-timestamp'] === 'string' && typeof h['svix-signature'] === 'string'
        && verifySvixSignature(s, h['svix-id'], h['svix-timestamp'], raw, h['svix-signature']);
      let ok = signedBy(secret);
      // A secret asked from the provider may have been changed there since it was kept: ask once more before refusing.
      if (!ok && !webhookSecretIsConfigured()) {
        const fresh = await getWebhookSecret(true);
        ok = Boolean(fresh && fresh !== secret && signedBy(fresh));
      }
      if (!ok) throw new HttpError(401, 'The signature is not valid.', 'invalid_signature');
      let event: unknown;
      try { event = JSON.parse(raw); } catch { throw new HttpError(400, 'The body is not valid JSON.', 'invalid_json'); }
      const s = suppressionFrom(event);
      if (s) {
        for (const email of s.emails) {
          await pool.query(`INSERT INTO email_suppressions (email, reason) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING`, [email, s.reason]);
        }
        request.log.info({ event: 'email_suppressed', reason: s.reason, addresses: s.emails.length });
      }
      return reply.send({ ok: true });
    });
  });
}
