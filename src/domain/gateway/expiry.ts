// The nightly clean-up of API keys that can no longer be used because of time: past their expiry date, or unused for
// KEY_IDLE_DAYS. They are refused at once by verify(); this revokes them for real (including their backend keys).
import type { FastifyBaseLogger } from 'fastify';
import { pool } from '../../db';
import { gatewayApiKeys, keyTimeProblem } from './keys';

export async function revokeExpiredKeys(log: FastifyBaseLogger): Promise<number> {
  const { rows } = await pool.query<{ id: string; owner_user_id: string; created_at: string; last_used_at: string | null; expires_at: string | null }>(
    `SELECT id, owner_user_id, created_at, last_used_at, expires_at FROM gateway_api_keys WHERE revoked_at IS NULL`,
  );
  let revoked = 0;
  for (const key of rows) {
    const problem = keyTimeProblem(key);
    if (!problem) continue;
    try {
      await gatewayApiKeys.revoke(key.owner_user_id, key.id);
      revoked++;
      log.info({ event: 'gateway_key_expired', keyId: key.id, reason: problem }, 'revoked an expired or idle API key');
    } catch (err) {
      log.warn({ err, keyId: key.id }, 'could not revoke an expired API key; will retry tomorrow');
    }
  }
  return revoked;
}
