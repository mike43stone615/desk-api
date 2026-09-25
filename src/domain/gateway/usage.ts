// What each API key has been used for: one row per key per day (migration 0017). A developer sees their own numbers
// (GET /gateway/api-keys/:id/usage); nothing here is per-caller detail, only counts.
import { pool } from '../../db';
import { gatewayCallsTotal } from '../../modules/metrics';
import { KEY_IDLE_DAYS } from './keys';

const today = () => new Date().toISOString().slice(0, 10);

/** Counts one call made with a key. Fire-and-forget: counting must never slow down or break the call itself. */
export function recordKeyUsage(keyId: string, service: string, status: number): void {
  const outcome = status === 429 ? 'rate_limited' : status >= 500 ? 'server_error' : status >= 400 ? 'client_error' : 'ok';
  gatewayCallsTotal.inc({ service, outcome });
  Promise.resolve(
    pool.query(
      `INSERT INTO gateway_key_usage (api_key_id, day, calls, errors) VALUES ($1, $2, 1, $3)
       ON CONFLICT (api_key_id, day) DO UPDATE SET calls = gateway_key_usage.calls + 1, errors = gateway_key_usage.errors + $3`,
      [keyId, today(), status >= 400 ? 1 : 0],
    ),
  ).catch(() => {});
}

export interface DailyUsage { day: string; calls: number; errors: number }

/** The last `days` days (newest first) that had any calls. The caller must already have checked the key is theirs. */
export async function keyUsage(keyId: string, days: number): Promise<DailyUsage[]> {
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const { rows } = await pool.query<{ day: string; calls: number; errors: number }>(
    `SELECT day, calls, errors FROM gateway_key_usage WHERE api_key_id = $1 AND day >= $2 ORDER BY day DESC`,
    [keyId, since],
  );
  return rows.map((r) => ({ day: r.day, calls: Number(r.calls), errors: Number(r.errors) }));
}

/** What a developer needs to know about limits, stated in one place (docs/API-LIMITS.md says the same). */
export function limitsFor(perMinuteDeskApi: number): Array<{ service: string; perMinute: number; note: string }> {
  return [
    { service: 'desk_api', perMinute: perMinuteDeskApi, note: `Each key may make ${perMinuteDeskApi} calls a minute to the Desk API, and every account ${Math.ceil(perMinuteDeskApi * 5)} across all its keys and devices.` },
    { service: 'registry_api', perMinute: 60, note: 'The Business Name Registry API itself allows 60 calls a minute per key; the answers carry X-RateLimit-* headers.' },
    { service: 'market_validation_api', perMinute: 60, note: 'The Market Validation API itself allows 60 calls a minute per key; a market analysis is limited to 2 at once.' },
  ];
}

export const IDLE_DAYS = KEY_IDLE_DAYS;
