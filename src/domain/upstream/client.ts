// The one way desk-api calls the backends (registry-api, market-validation-api, compliance-os). It exists so that a
// slow, failing or hostile backend can hurt one request at most, never the whole service:
//  - a circuit breaker per backend: after a run of failures calls are refused instantly for a few seconds instead of
//    every caller waiting out a timeout, then one trial call decides whether to reopen;
//  - one quick retry, only for calls that are safe to repeat (lookups), only for a network error or 502/503/504;
//  - a ceiling on how many calls can be in flight at once, per backend and per caller (API key), so one caller
//    cannot occupy every slot and a hung backend cannot pile up unbounded work;
//  - a ceiling on how big an answer we will read, so a backend cannot make this process buffer gigabytes.
import { HttpError } from '../../middleware/http-error';
import { upstreamCallsTotal } from '../../modules/metrics';

export interface UpstreamPolicy {
  /** Name used for the breaker, the limits and the metrics. */
  service: string;
  timeoutMs: number;
  maxResponseBytes: number;
  /** Safe to send twice (a lookup). Never set for something that costs money or changes data. */
  retryable: boolean;
  maxInFlight: number;
  /** Per caller (the `holder`); undefined = no per-caller limit. */
  maxInFlightPerHolder?: number;
}

export interface UpstreamResult {
  status: number;
  headers: Headers;
  text: string;
}

export class UpstreamError extends HttpError {
  constructor(
    status: number,
    message: string,
    readonly retryAfterSeconds?: number,
    code?: string,
  ) {
    super(status, message, code);
    this.name = 'UpstreamError';
  }
}

const BREAKER_FAILURES = 5;
const BREAKER_OPEN_MS = 15_000;
const RETRY_DELAY_MS = [150, 350];

interface Breaker {
  failures: number;
  openUntil: number;
  trialInFlight: boolean;
}
const breakers = new Map<string, Breaker>();
const inFlight = new Map<string, number>();

/** For tests. */
export function resetUpstreamState(): void {
  breakers.clear();
  inFlight.clear();
}

export function breakerState(service: string, now = Date.now()): 'closed' | 'open' | 'half-open' {
  const b = breakers.get(service);
  if (!b || b.openUntil === 0) return 'closed';
  return now < b.openUntil ? 'open' : 'half-open';
}

function isFailureStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

function recordSuccess(service: string): void {
  breakers.set(service, { failures: 0, openUntil: 0, trialInFlight: false });
}

function recordFailure(service: string, now: number): void {
  const b = breakers.get(service) ?? { failures: 0, openUntil: 0, trialInFlight: false };
  b.failures += 1;
  b.trialInFlight = false;
  if (b.failures >= BREAKER_FAILURES) b.openUntil = now + BREAKER_OPEN_MS;
  breakers.set(service, b);
}

/** Reads an answer up to the ceiling; refuses (and stops reading) anything larger. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new UpstreamError(502, 'The upstream API sent an answer that was too large.', undefined, 'upstream_response_too_large');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new UpstreamError(502, 'The upstream API sent an answer that was too large.', undefined, 'upstream_response_too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function acquire(policy: UpstreamPolicy, holder: string | undefined): () => void {
  const serviceKey = `svc:${policy.service}`;
  const holderKey = holder ? `holder:${policy.service}:${holder}` : undefined;
  if ((inFlight.get(serviceKey) ?? 0) >= policy.maxInFlight) {
    upstreamCallsTotal.inc({ service: policy.service, outcome: 'overloaded' });
    throw new UpstreamError(503, 'This API is busy right now. Please try again in a moment.', 2, 'service_busy');
  }
  if (holderKey && policy.maxInFlightPerHolder && (inFlight.get(holderKey) ?? 0) >= policy.maxInFlightPerHolder) {
    upstreamCallsTotal.inc({ service: policy.service, outcome: 'caller_limited' });
    throw new UpstreamError(429, 'Too many of your requests are already in progress. Wait for one to finish.', 1, 'too_many_in_flight');
  }
  inFlight.set(serviceKey, (inFlight.get(serviceKey) ?? 0) + 1);
  if (holderKey) inFlight.set(holderKey, (inFlight.get(holderKey) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight.set(serviceKey, (inFlight.get(serviceKey) ?? 1) - 1);
    if (holderKey) inFlight.set(holderKey, (inFlight.get(holderKey) ?? 1) - 1);
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A signal that fires when the person who made this request goes away (closes the tab, times out) before we have
 * answered, so the call to the backend is dropped instead of running to completion for nobody.
 */
export function abortWhenClientLeaves(reply: { raw: { once: (e: 'close', f: () => void) => unknown; writableFinished: boolean } }): AbortSignal {
  const controller = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}

export async function callUpstream(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  policy: UpstreamPolicy,
  holder?: string,
): Promise<UpstreamResult> {
  const now = Date.now();
  const state = breakerState(policy.service, now);
  if (state === 'open') {
    upstreamCallsTotal.inc({ service: policy.service, outcome: 'circuit_open' });
    throw new UpstreamError(503, 'This API is temporarily unavailable. Please try again shortly.', Math.ceil(BREAKER_OPEN_MS / 1000), 'upstream_unavailable');
  }

  const release = acquire(policy, holder);
  if (state === 'half-open') {
    const b = breakers.get(policy.service)!;
    if (b.trialInFlight) {
      release();
      upstreamCallsTotal.inc({ service: policy.service, outcome: 'circuit_open' });
      throw new UpstreamError(503, 'This API is temporarily unavailable. Please try again shortly.', 5, 'upstream_unavailable');
    }
    b.trialInFlight = true; // exactly one call tests whether the backend is back
  }
  try {
    const attempts = policy.retryable ? 2 : 1;
    let lastError: UpstreamError | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const timeout = AbortSignal.timeout(policy.timeoutMs);
        const res = await fetch(url, { ...init, signal: init.signal ? AbortSignal.any([timeout, init.signal]) : timeout });
        if (isFailureStatus(res.status)) {
          const text = await readCapped(res, policy.maxResponseBytes).catch(() => '');
          if (attempt < attempts && res.status !== 500) {
            upstreamCallsTotal.inc({ service: policy.service, outcome: 'retried' });
            await sleep(RETRY_DELAY_MS[attempt - 1] ?? 300);
            continue;
          }
          recordFailure(policy.service, Date.now());
          upstreamCallsTotal.inc({ service: policy.service, outcome: 'error' });
          return { status: res.status, headers: res.headers, text };
        }
        const text = await readCapped(res, policy.maxResponseBytes);
        recordSuccess(policy.service);
        upstreamCallsTotal.inc({ service: policy.service, outcome: 'ok' });
        return { status: res.status, headers: res.headers, text };
      } catch (err) {
        if (init.signal?.aborted) {
          // The caller left. That says nothing about the backend's health: no retry, no failure recorded.
          upstreamCallsTotal.inc({ service: policy.service, outcome: 'client_cancelled' });
          const b = breakers.get(policy.service);
          if (b) b.trialInFlight = false;
          throw new UpstreamError(499, 'The caller closed the connection.', undefined, 'client_closed');
        }
        if (err instanceof UpstreamError) {
          // A too-large answer is the backend misbehaving, but repeating the call will not help.
          upstreamCallsTotal.inc({ service: policy.service, outcome: 'too_large' });
          recordFailure(policy.service, Date.now());
          throw err;
        }
        lastError = new UpstreamError(502, 'The upstream API could not be reached.', undefined, 'upstream_unreachable');
        if (attempt < attempts) {
          upstreamCallsTotal.inc({ service: policy.service, outcome: 'retried' });
          await sleep(RETRY_DELAY_MS[attempt - 1] ?? 300);
          continue;
        }
        recordFailure(policy.service, Date.now());
        upstreamCallsTotal.inc({ service: policy.service, outcome: 'error' });
      }
    }
    throw lastError ?? new UpstreamError(502, 'The upstream API could not be reached.', undefined, 'upstream_unreachable');
  } finally {
    release();
  }
}
