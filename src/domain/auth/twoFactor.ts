// Two-factor authentication: setting it up, turning it on and off, backup codes, and the short-lived "second factor
// pending" token a sign-in exchanges for a real session (see domain/auth/totp.ts for the TOTP math itself).
import { randomUUID, randomBytes } from 'crypto';
import { pool } from '../../db';
import { config } from '../../config';
import { encryptSecret, decryptSecret } from '../gateway/crypto';
import { hashToken } from '../../infrastructure/auth/token-hash';
import { generateBackupCodes, generateTotpSecret, normalizeBackupCode, totpUri, verifyTotpCode } from './totp';

export class TwoFactorError extends Error {
  constructor(public readonly code: 'not_configured' | 'already_enabled' | 'not_set_up' | 'not_enabled' | 'invalid_code' | 'invalid_or_expired', message: string) {
    super(message);
  }
}

function encryptionSecrets(): { current: string; all: string[] } {
  const current = config.gatewayKeyEncryptionSecret;
  if (!current) throw new TwoFactorError('not_configured', 'Two-factor authentication is not available right now.');
  return { current, all: [current, ...config.gatewayKeyEncryptionSecretsPrevious] };
}

export async function isEnabled(userId: string): Promise<boolean> {
  const { rows } = await pool.query<{ n: string }>(`SELECT 1 AS n FROM users WHERE id = $1 AND totp_enabled_at IS NOT NULL`, [userId]);
  return rows.length > 0;
}

/** Starts setup: a fresh secret, held un-enabled until confirmed with a real code (so a half-finished setup cannot lock anyone out). */
export async function beginSetup(userId: string, email: string): Promise<{ secret: string; otpauthUri: string }> {
  const { rows } = await pool.query<{ totp_enabled_at: string | null }>(`SELECT totp_enabled_at FROM users WHERE id = $1`, [userId]);
  if (rows[0]?.totp_enabled_at) throw new TwoFactorError('already_enabled', 'Two-factor authentication is already on.');
  const { current } = encryptionSecrets();
  const secret = generateTotpSecret();
  await pool.query(`UPDATE users SET totp_secret_enc = $2 WHERE id = $1`, [userId, encryptSecret(secret, current)]);
  return { secret, otpauthUri: totpUri(secret, email) };
}

/** Confirms setup with a real code from the app just configured, turns 2FA on, and returns backup codes (shown once). */
export async function confirmSetup(userId: string, code: string): Promise<string[]> {
  const { rows } = await pool.query<{ totp_secret_enc: string | null; totp_enabled_at: string | null }>(`SELECT totp_secret_enc, totp_enabled_at FROM users WHERE id = $1`, [userId]);
  const row = rows[0];
  if (!row?.totp_secret_enc) throw new TwoFactorError('not_set_up', 'Start setup first.');
  if (row.totp_enabled_at) throw new TwoFactorError('already_enabled', 'Two-factor authentication is already on.');
  const { all } = encryptionSecrets();
  const secret = decryptSecret(row.totp_secret_enc, all);
  if (!verifyTotpCode(secret, code)) throw new TwoFactorError('invalid_code', 'That code is wrong or has expired. Check the time on your device and try the next code.');
  const codes = generateBackupCodes();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE users SET totp_enabled_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE id = $1`, [userId]);
    await client.query(`DELETE FROM totp_backup_codes WHERE user_id = $1`, [userId]);
    for (const raw of codes) {
      await client.query(`INSERT INTO totp_backup_codes (id, user_id, code_hash) VALUES ($1, $2, $3)`, [randomUUID(), userId, hashToken(normalizeBackupCode(raw))]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return codes;
}

/** Turns 2FA off (needs a current code, checked by the route alongside the account password). Every backup code goes with it. */
export async function disable(userId: string, code: string): Promise<void> {
  const { rows } = await pool.query<{ totp_secret_enc: string | null; totp_enabled_at: string | null }>(`SELECT totp_secret_enc, totp_enabled_at FROM users WHERE id = $1`, [userId]);
  const row = rows[0];
  if (!row?.totp_enabled_at || !row.totp_secret_enc) throw new TwoFactorError('not_enabled', 'Two-factor authentication is not on.');
  if (!(await verifyCode(userId, code))) throw new TwoFactorError('invalid_code', 'That code is wrong.');
  await pool.query(`UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL WHERE id = $1`, [userId]);
  await pool.query(`DELETE FROM totp_backup_codes WHERE user_id = $1`, [userId]);
}

export async function regenerateBackupCodes(userId: string, code: string): Promise<string[]> {
  if (!(await isEnabled(userId))) throw new TwoFactorError('not_enabled', 'Two-factor authentication is not on.');
  if (!(await verifyCode(userId, code))) throw new TwoFactorError('invalid_code', 'That code is wrong.');
  const codes = generateBackupCodes();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM totp_backup_codes WHERE user_id = $1`, [userId]);
    for (const raw of codes) await client.query(`INSERT INTO totp_backup_codes (id, user_id, code_hash) VALUES ($1, $2, $3)`, [randomUUID(), userId, hashToken(normalizeBackupCode(raw))]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return codes;
}

export async function unusedBackupCodeCount(userId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM totp_backup_codes WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  return Number(rows[0]?.n ?? 0);
}

/** A 6-digit TOTP code, or a backup code (consumed on use). True on success. */
export async function verifyCode(userId: string, submitted: string): Promise<boolean> {
  const { rows } = await pool.query<{ totp_secret_enc: string | null }>(`SELECT totp_secret_enc FROM users WHERE id = $1 AND totp_enabled_at IS NOT NULL`, [userId]);
  const secretEnc = rows[0]?.totp_secret_enc;
  if (!secretEnc) return false;
  if (/^\d{6}$/.test(submitted.trim())) {
    const { all } = encryptionSecrets();
    return verifyTotpCode(decryptSecret(secretEnc, all), submitted);
  }
  const normalized = normalizeBackupCode(submitted);
  if (!normalized) return false;
  const { rows: used } = await pool.query<{ id: string }>(
    `UPDATE totp_backup_codes SET used_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id`,
    [userId, hashToken(normalized)],
  );
  return used.length > 0;
}

const PENDING_TTL_MS = 10 * 60_000;

/** Issued after a password checks out for an account with 2FA on; exchanged for a real session by POST /auth/2fa/verify. */
export async function createPendingLogin(userId: string, meta: { ip: string; userAgent: string | null }): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO mfa_pending_logins (id, user_id, token_hash, ip_address, user_agent, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), userId, hashToken(raw), meta.ip, meta.userAgent, new Date(Date.now() + PENDING_TTL_MS).toISOString()],
  );
  return raw;
}

/** Single-use: removed the moment it is looked up, whether the code given afterward turns out right or wrong. */
export async function claimPendingLogin(rawToken: string): Promise<{ userId: string } | null> {
  const { rows } = await pool.query<{ user_id: string; expires_at: string }>(
    `DELETE FROM mfa_pending_logins WHERE token_hash = $1 RETURNING user_id, expires_at`,
    [hashToken(rawToken)],
  );
  const row = rows[0];
  if (!row || Date.parse(row.expires_at) < Date.now()) return null;
  return { userId: row.user_id };
}

export async function deleteExpiredPendingLogins(): Promise<number> {
  const res = await pool.query(`DELETE FROM mfa_pending_logins WHERE expires_at < $1`, [new Date().toISOString()]);
  return res.rowCount ?? 0;
}
