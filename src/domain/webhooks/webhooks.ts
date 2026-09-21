// Outbound webhooks: Desk tells a developer's server when something happens (a key is made or revoked, someone joins a team,
// a plan changes). Each delivery is
//   * signed:   `Desk-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the endpoint's secret>`, so the receiver
//               can prove it came from Desk and reject a replay (an old `t`);
//   * retried:  after 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours, then marked failed; an endpoint that fails ten
//               deliveries in a row is switched off (its owner re-enables it by rotating the secret);
//   * safe:     https only, and never to a private, loopback or link-local address (checked when the endpoint is made and again
//               at every delivery); redirects are not followed; the reply body is never read.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { pool } from '../../db';
import { config } from '../../config';
import { decryptSecret, encryptSecret } from '../gateway/crypto';
import { subscriptionFor } from '../billing/plans';
import { atLeast, roleIn } from '../teams/teams';

export const WEBHOOK_EVENTS = ['key.created', 'key.revoked', 'team.member_joined', 'team.member_removed', 'plan.changed', 'oauth.app_authorized', 'usage.cap_reached', 'webhook.test'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600];
const DISABLE_AFTER_FAILED_DELIVERIES = 10;
const TOLERANCE_SECONDS = 300;

export class WebhookError extends Error {
  constructor(public readonly code: 'invalid_url' | 'limit_reached' | 'not_found' | 'forbidden' | 'unavailable', message: string) {
    super(message);
    this.name = 'WebhookError';
  }
}

// ── signing ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export function signPayload(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** What a receiver runs: true only when the signature matches AND the timestamp is within five minutes of now. */
export function verifySignature(secret: string, header: string, body: string, now = Date.now(), toleranceSeconds = TOLERANCE_SECONDS): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=', 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(now / 1000 - t) > toleranceSeconds) return false;
  const expected = Buffer.from(signPayload(secret, t, body).split('v1=')[1], 'hex');
  const given = Buffer.from(parts.v1, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ── address safety ──────────────────────────────────────────────────────────────────────────────────────────────────
function isPrivateIPv4(a: number, b: number): boolean {
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPrivateAddress(mapped[1]);
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return isPrivateIPv4(a, b);
  }
  const v6 = address.toLowerCase();
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb');
}

/** Throws unless the URL is https, on a normal port, and every address its name resolves to is public. */
export async function assertSafeWebhookUrl(raw: string, resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((r) => r.address)): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new WebhookError('invalid_url', 'That is not a valid URL.'); }
  if (url.protocol !== 'https:') throw new WebhookError('invalid_url', 'A webhook address must start with https://.');
  if (url.username || url.password) throw new WebhookError('invalid_url', 'A webhook address cannot contain a user name or password.');
  if (url.port && !['443', '8443'].includes(url.port)) throw new WebhookError('invalid_url', 'A webhook address can only use port 443 or 8443.');
  if (raw.length > 500) throw new WebhookError('invalid_url', 'That address is too long.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => { throw new WebhookError('invalid_url', 'That host name does not resolve.'); });
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new WebhookError('invalid_url', 'That address points at a private or internal network, which webhooks cannot reach.');
  return url;
}

// ── endpoints ───────────────────────────────────────────────────────────────────────────────────────────────────────
export interface WebhookEndpoint {
  id: string; url: string; events: string[]; teamId: string | null; active: boolean; disabledReason: string | null; createdAt: string; consecutiveFailures: number;
}
interface EndpointRow { id: string; url: string; events: string[]; team_id: string | null; active: boolean; disabled_reason: string | null; created_at: string; consecutive_failures: number }
const toEndpoint = (r: EndpointRow): WebhookEndpoint => ({ id: r.id, url: r.url, events: r.events, teamId: r.team_id, active: r.active, disabledReason: r.disabled_reason, createdAt: r.created_at, consecutiveFailures: r.consecutive_failures });
const COLS = 'id, url, events, team_id, active, disabled_reason, created_at, consecutive_failures';

const secretKey = () => {
  if (!config.gatewayKeyEncryptionSecret) throw new WebhookError('unavailable', 'Webhook storage is not configured.');
  return config.gatewayKeyEncryptionSecret;
};

export function newSecret(): string {
  return `whsec_${randomBytes(24).toString('hex')}`;
}

async function assertMayManage(userId: string, teamId: string | null): Promise<void> {
  if (!teamId) return;
  const role = await roleIn(teamId, userId);
  if (!role) throw new WebhookError('not_found', 'Team not found.');
  if (!atLeast(role, 'admin')) throw new WebhookError('forbidden', 'Only a team admin or owner can manage its webhooks.');
}

export const webhooks = {
  async create(userId: string, input: { url: string; events: string[]; teamId?: string | null }): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
    const teamId = input.teamId ?? null;
    await assertMayManage(userId, teamId);
    const events = [...new Set(input.events)];
    if (events.some((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e) || e === 'webhook.test')) throw new WebhookError('invalid_url', 'Unknown event name.');
    await assertSafeWebhookUrl(input.url);
    const cap = (await subscriptionFor(teamId ? 'team' : 'user', teamId ?? userId)).plan.maxWebhooks;
    const { rows: c } = await pool.query<{ n: string }>(teamId ? `SELECT COUNT(*) AS n FROM webhook_endpoints WHERE team_id = $1` : `SELECT COUNT(*) AS n FROM webhook_endpoints WHERE owner_user_id = $1 AND team_id IS NULL`, [teamId ?? userId]);
    if (Number(c[0]?.n ?? 0) >= cap) throw new WebhookError('limit_reached', `Your plan allows ${cap} webhook endpoints. Remove one first.`);
    const secret = newSecret();
    const id = randomUUID();
    const { rows } = await pool.query<EndpointRow>(
      `INSERT INTO webhook_endpoints (id, owner_user_id, team_id, url, secret_enc, events) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLS}`,
      [id, userId, teamId, input.url, encryptSecret(secret, secretKey()), events],
    );
    return { endpoint: toEndpoint(rows[0]), secret };
  },

  async list(userId: string, teamId?: string | null): Promise<WebhookEndpoint[]> {
    if (teamId) {
      const role = await roleIn(teamId, userId);
      if (!role) throw new WebhookError('not_found', 'Team not found.');
      const { rows } = await pool.query<EndpointRow>(`SELECT ${COLS} FROM webhook_endpoints WHERE team_id = $1 ORDER BY created_at DESC`, [teamId]);
      return rows.map(toEndpoint);
    }
    const { rows } = await pool.query<EndpointRow>(`SELECT ${COLS} FROM webhook_endpoints WHERE owner_user_id = $1 AND team_id IS NULL ORDER BY created_at DESC`, [userId]);
    return rows.map(toEndpoint);
  },

  /** The endpoint, if the person may manage it (their own, or their team's when they are an admin or owner). */
  async manageable(userId: string, id: string): Promise<(EndpointRow & { owner_user_id: string; secret_enc: string }) | null> {
    const { rows } = await pool.query<EndpointRow & { owner_user_id: string; secret_enc: string }>(`SELECT ${COLS}, owner_user_id, secret_enc FROM webhook_endpoints WHERE id = $1`, [id]);
    const e = rows[0];
    if (!e) return null;
    if (e.team_id) return atLeast(await roleIn(e.team_id, userId), 'admin') ? e : null;
    return e.owner_user_id === userId ? e : null;
  },

  async remove(userId: string, id: string): Promise<boolean> {
    if (!(await this.manageable(userId, id))) return false;
    await pool.query(`DELETE FROM webhook_endpoints WHERE id = $1`, [id]);
    return true;
  },

  /** A new secret (shown once); also switches the endpoint back on if it had been disabled after repeated failures. */
  async rotateSecret(userId: string, id: string): Promise<string | null> {
    if (!(await this.manageable(userId, id))) return null;
    const secret = newSecret();
    await pool.query(`UPDATE webhook_endpoints SET secret_enc = $2, active = TRUE, consecutive_failures = 0, disabled_reason = NULL WHERE id = $1`, [id, encryptSecret(secret, secretKey())]);
    return secret;
  },

  async deliveries(userId: string, id: string): Promise<Array<{ id: string; eventId: string; eventType: string; status: string; attempts: number; lastStatus: number | null; lastError: string | null; createdAt: string; deliveredAt: string | null }> | null> {
    if (!(await this.manageable(userId, id))) return null;
    const { rows } = await pool.query<{ id: string; event_id: string; event_type: string; status: string; attempts: number; last_status: number | null; last_error: string | null; created_at: string; delivered_at: string | null }>(
      `SELECT id, event_id, event_type, status, attempts, last_status, last_error, created_at, delivered_at FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [id],
    );
    return rows.map((r) => ({ id: r.id, eventId: r.event_id, eventType: r.event_type, status: r.status, attempts: r.attempts, lastStatus: r.last_status, lastError: r.last_error, createdAt: r.created_at, deliveredAt: r.delivered_at }));
  },

  /** Queues a `webhook.test` event to just this endpoint, so a developer can check their receiver. */
  async sendTest(userId: string, id: string): Promise<boolean> {
    if (!(await this.manageable(userId, id))) return false;
    await queue([id], 'webhook.test', { message: 'This is a test event from Desk.' });
    return true;
  },
};

// ── emitting and delivering ─────────────────────────────────────────────────────────────────────────────────────────
async function queue(endpointIds: string[], type: WebhookEvent, data: Record<string, unknown>): Promise<void> {
  const eventId = `evt_${randomBytes(12).toString('hex')}`;
  const payload = JSON.stringify({ id: eventId, type, createdAt: new Date().toISOString(), data });
  for (const endpointId of endpointIds) {
    await pool.query(
      `INSERT INTO webhook_deliveries (id, endpoint_id, event_id, event_type, payload, next_attempt_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), endpointId, eventId, type, payload, new Date().toISOString()],
    );
  }
}

/** Tells every listening endpoint of the person (or team) about an event. Never throws and never waits for delivery. */
export function emitWebhookEvent(target: { userId?: string; teamId?: string }, type: WebhookEvent, data: Record<string, unknown>): void {
  void (async () => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM webhook_endpoints WHERE active AND $3 = ANY(events)
         AND ((owner_user_id = $1 AND team_id IS NULL) OR team_id = $2)`,
      [target.userId ?? null, target.teamId ?? null, type],
    );
    if (rows.length) await queue(rows.map((r) => r.id), type, data);
  })().catch(() => {});
}

export type Sender = (url: URL, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number }>;
const realSender: Sender = async (url, init) => {
  const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(5000) });
  void res.body?.cancel().catch(() => {}); // the reply is never read
  return { status: res.status };
};

/**
 * Delivers what is due. Returns how many attempts were made. Safe to run on several instances at once (rows are locked).
 * A few deliveries are made at the same time, so one receiver that never answers (each try waits up to 5 seconds) cannot hold up
 * everyone else's events behind it.
 */
export async function processDueDeliveries(send: Sender = realSender, resolve?: (host: string) => Promise<string[]>): Promise<number> {
  let attempts = 0;
  let budget = MAX_DELIVERIES_PER_RUN;
  const worker = async () => {
    while (budget > 0) {
      budget--;
      if (!(await deliverOne(send, resolve))) return;
      attempts++;
    }
  };
  await Promise.all(Array.from({ length: DELIVERY_WORKERS }, worker));
  return attempts;
}

const MAX_DELIVERIES_PER_RUN = 50;
const DELIVERY_WORKERS = 3; // each holds a database connection while it waits for the receiver, so not more than a third of the pool (10)

/** Claims one due delivery (locking its row), makes the attempt and records the result. False when nothing is due. */
async function deliverOne(send: Sender, resolve?: (host: string) => Promise<string[]>): Promise<boolean> {
  {
    const client = await pool.connect();
    let row: { id: string; endpoint_id: string; event_type: string; payload: string; attempts: number; secret_enc: string; url: string; active: boolean } | undefined;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<NonNullable<typeof row>>(
        `SELECT d.id, d.endpoint_id, d.event_type, d.payload, d.attempts, e.secret_enc, e.url, e.active
           FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
          WHERE d.status = 'pending' AND d.next_attempt_at <= $1
          ORDER BY d.next_attempt_at LIMIT 1 FOR UPDATE OF d SKIP LOCKED`,
        [new Date().toISOString()],
      );
      row = rows[0];
      if (!row) { await client.query('COMMIT'); return false; }
      let status = 0;
      let error: string | null = null;
      if (!row.active) error = 'endpoint disabled';
      else {
        try {
          const url = await assertSafeWebhookUrl(row.url, resolve);
          const secret = decryptSecret(row.secret_enc, [config.gatewayKeyEncryptionSecret ?? '', ...config.gatewayKeyEncryptionSecretsPrevious]);
          const t = Math.floor(Date.now() / 1000);
          const res = await send(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Desk-Webhooks/1', 'desk-event': row.event_type, 'desk-delivery': row.id, 'desk-signature': signPayload(secret, t, row.payload) }, body: row.payload });
          status = res.status;
          if (status < 200 || status >= 300) error = `receiver answered ${status}`;
        } catch (err) {
          error = err instanceof Error ? err.message.slice(0, 200) : 'delivery failed';
        }
      }
      const done = error === null;
      const nextAttempt = row.attempts + 1;
      if (done) {
        await client.query(`UPDATE webhook_deliveries SET status = 'delivered', attempts = $2, last_status = $3, last_error = NULL, delivered_at = $4, next_attempt_at = NULL WHERE id = $1`, [row.id, nextAttempt, status || null, new Date().toISOString()]);
        await client.query(`UPDATE webhook_endpoints SET consecutive_failures = 0 WHERE id = $1`, [row.endpoint_id]);
      } else if (nextAttempt >= BACKOFF_SECONDS.length + 1 || !row.active) {
        await client.query(`UPDATE webhook_deliveries SET status = 'failed', attempts = $2, last_status = $3, last_error = $4, next_attempt_at = NULL WHERE id = $1`, [row.id, nextAttempt, status || null, error]);
        if (row.active) {
          await client.query(
            `UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1,
               active = (consecutive_failures + 1) < $2,
               disabled_reason = CASE WHEN (consecutive_failures + 1) >= $2 THEN 'Switched off after repeated failed deliveries. Rotate the secret to turn it back on.' ELSE disabled_reason END
             WHERE id = $1`,
            [row.endpoint_id, DISABLE_AFTER_FAILED_DELIVERIES],
          );
        }
      } else {
        await client.query(`UPDATE webhook_deliveries SET attempts = $2, last_status = $3, last_error = $4, next_attempt_at = $5 WHERE id = $1`, [row.id, nextAttempt, status || null, error, new Date(Date.now() + BACKOFF_SECONDS[nextAttempt - 1] * 1000).toISOString()]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return true;
}

/** Old delivery records are removed after 30 days. */
export async function deleteOldDeliveries(): Promise<number> {
  const res = await pool.query(`DELETE FROM webhook_deliveries WHERE created_at < $1 AND status <> 'pending'`, [new Date(Date.now() - 30 * 86_400_000).toISOString()]);
  return res.rowCount ?? 0;
}
