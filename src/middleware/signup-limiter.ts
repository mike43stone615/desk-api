// Dedicated, low-limit throttle for POST /auth/signup specifically, on top
// of the general per-IP rate limiter in api-protection.ts. That general
// limiter is generous (meant for normal API traffic) and shared across every
// route, so it doesn't meaningfully slow down mass fake-account creation.
// This is intentionally separate and self-contained rather than a new tier
// on the shared limiter, to keep the blast radius of this change small.
//
// Self-pruning on access (not a background interval) so this Map can't grow
// without bound the way the general limiter's memBuckets does.
const SIGNUP_LIMIT = 5;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

export function checkSignupRateLimit(key: string): boolean {
  // Test suites sign up far more than 5 times per run against a shared fake
  // IP — keep them hermetic rather than fighting a limiter meant for real
  // abuse traffic, same as other test-mode carve-outs in this codebase.
  if (process.env.NODE_ENV === 'test') return true;

  const now = Date.now();

  // Opportunistic prune: drop any bucket whose window has already expired,
  // not just the one for this key, so the map can't accumulate entries from
  // one-off IPs indefinitely.
  for (const [k, b] of buckets) {
    if (now - b.windowStart > WINDOW_MS) buckets.delete(k);
  }

  const existing = buckets.get(key);
  if (!existing || now - existing.windowStart > WINDOW_MS) {
    buckets.set(key, { count: 1, windowStart: now });
    return true;
  }

  if (existing.count >= SIGNUP_LIMIT) return false;
  existing.count += 1;
  return true;
}
