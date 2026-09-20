// Compares the backend keys THIS service believes exist with the ones the backends actually hold, so drift is found
// instead of silently accumulating. Two kinds:
//  - orphan: a live key on a backend labelled `gateway:<owner>:<gatewayKeyId>` (only ever created here) that no active
//    grant refers to. Nothing can use it (the stored copy of its secret is gone), so it is revoked. Keys younger than
//    a few minutes are left alone: a key is minted on the backend a moment before its row is saved here.
//  - missing: an active grant whose backend key is no longer live on the backend (revoked or deleted there by hand).
//    That developer's calls to that service now fail. It is only REPORTED, never re-minted: someone may have
//    revoked it on purpose to cut the developer off.
// A backend that cannot be reached is skipped (and reported), never treated as "everything is missing".
import { pool } from '../../db';
import { listBrokerKeys, revokeBrokerKey } from './broker';
import type { BrokeredService } from './services';

const BROKERED: BrokeredService[] = ['registry_api', 'market_validation_api'];
const YOUNG_MS = 10 * 60 * 1000;
const LABEL = /^gateway:[^:]+:([^:]+)$/;

export interface DriftReport {
  orphansRevoked: number;
  orphansFailed: number;
  missing: number;
  unreachable: BrokeredService[];
}

export async function reconcileBackendKeys(now = Date.now()): Promise<DriftReport> {
  const report: DriftReport = { orphansRevoked: 0, orphansFailed: 0, missing: 0, unreachable: [] };

  for (const service of BROKERED) {
    let upstream;
    try {
      upstream = await listBrokerKeys(service);
    } catch {
      report.unreachable.push(service);
      continue;
    }

    const { rows: held } = await pool.query<{ backend_key_id: string }>(
      `SELECT g.backend_key_id FROM gateway_api_key_grants g JOIN gateway_api_keys k ON k.id = g.api_key_id ` +
        `WHERE g.service = $1 AND g.backend_key_id IS NOT NULL AND k.revoked_at IS NULL`,
      [service],
    );
    const heldIds = new Set(held.map((r) => r.backend_key_id));
    const upstreamIds = new Set(upstream.map((k) => k.id));

    for (const id of heldIds) if (!upstreamIds.has(id)) report.missing++;

    const candidates = upstream.filter((k) => LABEL.test(k.label) && !heldIds.has(k.id) && now - k.createdAtMs > YOUNG_MS);
    if (candidates.length === 0) continue;

    // A key we still hold as active (its grant row just not matching, e.g. mid-creation) must never be revoked here.
    const gatewayIds = candidates.map((k) => LABEL.exec(k.label)![1]);
    const { rows: known } = await pool.query<{ id: string; revoked_at: string | null }>(
      `SELECT id, revoked_at FROM gateway_api_keys WHERE id = ANY($1)`,
      [gatewayIds],
    );
    const stillActive = new Set(known.filter((k) => !k.revoked_at).map((k) => k.id));

    for (const key of candidates) {
      if (stillActive.has(LABEL.exec(key.label)![1])) continue;
      try {
        await revokeBrokerKey(service, key.id);
        report.orphansRevoked++;
      } catch {
        report.orphansFailed++;
      }
    }
  }
  return report;
}
