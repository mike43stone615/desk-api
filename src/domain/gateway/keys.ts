// API Library keys — same shape and safety properties as registry-api's
// src/domain/account/api-keys.ts (SHA-256 hash at rest, plaintext returned
// exactly once from create(), soft revocation, ownership enforced in the
// WHERE clause so "not yours" is indistinguishable from "doesn't exist",
// fail-closed verify()), extended with per-service grants.
import { createHash, randomBytes, randomUUID } from 'crypto';
import { pool } from '../../db';
import { suspendedKeyIds } from '../suspension';
import { config } from '../../config';
import { decryptSecret, encryptSecret } from './crypto';
import { provisionBrokerKey, revokeBrokerKey } from './broker';
import {
  GATEWAY_SERVICES,
  getServiceCatalog,
  isBrokeredService,
  type GatewayService,
} from './services';

export const GATEWAY_KEY_PREFIX = 'deskgw_';
/** Bounds how many real backend keys a single account can cause to be minted. */
export const MAX_ACTIVE_KEYS_PER_USER = 10;

export type GatewayKeyErrorCode =
  | 'limit_reached'
  | 'service_unavailable'
  | 'not_found'
  | 'already_revoked';

export class GatewayKeyError extends Error {
  constructor(
    readonly code: GatewayKeyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayKeyError';
  }
}

export interface GatewayKeySummary {
  id: string;
  label: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  services: GatewayService[];
  /** True while the owner (or an administrator) has switched the key off without revoking it. */
  suspended?: boolean;
}

export interface CreatedGatewayKey extends GatewayKeySummary {
  /** The plaintext key. Only ever present on the create() response. */
  key: string;
}

export interface VerifiedGatewayKey {
  id: string;
  ownerUserId: string;
  services: ReadonlySet<GatewayService>;
  /** The key, or its owner's whole account, is switched off (see domain/suspension.ts). */
  suspended: boolean;
}

export function looksLikeGatewayKey(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(GATEWAY_KEY_PREFIX);
}

export function hashGatewayKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

const NOW_SQL = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

interface KeyRow {
  id: string;
  label: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
}

function toSummary(row: KeyRow, services: GatewayService[]): GatewayKeySummary {
  return {
    id: row.id,
    label: row.label,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    services,
  };
}

function orderServices(services: Iterable<GatewayService>): GatewayService[] {
  const set = new Set(services);
  return GATEWAY_SERVICES.filter((s) => set.has(s));
}

export const gatewayApiKeys = {
  /** The owner's non-revoked keys, newest first, each with its enabled services. */
  async list(ownerUserId: string): Promise<GatewayKeySummary[]> {
    const { rows } = await pool.query<KeyRow>(
      `SELECT id, label, key_prefix, created_at, last_used_at
       FROM gateway_api_keys
       WHERE revoked_at IS NULL AND owner_user_id = $1
       ORDER BY created_at DESC`,
      [ownerUserId],
    );
    if (rows.length === 0) return [];
    const { rows: grantRows } = await pool.query<{ api_key_id: string; service: GatewayService }>(
      `SELECT g.api_key_id, g.service
       FROM gateway_api_key_grants g
       JOIN gateway_api_keys k ON k.id = g.api_key_id
       WHERE k.owner_user_id = $1 AND k.revoked_at IS NULL`,
      [ownerUserId],
    );
    const byKey = new Map<string, GatewayService[]>();
    for (const g of grantRows) {
      const list = byKey.get(g.api_key_id) ?? [];
      list.push(g.service);
      byKey.set(g.api_key_id, list);
    }
    const suspended = await suspendedKeyIds(rows.map((r) => r.id));
    return rows.map((r) => ({ ...toSummary(r, orderServices(byKey.get(r.id) ?? [])), suspended: suspended.has(r.id) }));
  },

  async countActive(ownerUserId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM gateway_api_keys WHERE revoked_at IS NULL AND owner_user_id = $1`,
      [ownerUserId],
    );
    return Number(rows[0]?.count ?? 0);
  },

  /**
   * Creates a key with the requested grants. Backend keys for brokered
   * services are minted first; if anything after that fails, whatever was
   * already minted is revoked again so no orphaned live credentials remain.
   */
  async create(ownerUserId: string, label: string, requested: GatewayService[]): Promise<CreatedGatewayKey> {
    const services = orderServices(requested);
    if (services.length === 0) throw new GatewayKeyError('service_unavailable', 'Choose at least one API.');

    const catalog = new Map(getServiceCatalog().map((e) => [e.service, e]));
    for (const service of services) {
      if (!catalog.get(service)?.available) {
        throw new GatewayKeyError('service_unavailable', `${catalog.get(service)?.name ?? service} is not available right now.`);
      }
    }
    if ((await this.countActive(ownerUserId)) >= MAX_ACTIVE_KEYS_PER_USER) {
      throw new GatewayKeyError('limit_reached', `You can have at most ${MAX_ACTIVE_KEYS_PER_USER} active keys. Revoke one first.`);
    }

    const id = randomUUID();
    const plaintext = `${GATEWAY_KEY_PREFIX}${randomBytes(24).toString('hex')}`;
    const keyHash = hashGatewayKey(plaintext);
    const keyPrefix = plaintext.slice(0, 12);

    const minted: Array<{ service: GatewayService; backendKeyId: string; encrypted: string }> = [];
    const undoMinted = async () => {
      await Promise.all(
        minted.map((m) =>
          isBrokeredService(m.service) ? revokeBrokerKey(m.service, m.backendKeyId).catch(() => {}) : undefined,
        ),
      );
    };

    try {
      for (const service of services) {
        if (!isBrokeredService(service)) continue;
        const secret = config.gatewayKeyEncryptionSecret;
        if (!secret) throw new GatewayKeyError('service_unavailable', 'Key storage is not configured.');
        const provisioned = await provisionBrokerKey(service, `gateway:${ownerUserId}:${id}`);
        minted.push({
          service,
          backendKeyId: provisioned.backendKeyId,
          encrypted: encryptSecret(provisioned.plaintext, secret),
        });
      }

      const client = await pool.connect();
      let row: KeyRow;
      try {
        await client.query('BEGIN');
        const inserted = await client.query<KeyRow>(
          `INSERT INTO gateway_api_keys (id, owner_user_id, label, key_hash, key_prefix)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, label, key_prefix, created_at, last_used_at`,
          [id, ownerUserId, label, keyHash, keyPrefix],
        );
        row = inserted.rows[0];
        for (const service of services) {
          const backend = minted.find((m) => m.service === service);
          await client.query(
            `INSERT INTO gateway_api_key_grants (id, api_key_id, service, backend_key_id, encrypted_backend_key)
             VALUES ($1, $2, $3, $4, $5)`,
            [randomUUID(), id, service, backend?.backendKeyId ?? null, backend?.encrypted ?? null],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      return { ...toSummary(row, services), key: plaintext };
    } catch (err) {
      await undoMinted();
      throw err;
    }
  },

  /**
   * Revokes a key the caller owns. The gateway key is revoked FIRST so access
   * stops immediately even if a backend is unreachable; the stored backend
   * secrets are then wiped, and the backend keys revoked best-effort. Returns
   * the services whose backend revocation failed (their secret is already
   * unrecoverable, but the upstream key row lingers until retried).
   */
  async revoke(ownerUserId: string, id: string): Promise<{ upstreamFailures: GatewayService[] }> {
    const { rows } = await pool.query<{ id: string; revoked_at: string | null }>(
      `SELECT id, revoked_at FROM gateway_api_keys WHERE id = $1 AND owner_user_id = $2`,
      [id, ownerUserId],
    );
    const existing = rows[0];
    if (!existing) throw new GatewayKeyError('not_found', 'API key not found.');
    if (existing.revoked_at) throw new GatewayKeyError('already_revoked', 'API key is already revoked.');

    await pool.query(`UPDATE gateway_api_keys SET revoked_at = ${NOW_SQL} WHERE id = $1`, [id]);

    const { rows: grants } = await pool.query<{ service: GatewayService; backend_key_id: string | null }>(
      `SELECT service, backend_key_id FROM gateway_api_key_grants WHERE api_key_id = $1`,
      [id],
    );
    await pool.query(`UPDATE gateway_api_key_grants SET encrypted_backend_key = NULL WHERE api_key_id = $1`, [id]);

    const upstreamFailures: GatewayService[] = [];
    for (const grant of grants) {
      if (!isBrokeredService(grant.service) || !grant.backend_key_id) continue;
      try {
        await revokeBrokerKey(grant.service, grant.backend_key_id);
        // Done upstream: forget the id so nothing tries again. A failed one keeps its id for the sweeper to retry.
        await pool.query(`UPDATE gateway_api_key_grants SET backend_key_id = NULL WHERE api_key_id = $1 AND service = $2`, [
          id,
          grant.service,
        ]);
      } catch {
        upstreamFailures.push(grant.service);
      }
    }
    return { upstreamFailures };
  },

  /**
   * Revokes every active key an account owns. Used just before the account is deleted so access stops at once;
   * anything an unreachable backend could not revoke now is queued by the database (see migration 0010) and retried.
   */
  async revokeAllForOwner(ownerUserId: string): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM gateway_api_keys WHERE owner_user_id = $1 AND revoked_at IS NULL`,
      [ownerUserId],
    );
    let revoked = 0;
    for (const row of rows) {
      try {
        await this.revoke(ownerUserId, row.id);
        revoked++;
      } catch {
        // Already gone or a backend is down: the deletion still proceeds and the queue covers the backend key.
      }
    }
    return revoked;
  },

  /**
   * Resolves a presented key to its owner and enabled services, or null.
   * Never throws: a transient DB error means "not verified" (the caller
   * answers 401/403), not an unhandled 500. last_used_at is best-effort.
   */
  async verify(plaintext: string): Promise<VerifiedGatewayKey | null> {
    if (!looksLikeGatewayKey(plaintext)) return null;
    try {
      const { rows } = await pool.query<{ id: string; owner_user_id: string; revoked_at: string | null }>(
        `SELECT id, owner_user_id, revoked_at FROM gateway_api_keys WHERE key_hash = $1`,
        [hashGatewayKey(plaintext)],
      );
      const key = rows[0];
      if (!key || key.revoked_at) return null;
      const { rows: grants } = await pool.query<{ service: GatewayService }>(
        `SELECT service FROM gateway_api_key_grants WHERE api_key_id = $1`,
        [key.id],
      );
      pool.query(`UPDATE gateway_api_keys SET last_used_at = ${NOW_SQL} WHERE id = $1`, [key.id]).catch(() => {});
      const { rows: off } = await pool.query(
        `SELECT 1 FROM key_suspensions WHERE api_key_id = $1 UNION ALL SELECT 1 FROM account_suspensions WHERE user_id = $2`,
        [key.id, key.owner_user_id],
      );
      return { id: key.id, ownerUserId: key.owner_user_id, services: new Set(grants.map((g) => g.service)), suspended: off.length > 0 };
    } catch {
      return null;
    }
  },

  /** The decrypted real backend key for a brokered grant, or null. */
  async getBackendKey(keyId: string, service: GatewayService): Promise<string | null> {
    const secret = config.gatewayKeyEncryptionSecret;
    if (!secret) return null;
    const { rows } = await pool.query<{ encrypted_backend_key: string | null }>(
      `SELECT encrypted_backend_key FROM gateway_api_key_grants WHERE api_key_id = $1 AND service = $2`,
      [keyId, service],
    );
    const blob = rows[0]?.encrypted_backend_key;
    if (!blob) return null;
    try {
      // The current secret first; the previous ones only exist while a rotation is in progress.
      return decryptSecret(blob, [secret, ...config.gatewayKeyEncryptionSecretsPrevious]);
    } catch {
      return null;
    }
  },
};
