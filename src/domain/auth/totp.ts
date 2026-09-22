// TOTP (RFC 6238, on top of HOTP / RFC 4226): the standard behind every authenticator app (Google Authenticator, Authy,
// 1Password, etc). Pure functions only — no database, no encryption, no randomness beyond generating a fresh secret —
// so this is trivial to test and has nothing to do with how the secret is stored (see domain/auth/twoFactor.ts for that).
import { createHmac, randomBytes } from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh random secret (160 bits, the size every authenticator app expects), base32-encoded for display/scanning. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function totpCodeAt(base32Secret: string, timeMs: number): string {
  return hotp(base32Decode(base32Secret), Math.floor(timeMs / 1000 / STEP_SECONDS));
}

/**
 * Checks a 6-digit code against one step before/after now (±30s), so a slightly slow clock (on either side) still
 * works — the same tolerance every authenticator app assumes a server will have.
 */
export function verifyTotpCode(base32Secret: string, code: string, nowMs: number = Date.now()): boolean {
  const clean = code.trim();
  if (!/^\d{6}$/.test(clean)) return false;
  const secret = base32Decode(base32Secret);
  const step = Math.floor(nowMs / 1000 / STEP_SECONDS);
  for (const delta of [0, -1, 1]) {
    if (hotp(secret, step + delta) === clean) return true;
  }
  return false;
}

/** otpauth://... URI an authenticator app can be pointed at directly (or the secret entered by hand). */
export function totpUri(base32Secret: string, accountEmail: string, issuer = 'Desk'): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  return `otpauth://totp/${label}?secret=${base32Secret}&issuer=${encodeURIComponent(issuer)}&digits=${DIGITS}&period=${STEP_SECONDS}&algorithm=SHA1`;
}

/** 10 backup codes (xxxx-xxxx, unambiguous alphabet: no 0/O/1/I/L), each usable once in place of a TOTP code. */
export function generateBackupCodes(count = 10): string[] {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(8);
    let s = '';
    for (const b of bytes) s += alphabet[b % alphabet.length];
    codes.push(`${s.slice(0, 4)}-${s.slice(4, 8)}`);
  }
  return codes;
}

export function normalizeBackupCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}
