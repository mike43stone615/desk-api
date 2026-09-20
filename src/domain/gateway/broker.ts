// Mints and revokes the per-developer keys behind registry_api /
// market_validation_api grants, by calling each backend's existing admin
// key endpoints (POST /admin/api-keys, DELETE /admin/api-keys/:id — both
// services expose the identical shape). Every grant gets its OWN real backend
// key, so each backend's existing per-key rate limiting and revocation apply
// per developer with no changes to either service.
//
// Server-to-server only: URLs are the loopback addresses already in config
// (REGISTRY_API_URL / MARKET_API_URL), and the admin keys never leave this
// process.
import { config } from '../../config';
import type { BrokeredService } from './services';

const TIMEOUT_MS = 10_000;

export class BrokerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'BrokerError';
  }
}

export interface ProvisionedKey {
  backendKeyId: string;
  /** The real backend key. Callers must encrypt it before storing. */
  plaintext: string;
}

function upstream(service: BrokeredService): { baseUrl: string; adminKey: string } {
  const baseUrl = service === 'registry_api' ? config.registryApiUrl : config.marketApiUrl;
  const adminKey = service === 'registry_api' ? config.registryApiAdminKey : config.marketApiAdminKey;
  if (!baseUrl || !adminKey) throw new BrokerError(`${service} is not configured.`);
  return { baseUrl: baseUrl.replace(/\/+$/, ''), adminKey };
}

export async function provisionBrokerKey(service: BrokeredService, label: string): Promise<ProvisionedKey> {
  const { baseUrl, adminKey } = upstream(service);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/admin/api-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': adminKey },
      body: JSON.stringify({ label }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new BrokerError(`Could not reach ${service}.`);
  }
  if (res.status !== 201) throw new BrokerError(`${service} refused to issue a key.`, res.status);
  const body = (await res.json().catch(() => null)) as { apiKey?: { id?: unknown; key?: unknown } } | null;
  const id = body?.apiKey?.id;
  const key = body?.apiKey?.key;
  if (typeof id !== 'string' || typeof key !== 'string' || !key) {
    throw new BrokerError(`${service} returned an unexpected response.`);
  }
  return { backendKeyId: id, plaintext: key };
}

export interface UpstreamKey {
  id: string;
  label: string;
  /** When the backend created it (ms since the epoch). */
  createdAtMs: number;
}

/** Every ACTIVE key the backend has (revoked ones are not listed), so callers can compare against what we hold. */
export async function listBrokerKeys(service: BrokeredService): Promise<UpstreamKey[]> {
  const { baseUrl, adminKey } = upstream(service);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/admin/api-keys`, {
      headers: { 'x-api-key': adminKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new BrokerError(`Could not reach ${service}.`);
  }
  if (res.status !== 200) throw new BrokerError(`${service} refused to list keys.`, res.status);
  const body = (await res.json().catch(() => null)) as { apiKeys?: unknown } | null;
  if (!body || !Array.isArray(body.apiKeys)) throw new BrokerError(`${service} returned an unexpected response.`);
  const keys: UpstreamKey[] = [];
  for (const k of body.apiKeys as Array<Record<string, unknown>>) {
    if (typeof k.id !== 'string' || typeof k.label !== 'string') continue;
    const created = typeof k.createdAt === 'string' ? Date.parse(k.createdAt) : NaN;
    keys.push({ id: k.id, label: k.label, createdAtMs: Number.isFinite(created) ? created : Date.now() });
  }
  return keys;
}

/** 404 (already gone) and 409 (already revoked) both count as success. */
export async function revokeBrokerKey(service: BrokeredService, backendKeyId: string): Promise<void> {
  const { baseUrl, adminKey } = upstream(service);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/admin/api-keys/${encodeURIComponent(backendKeyId)}`, {
      method: 'DELETE',
      headers: { 'x-api-key': adminKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new BrokerError(`Could not reach ${service}.`);
  }
  if (res.status === 204 || res.status === 404 || res.status === 409) return;
  throw new BrokerError(`${service} failed to revoke a key.`, res.status);
}
