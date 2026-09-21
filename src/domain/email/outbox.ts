// Sending through the mail provider, and trying again when it could not be reached or was busy.
//
// An e-mail that fails for a reason that may pass (the provider is down, over its limit, or unreachable) is kept in
// email_outbox and tried again after 1, 5 and 15 minutes, then dropped: the reset and confirmation links inside expire
// anyway, and a queue that grows forever is worse than a lost e-mail. A row is deleted the moment it is sent.
// Refusals that will not change (a rejected address, a bad request) are never queued.
import { randomUUID } from 'node:crypto';
import { pool } from '../../db';
import { outcomeForStatus, recordProviderCall } from '../../modules/provider-metrics';
import type { AppConfig } from '../../config';
import { htmlToText } from '../../infrastructure/email/text';

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
}

export interface DeliveryResult {
  ok: boolean;
  status: number;
  detail: string;
  /** True when trying again later may succeed. */
  transient: boolean;
}

const BACKOFF_MINUTES = [1, 5, 15];

export async function deliverViaProvider(config: Pick<AppConfig, 'resendApiKey' | 'emailFrom'>, mail: OutgoingEmail): Promise<DeliveryResult> {
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `Desk <${config.emailFrom}>`,
        to: [mail.to],
        subject: mail.subject,
        html: mail.html,
        // A plain-text copy for mail programs that do not show HTML, and a better score with spam filters.
        text: htmlToText(mail.html),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    recordProviderCall('resend', outcomeForStatus(resp.status));
    if (resp.ok) return { ok: true, status: resp.status, detail: '', transient: false };
    const detail = (await resp.text().catch(() => '')).substring(0, 300);
    return { ok: false, status: resp.status, detail, transient: resp.status === 429 || resp.status >= 500 };
  } catch (err) {
    recordProviderCall('resend', 'error');
    return { ok: false, status: 0, detail: `unreachable: ${(err as Error).message}`.substring(0, 300), transient: true };
  }
}

export async function queueForRetry(mail: OutgoingEmail & { kind: string; error: string }): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO email_outbox (id, to_email, subject, html, kind, attempts, next_attempt_at, last_error)
       VALUES ($1, $2, $3, $4, $5, 0, now() + ($6 || ' minutes')::interval, $7)`,
      [randomUUID(), mail.to, mail.subject, mail.html, mail.kind, String(BACKOFF_MINUTES[0]), mail.error.substring(0, 300)],
    );
  } catch {
    /* the queue is best-effort: never make a failed send worse */
  }
}

/** Tries the e-mails that are due. Run every minute. Returns how many were sent and how many were given up on. */
export async function processOutbox(config: Pick<AppConfig, 'resendApiKey' | 'emailFrom'>): Promise<{ sent: number; gaveUp: number; waiting: number }> {
  let sent = 0;
  let gaveUp = 0;
  if (!config.resendApiKey) return { sent, gaveUp, waiting: 0 };
  const { rows } = await pool.query<{ id: string; to_email: string; subject: string; html: string; attempts: number }>(
    `SELECT id, to_email, subject, html, attempts FROM email_outbox WHERE next_attempt_at <= now() ORDER BY next_attempt_at LIMIT 20`,
  );
  for (const row of rows) {
    const result = await deliverViaProvider(config, { to: row.to_email, subject: row.subject, html: row.html });
    const attempts = row.attempts + 1;
    if (result.ok || !result.transient || attempts >= BACKOFF_MINUTES.length + 1) {
      await pool.query(`DELETE FROM email_outbox WHERE id = $1`, [row.id]);
      if (result.ok) sent++;
      else {
        gaveUp++;
        console.error(JSON.stringify({ level: 'error', event: 'email_given_up', status: result.status, attempts }));
      }
    } else {
      await pool.query(
        `UPDATE email_outbox SET attempts = $2, next_attempt_at = now() + ($3 || ' minutes')::interval, last_error = $4 WHERE id = $1`,
        [row.id, attempts, String(BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)]), `${result.status} ${result.detail}`.substring(0, 300)],
      );
    }
  }
  const { rows: left } = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM email_outbox`);
  return { sent, gaveUp, waiting: Number(left[0]?.n ?? 0) };
}
