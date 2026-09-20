// Revokes backend keys (registry-api / market-validation-api) that nothing references any more:
//  1. the queue filled by the database trigger when a grant is deleted (a deleted user, a removed key), and
//  2. grants of an already-revoked gateway key whose upstream revocation failed at the time.
// Revoking is idempotent upstream (already-gone counts as done), so a retry is always safe.
import { pool } from '../../db';
import { revokeBrokerKey } from './broker';
import { isBrokeredService, type GatewayService } from './services';

const BATCH = 50;

export interface SweepResult {
  revoked: number;
  failed: number;
}

export async function sweepBackendKeys(): Promise<SweepResult> {
  const result: SweepResult = { revoked: 0, failed: 0 };

  const { rows: queued } = await pool.query<{ id: string; service: GatewayService; backend_key_id: string }>(
    `SELECT id, service, backend_key_id FROM gateway_backend_key_revocations ORDER BY created_at LIMIT ${BATCH}`,
  );
  for (const item of queued) {
    if (!isBrokeredService(item.service)) continue;
    try {
      await revokeBrokerKey(item.service, item.backend_key_id);
      await pool.query(`DELETE FROM gateway_backend_key_revocations WHERE id = $1`, [item.id]);
      result.revoked++;
    } catch (err) {
      result.failed++;
      await pool.query(
        `UPDATE gateway_backend_key_revocations SET attempts = attempts + 1, last_error = $2 WHERE id = $1`,
        [item.id, err instanceof Error ? err.message.slice(0, 200) : 'unknown error'],
      );
    }
  }

  const { rows: leftovers } = await pool.query<{ id: string; service: GatewayService; backend_key_id: string }>(
    `SELECT g.id, g.service, g.backend_key_id FROM gateway_api_key_grants g JOIN gateway_api_keys k ON k.id = g.api_key_id ` +
      `WHERE k.revoked_at IS NOT NULL AND g.backend_key_id IS NOT NULL LIMIT ${BATCH}`,
  );
  for (const grant of leftovers) {
    if (!isBrokeredService(grant.service)) continue;
    try {
      await revokeBrokerKey(grant.service, grant.backend_key_id);
      await pool.query(`UPDATE gateway_api_key_grants SET backend_key_id = NULL WHERE id = $1`, [grant.id]);
      result.revoked++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
