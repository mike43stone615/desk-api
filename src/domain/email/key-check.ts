// A mail key that no longer works is only noticed when somebody's reset e-mail silently never arrives. So whenever the
// key in the settings is different from the one that was last proven to work (compared by fingerprint, the key itself is
// never stored), the provider is asked whether it accepts the key, and the answer is logged and counted. No e-mail is sent.
import { createHash } from 'node:crypto';
import { pool } from '../../db';
import { outcomeForStatus, recordProviderCall } from '../../modules/provider-metrics';
import type { AppConfig } from '../../config';

export const MAIL_KEY_STATE = 'mail_key_fingerprint';

export function keyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export type MailKeyCheck = 'not_configured' | 'unchanged' | 'ok' | 'refused' | 'unreachable';

export async function checkMailKeyIfChanged(config: Pick<AppConfig, 'resendApiKey'>): Promise<MailKeyCheck> {
  if (!config.resendApiKey) return 'not_configured';
  const fingerprint = keyFingerprint(config.resendApiKey);
  try {
    const { rows } = await pool.query<{ value: string }>(`SELECT value FROM system_state WHERE key = $1`, [MAIL_KEY_STATE]);
    if (rows[0]?.value === fingerprint) return 'unchanged';
    const res = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${config.resendApiKey}` }, signal: AbortSignal.timeout(10_000) });
    recordProviderCall('resend', outcomeForStatus(res.status));
    if (!res.ok) {
      console.error(JSON.stringify({ level: 'error', event: 'mail_key_check_failed', status: res.status }));
      return res.status === 401 || res.status === 403 ? 'refused' : 'unreachable';
    }
    await pool.query(
      `INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [MAIL_KEY_STATE, fingerprint],
    );
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ level: 'audit', event: 'mail_key_check_ok', fingerprint }));
    return 'ok';
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', event: 'mail_key_check_failed', detail: (err as Error).message.slice(0, 200) }));
    return 'unreachable';
  }
}
