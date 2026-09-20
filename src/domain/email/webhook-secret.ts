// The secret that signs the mail provider's webhook calls. It comes from RESEND_WEBHOOK_SECRET when that is set;
// otherwise it is asked from the provider itself (the same API key that sends the mail can read the webhook it
// registered), so no second secret has to be copied into the deployed settings. The answer is kept in memory.
import { config } from '../../config';

const CACHE_MS = 60 * 60 * 1000;
const FAILURE_MS = 60 * 1000;
let cached: { secret: string | undefined; at: number; ttl: number } | null = null;

async function api(path: string): Promise<unknown> {
  const res = await fetch(`https://api.resend.com${path}`, {
    headers: { authorization: `Bearer ${config.resendApiKey}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`the mail provider answered ${res.status}`);
  return res.json();
}

async function lookup(): Promise<string | undefined> {
  const list = (await api('/webhooks')) as { data?: Array<{ id?: string; endpoint?: string; status?: string }> };
  const ours = (list.data ?? []).find((w) => typeof w.endpoint === 'string' && /\/webhooks\/resend$/.test(w.endpoint) && w.status !== 'disabled');
  if (!ours?.id) return undefined;
  const detail = (await api(`/webhooks/${encodeURIComponent(ours.id)}`)) as { signing_secret?: string };
  return typeof detail.signing_secret === 'string' ? detail.signing_secret : undefined;
}

/** True when the secret is set in the settings (so asking the provider again would change nothing). */
export function webhookSecretIsConfigured(): boolean {
  return Boolean(config.resendWebhookSecret);
}

export async function getWebhookSecret(refresh = false): Promise<string | undefined> {
  if (config.resendWebhookSecret) return config.resendWebhookSecret;
  if (!config.resendApiKey) return undefined;
  if (!refresh && cached && Date.now() - cached.at < cached.ttl) return cached.secret;
  try {
    cached = { secret: await lookup(), at: Date.now(), ttl: CACHE_MS };
  } catch {
    cached = { secret: undefined, at: Date.now(), ttl: FAILURE_MS };
  }
  return cached.secret;
}

/** For tests. */
export function resetWebhookSecretCache(): void {
  cached = null;
}
