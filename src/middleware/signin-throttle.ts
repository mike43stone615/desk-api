// Slows down password guessing. Three counters are kept, each over the same window (15 minutes by default):
//   - this address trying this account   (5 failures)  -> stops one attacker working on one account
//   - this account from anywhere         (30 failures) -> stops guessing spread over many addresses
//   - this address trying any account    (30 failures) -> stops one address spraying many accounts
// While any counter is over its limit, a sign-in attempt is refused with 429 BEFORE the password is even checked, so
// the correct password does not get through either. Attempts for accounts that do not exist count the same way, so the
// answer never reveals whether an email is registered. A correct password clears only the address-plus-account
// counter, and a valid password on an unconfirmed account is not a failure.
//
// Counters live in Redis when it is available (shared and survives a restart) and in memory otherwise.
import { createHash } from 'crypto';
import { getRedis } from './redis-client';
import { config } from '../config';

interface MemoryCounter {
  count: number;
  resetAt: number;
}
const memory = new Map<string, MemoryCounter>();

const windowMs = () => config.signinLockoutMinutes * 60_000;

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);

function keys(ip: string, email: string) {
  const account = digest(email.trim().toLowerCase().slice(0, 254));
  return {
    pair: { key: `signin:pair:${digest(ip)}:${account}`, limit: config.signinMaxFailuresAccountIp },
    account: { key: `signin:acct:${account}`, limit: config.signinMaxFailuresAccount },
    address: { key: `signin:ip:${digest(ip)}`, limit: config.signinMaxFailuresIp },
  };
}

async function read(key: string): Promise<{ count: number; ttlMs: number }> {
  const redis = getRedis();
  if (redis) {
    try {
      const [count, ttl] = await Promise.all([redis.get(key), redis.pttl(key)]);
      return { count: Number(count ?? 0), ttlMs: Math.max(0, ttl) };
    } catch {
      /* fall through to memory */
    }
  }
  const entry = memory.get(key);
  if (!entry || entry.resetAt <= Date.now()) return { count: 0, ttlMs: 0 };
  return { count: entry.count, ttlMs: entry.resetAt - Date.now() };
}

async function bump(key: string): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.pexpire(key, windowMs());
      return;
    } catch {
      /* fall through to memory */
    }
  }
  const now = Date.now();
  // Opportunistic prune so the map cannot grow without bound.
  if (memory.size > 5000) for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
  const entry = memory.get(key);
  if (!entry || entry.resetAt <= now) memory.set(key, { count: 1, resetAt: now + windowMs() });
  else entry.count += 1;
}

async function drop(key: string): Promise<void> {
  memory.delete(key);
  const redis = getRedis();
  if (redis) await redis.del(key).catch(() => {});
}

/** Seconds until this attempt may be made, or 0 when it is allowed. */
export async function signinLockedSeconds(ip: string, email: string): Promise<number> {
  const k = keys(ip, email);
  let wait = 0;
  for (const c of [k.pair, k.account, k.address]) {
    const { count, ttlMs } = await read(c.key);
    if (count >= c.limit) wait = Math.max(wait, Math.ceil(ttlMs / 1000));
  }
  return wait;
}

export async function recordSigninFailure(ip: string, email: string): Promise<void> {
  const k = keys(ip, email);
  await Promise.all([bump(k.pair.key), bump(k.account.key), bump(k.address.key)]);
}

export async function clearSigninFailures(ip: string, email: string): Promise<void> {
  await drop(keys(ip, email).pair.key);
}

/** For tests. */
export function resetSigninThrottleForTests(): void {
  memory.clear();
}
