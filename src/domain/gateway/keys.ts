// API Library keys — same shape and safety properties as registry-api's
// src/domain/account/api-keys.ts (SHA-256 hash at rest, plaintext returned
// exactly once from create(), soft revocation, ownership enforced in the
// WHERE clause so "not yours" is indistinguishable from "doesn't exist",
// fail-closed verify()), extended with per-service grants.
import { subscriptionFor } from '../billing/plans';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { pool } from '../../db';
import { suspendedKeyIds } from '../suspension';
import { config } from '../../config';
import { keyFirstCallSeconds, keysCreatedTotal } from '../../modules/metrics';
import { decryptSecret, encryptSecret } from './crypto';
import { provisionBrokerKey, revokeBrokerKey } from './broker';
import {
  GATEWAY_SERVICES,
  getServiceCatalog,
  isBrokeredService,
  type GatewayService,
} from './services';

export const GATEWAY_KEY_PREFIX = 'deskgw_';
/** Parts of the Desk API a key may read: its own profile, setup drafts, businesses (with members and invites). */
export const DESK_SCOPES = ['profile', 'drafts', 'businesses'] as const;
export type DeskScope = (typeof DESK_SCOPES)[number];
/** Bounds how many real backend keys a single account can cause to be minted. */
export const MAX_ACTIVE_KEYS_PER_USER = 10;
export const MAX_ACTIVE_KEYS_PER_TEAM = 25;

export type GatewayKeyErrorCode =
  | 'limit_reached'
  | 'service_unavailable'
  | 'not_found'
  | 'already_revoked'
  | 'team_desk_api'
  | 'sandbox_desk_api';

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
  /** When the key stops working, or null for a key that does not expire. */
  expiresAt?: string | null;
  /** Which parts of the Desk API the key may read (all of them unless the owner chose fewer). */
  deskScopes?: DeskScope[];
  /** A limit set for this key by an administrator (calls a minute), or null for the standard limit. */
  rateLimitPerMinute?: number | null;
  /** The team the key belongs to, or null for a personal key. A team key shares the team's allowance. */
  teamId?: string | null;
  /** A sandbox key answers with fixed sample data and calls no backend (see sandbox.ts). */
  sandbox?: boolean;
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
  /** Set when the key is past its expiry date or has been idle too long: it must be refused, with this reason. */
  timeProblem?: 'expired' | 'idle';
  deskScopes: ReadonlySet<DeskScope>;
  rateLimitPerMinute: number | null;
  /** The team the key belongs to (its allowance is the team's), or null. */
  teamId: string | null;
  sandbox: boolean;
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
  expires_at?: string | null;
  desk_scopes?: DeskScope[];
  rate_limit_per_minute?: number | null;
  team_id?: string | null;
  sandbox?: boolean;
}

/** How often a key's "last used" time is refreshed while it is in use. */
export const LAST_USED_REFRESH_MS = 5 * 60_000;

/** A key nobody has used for this long is refused (and revoked by the nightly job); the owner can simply make a new one. */
export const KEY_IDLE_DAYS = 180;

/** Why a key can no longer be used because of time, or null when it is fine. */
export function keyTimeProblem(key: { created_at: string; last_used_at: string | null; expires_at?: string | null }, now = Date.now()): 'expired' | 'idle' | null {
  if (key.expires_at && Date.parse(key.expires_at) <= now) return 'expired';
  if (now - Date.parse(key.last_used_at ?? key.created_at) > KEY_IDLE_DAYS * 86_400_000) return 'idle';
  return null;
}

function toSummary(row: KeyRow, services: GatewayService[]): GatewayKeySummary {
  return {
    id: row.id,
    label: row.label,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    services,
    expiresAt: row.expires_at ?? null,
    deskScopes: row.desk_scopes ?? [...DESK_SCOPES],
    rateLimitPerMinute: row.rate_limit_per_minute ?? null,
    teamId: row.team_id ?? null,
    sandbox: row.sandbox ?? false,
  };
}

function orderServices(services: Iterable<GatewayService>): GatewayService[] {
  const set = new Set(services);
  return GATEWAY_SERVICES.filter((s) => set.has(s));
}

export const gatewayApiKeys = {
  /**
   * The non-revoked keys, newest first, each with its enabled services. Without a team: the person's own personal keys
   * (team keys they made belong to the team and are listed under it). With a team id: that team's keys (the caller
   * has already checked the person may see them).
   */
  async list(ownerUserId: string, teamId?: string): Promise<GatewayKeySummary[]> {
    const scope = teamId ? `k.team_id = $1` : `k.owner_user_id = $1 AND k.team_id IS NULL`;
    const param = teamId ?? ownerUserId;
    const { rows } = await pool.query<KeyRow>(
      `SELECT k.id, k.label, k.key_prefix, k.created_at, k.last_used_at, k.expires_at, k.desk_scopes, k.rate_limit_per_minute, k.team_id, k.sandbox
       FROM gateway_api_keys k
       WHERE k.revoked_at IS NULL AND ${scope}
       ORDER BY k.created_at DESC`,
      [param],
    );
    if (rows.length === 0) return [];
    const { rows: grantRows } = await pool.query<{ api_key_id: string; service: GatewayService }>(
      `SELECT g.api_key_id, g.service
       FROM gateway_api_key_grants g
       JOIN gateway_api_keys k ON k.id = g.api_key_id
       WHERE ${scope} AND k.revoked_at IS NULL`,
      [param],
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

  async countActive(ownerUserId: string, teamId?: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      teamId
        ? `SELECT COUNT(*) AS count FROM gateway_api_keys WHERE revoked_at IS NULL AND team_id = $1`
        : `SELECT COUNT(*) AS count FROM gateway_api_keys WHERE revoked_at IS NULL AND owner_user_id = $1 AND team_id IS NULL`,
      [teamId ?? ownerUserId],
    );
    return Number(rows[0]?.count ?? 0);
  },

  /** The summary of one live key, whether it is personal or a team's (the caller has already checked access). */
  async summaryOf(keyId: string): Promise<GatewayKeySummary | undefined> {
    const { rows } = await pool.query<{ owner_user_id: string; team_id: string | null }>(`SELECT owner_user_id, team_id FROM gateway_api_keys WHERE id = $1`, [keyId]);
    const key = rows[0];
    if (!key) return undefined;
    return (await this.list(key.owner_user_id, key.team_id ?? undefined)).find((k) => k.id === keyId);
  },

  /**
   * Creates a key with the requested grants. Backend keys for brokered
   * services are minted first; if anything after that fails, whatever was
   * already minted is revoked again so no orphaned live credentials remain.
   */
  async create(ownerUserId: string, label: string, requested: GatewayService[], expiresInDays?: number, deskScopes: DeskScope[] = [...DESK_SCOPES], teamId?: string, sandbox = false): Promise<CreatedGatewayKey> {
    const services = orderServices(requested);
    if (services.length === 0) throw new GatewayKeyError('service_unavailable', 'Choose at least one API.');

    const catalog = new Map(getServiceCatalog().map((e) => [e.service, e]));
    for (const service of services) {
      if (!catalog.get(service)?.available) {
        throw new GatewayKeyError('service_unavailable', `${catalog.get(service)?.name ?? service} is not available right now.`);
      }
    }
    if (sandbox && services.includes('desk_api')) throw new GatewayKeyError('sandbox_desk_api', 'A sandbox key cannot carry the Desk API: it exists to give fixed sample answers, and the Desk API answers with your real data.');
    if (teamId) {
      // A team key would act as whoever made it on the Desk API, which would hand that person's data to the whole team.
      if (services.includes('desk_api')) throw new GatewayKeyError('team_desk_api', 'A team key cannot carry the Desk API (it would act as one person). Use a personal key for that.');
      if ((await this.countActive(ownerUserId, teamId)) >= MAX_ACTIVE_KEYS_PER_TEAM) {
        throw new GatewayKeyError('limit_reached', `A team can have at most ${MAX_ACTIVE_KEYS_PER_TEAM} active keys. Revoke one first.`);
      }
    } else {
      // The cap comes from the person's plan (the Free plan's is the same 10 there always was).
      const cap = (await subscriptionFor('user', ownerUserId)).plan.maxKeys;
      if ((await this.countActive(ownerUserId)) >= cap) {
        throw new GatewayKeyError('limit_reached', `You can have at most ${cap} active keys on your plan. Revoke one first.`);
      }
    }

    const id = randomUUID();
    const plaintext = `${GATEWAY_KEY_PREFIX}${sandbox ? 'test_' : ''}${randomBytes(24).toString('hex')}`;
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
        if (!isBrokeredService(service) || sandbox) continue; // a sandbox key has no backend key to mint
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
          `INSERT INTO gateway_api_keys (id, owner_user_id, label, key_hash, key_prefix, expires_at, desk_scopes, team_id, sandbox)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, label, key_prefix, created_at, last_used_at, expires_at, desk_scopes, rate_limit_per_minute, team_id, sandbox`,
          [id, ownerUserId, label, keyHash, keyPrefix, expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString() : null, deskScopes, teamId ?? null, sandbox],
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
        keysCreatedTotal.inc();
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
      `SELECT id FROM gateway_api_keys WHERE owner_user_id = $1 AND revoked_at IS NULL AND team_id IS NULL`,
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
      const { rows } = await pool.query<{ id: string; owner_user_id: string; revoked_at: string | null; created_at: string; last_used_at: string | null; desk_scopes: DeskScope[]; rate_limit_per_minute: number | null; expires_at: string | null; team_id: string | null; sandbox: boolean }>(
        `SELECT id, owner_user_id, revoked_at, created_at, last_used_at, expires_at, desk_scopes, rate_limit_per_minute, team_id, sandbox FROM gateway_api_keys WHERE key_hash = $1`,
        [hashGatewayKey(plaintext)],
      );
      const key = rows[0];
      if (!key || key.revoked_at) return null;
      // An expired or idle key is refused with its own reason (see verifyOrExplain in the routes).
      const timeProblem = keyTimeProblem(key);
      if (timeProblem) return { id: key.id, ownerUserId: key.owner_user_id, services: new Set(), suspended: false, timeProblem, deskScopes: new Set(key.desk_scopes ?? DESK_SCOPES), rateLimitPerMinute: key.rate_limit_per_minute ?? null, teamId: key.team_id ?? null, sandbox: key.sandbox === true };
      const { rows: grants } = await pool.query<{ service: GatewayService }>(
        `SELECT service FROM gateway_api_key_grants WHERE api_key_id = $1`,
        [key.id],
      );
      // "Last used" only has to be roughly right, so it is written at most every few minutes: a busy key no longer causes a
      // database write on every call (a GET used to write). The first call of a key is also counted for the funnel.
      if (!key.last_used_at || Date.now() - Date.parse(key.last_used_at) > LAST_USED_REFRESH_MS) {
        if (!key.last_used_at) keyFirstCallSeconds.observe(Math.max(0, (Date.now() - Date.parse(key.created_at)) / 1000));
        pool.query(`UPDATE gateway_api_keys SET last_used_at = ${NOW_SQL} WHERE id = $1`, [key.id]).catch(() => {});
      }
      const { rows: off } = await pool.query(
        `SELECT 1 FROM key_suspensions WHERE api_key_id = $1 UNION ALL SELECT 1 FROM account_suspensions WHERE user_id = $2`,
        [key.id, key.owner_user_id],
      );
      return { id: key.id, ownerUserId: key.owner_user_id, services: new Set(grants.map((g) => g.service)), suspended: off.length > 0, deskScopes: new Set(key.desk_scopes ?? DESK_SCOPES), rateLimitPerMinute: key.rate_limit_per_minute ?? null, teamId: key.team_id ?? null, sandbox: key.sandbox === true };
    } catch {
      return null;
    }
  },

  /**
   * Adds an API to a key the caller owns (a brokered API gets its own real backend key, minted now). The key itself, and
   * everything already using it, is untouched.
   */
  async addService(ownerUserId: string, keyId: string, service: GatewayService): Promise<GatewayKeySummary> {
    const { rows } = await pool.query<{ id: string; revoked_at: string | null; team_id: string | null; sandbox: boolean }>(
      `SELECT id, revoked_at, team_id, sandbox FROM gateway_api_keys WHERE id = $1 AND owner_user_id = $2`,
      [keyId, ownerUserId],
    );
    if (!rows[0]) throw new GatewayKeyError('not_found', 'API key not found.');
    if (rows[0].revoked_at) throw new GatewayKeyError('already_revoked', 'This API key has been revoked.');
    if (rows[0].team_id && service === 'desk_api') throw new GatewayKeyError('team_desk_api', 'A team key cannot carry the Desk API (it would act as one person). Use a personal key for that.');
    if (rows[0].sandbox && service === 'desk_api') throw new GatewayKeyError('sandbox_desk_api', 'A sandbox key cannot carry the Desk API.');
    const catalog = new Map(getServiceCatalog().map((e) => [e.service, e]));
    if (!catalog.get(service)?.available) throw new GatewayKeyError('service_unavailable', `${catalog.get(service)?.name ?? service} is not available right now.`);
    const existing = await pool.query<{ service: GatewayService }>(`SELECT service FROM gateway_api_key_grants WHERE api_key_id = $1`, [keyId]);
    if (!existing.rows.some((g) => g.service === service)) {
      let backendKeyId: string | null = null;
      let encrypted: string | null = null;
      if (isBrokeredService(service) && !rows[0].sandbox) {
        const secret = config.gatewayKeyEncryptionSecret;
        if (!secret) throw new GatewayKeyError('service_unavailable', 'Key storage is not configured.');
        const provisioned = await provisionBrokerKey(service, `gateway:${ownerUserId}:${keyId}`);
        backendKeyId = provisioned.backendKeyId;
        encrypted = encryptSecret(provisioned.plaintext, secret);
      }
      try {
        await pool.query(
          `INSERT INTO gateway_api_key_grants (id, api_key_id, service, backend_key_id, encrypted_backend_key) VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), keyId, service, backendKeyId, encrypted],
        );
      } catch (err) {
        if (backendKeyId && isBrokeredService(service)) await revokeBrokerKey(service, backendKeyId).catch(() => {});
        throw err;
      }
    }
    return (await this.summaryOf(keyId))!;
  },

  /** Removes an API from a key the caller owns. At least one API must stay; the backend key of a brokered API is revoked. */
  async removeService(ownerUserId: string, keyId: string, service: GatewayService): Promise<GatewayKeySummary> {
    const { rows } = await pool.query<{ id: string; revoked_at: string | null }>(
      `SELECT id, revoked_at FROM gateway_api_keys WHERE id = $1 AND owner_user_id = $2`,
      [keyId, ownerUserId],
    );
    if (!rows[0]) throw new GatewayKeyError('not_found', 'API key not found.');
    if (rows[0].revoked_at) throw new GatewayKeyError('already_revoked', 'This API key has been revoked.');
    const existing = await pool.query<{ service: GatewayService }>(`SELECT service FROM gateway_api_key_grants WHERE api_key_id = $1`, [keyId]);
    if (!existing.rows.some((g) => g.service === service)) return (await this.summaryOf(keyId))!;
    if (existing.rows.length <= 1) throw new GatewayKeyError('limit_reached', 'A key needs at least one API. Revoke the key instead.');
    const removed = await pool.query<{ backend_key_id: string | null }>(
      `DELETE FROM gateway_api_key_grants WHERE api_key_id = $1 AND service = $2 RETURNING backend_key_id`,
      [keyId, service],
    );
    const backendKeyId = removed.rows[0]?.backend_key_id;
    if (backendKeyId && isBrokeredService(service)) await revokeBrokerKey(service, backendKeyId).catch(() => {});
    return (await this.summaryOf(keyId))!;
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

// ── per-key limit ─────────────────────────────────────────────────────────────────────────────────────────────────
const factorCache = new Map<string, { info: KeyBucketInfo; at: number }>();
const FACTOR_TTL_MS = 60_000;

export interface KeyBucketInfo {
  /** The share of an address's allowance the bucket gets; null for the standard share. */
  factor: number | null;
  /** Set for a team key: every key of the team draws on one bucket named by this id. */
  teamId: string | null;
}

/**
 * Which allowance a presented key draws on. A personal key has its own bucket, with the administrator's limit for it when
 * one was set. A team key draws on its TEAM's bucket, shared with every other key of the team, with the team's limit when
 * an administrator set one. The limiter runs before the key is verified, so this looks the key up by its hash (kept for a
 * minute in memory, so a busy key costs one lookup a minute).
 */
export async function keyBucketInfo(plaintext: string, perMinuteOfAnAddress: number): Promise<KeyBucketInfo> {
  const hash = hashGatewayKey(plaintext);
  const hit = factorCache.get(hash);
  const now = Date.now();
  if (hit && now - hit.at < FACTOR_TTL_MS) return hit.info;
  let info: KeyBucketInfo;
  try {
    const { rows } = await pool.query<{ rate_limit_per_minute: number | null; team_id: string | null; team_limit: number | null; plan_limit: number | null }>(
      `SELECT k.rate_limit_per_minute, k.team_id, t.rate_limit_per_minute AS team_limit, p.per_minute_limit AS plan_limit
         FROM gateway_api_keys k
         LEFT JOIN teams t ON t.id = k.team_id
         LEFT JOIN subscriptions s ON s.subject_type = CASE WHEN k.team_id IS NULL THEN 'user' ELSE 'team' END
                                  AND s.subject_id = COALESCE(k.team_id, k.owner_user_id) AND s.status <> 'canceled'
         LEFT JOIN plans p ON p.id = s.plan_id
        WHERE k.key_hash = $1`,
      [hash],
    );
    const r = rows[0];
    // Precedence: an administrator's limit for the key or team, then the plan's, then the standard one.
    if (r?.team_id) info = { teamId: r.team_id, factor: r.team_limit ? r.team_limit / perMinuteOfAnAddress : r.plan_limit ? r.plan_limit / perMinuteOfAnAddress : null };
    else info = { teamId: null, factor: r?.rate_limit_per_minute ? r.rate_limit_per_minute / perMinuteOfAnAddress : r?.plan_limit ? r.plan_limit / perMinuteOfAnAddress : null };
  } catch {
    info = { factor: null, teamId: null };
  }
  if (factorCache.size > 5000) factorCache.clear();
  factorCache.set(hash, { info, at: now });
  return info;
}

/** The share of an address's allowance a personal key gets when an administrator gave it its own limit; else null. */
export async function keyRateFactor(plaintext: string, perMinuteOfAnAddress: number): Promise<number | null> {
  return (await keyBucketInfo(plaintext, perMinuteOfAnAddress)).factor;
}

/** For tests and for when an administrator changes a limit. */
export function forgetKeyRateFactors(): void {
  factorCache.clear();
}
