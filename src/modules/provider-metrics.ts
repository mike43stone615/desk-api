// Outside providers (OpenAI, Google Places, Resend) fail in ways that are easy to miss: a key is revoked, a daily quota runs
// out, and the feature quietly falls back to something worse. Every call is counted by outcome so that shows up in /metrics
// and the uptime watch can alert on it (scripts/uptime-targets.json, "counters").
import { providerCallsTotal } from './metrics';

export type ProviderOutcome = 'ok' | 'auth_error' | 'quota' | 'error';

/** The outcome of an HTTP status from a provider. */
export function outcomeForStatus(status: number): ProviderOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'auth_error';
  if (status === 429) return 'quota';
  return 'error';
}

export function recordProviderCall(provider: 'openai' | 'google_places' | 'resend', outcome: ProviderOutcome): void {
  providerCallsTotal.inc({ provider, outcome });
}
