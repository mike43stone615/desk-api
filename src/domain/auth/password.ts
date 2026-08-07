// Password hashing — ported from the original WebCrypto-based version (see
// git history) to Node's native `crypto.pbkdf2`, matching the convention
// registry-api/market-validation-api settled on when they ported this same
// file FROM this one (see their src/domain/auth/password.ts headers — they
// call out that desk-api is the original source of this design). The stored
// format is unchanged and self-describes its iteration count so a bump here
// never breaks previously-hashed passwords:
//   pbkdf2:sha256:<iterations>:<saltB64>:<hashB64>
//
// Deviation from the original: iterations bumped from 100,000 to 310,000
// (OWASP's current recommendation for PBKDF2-HMAC-SHA256), per this
// rewrite's explicit instructions. Because the format is self-describing,
// verifyPassword reads the iteration count from each stored hash rather than
// assuming the current constant, so existing 100k-iteration hashes (once
// real user data is migrated — a separate later step, not part of this
// rewrite) keep verifying correctly; only newly-created/updated hashes use
// 310k.
import { randomBytes, pbkdf2 as pbkdf2Callback, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const pbkdf2 = promisify(pbkdf2Callback);

const ITERATIONS = 310_000;
const KEY_LENGTH_BYTES = 32; // 256 bits
const DIGEST = 'sha256';
const PREFIX = 'pbkdf2:sha256';

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await pbkdf2(password, salt, ITERATIONS, KEY_LENGTH_BYTES, DIGEST);
  return `${PREFIX}:${ITERATIONS}:${salt.toString('base64')}:${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;

  const iterations = parseInt(parts[2], 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[3], 'base64');
    expected = Buffer.from(parts[4], 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await pbkdf2(password, salt, iterations, expected.length, DIGEST);
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
