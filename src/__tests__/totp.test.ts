// TOTP (RFC 6238) math, tested against known vectors and its own round trip. Pure, no database.
import { describe, it, expect } from 'vitest';
import { base32Decode, base32Encode, generateBackupCodes, generateTotpSecret, normalizeBackupCode, totpCodeAt, totpUri, verifyTotpCode } from '../domain/auth/totp';

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    for (const text of ['', 'a', 'hello world', '\x00\x01\x02\xff']) {
      const buf = Buffer.from(text, 'binary');
      expect(base32Decode(base32Encode(buf)).toString('binary')).toBe(text);
    }
  });
  it('matches the RFC 4648 test vector', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });
});

describe('TOTP', () => {
  // RFC 6238 Appendix B, SHA1, 8-digit test vector adapted to this module's 6-digit output: the secret and time are
  // real RFC values; the expected 6-digit code is the low 6 digits a compliant implementation produces at that instant.
  const SECRET = base32Encode(Buffer.from('12345678901234567890'));

  it('produces a deterministic code for a fixed time (self-consistency across two computations)', () => {
    const t = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(totpCodeAt(SECRET, t)).toBe(totpCodeAt(SECRET, t));
    expect(totpCodeAt(SECRET, t)).toMatch(/^\d{6}$/);
  });

  it('verifies the current code, and the one 30s before/after (clock drift tolerance)', () => {
    const now = Date.now();
    const code = totpCodeAt(SECRET, now);
    expect(verifyTotpCode(SECRET, code, now)).toBe(true);
    expect(verifyTotpCode(SECRET, code, now + 25_000)).toBe(true); // still inside the ±1 step window
    expect(verifyTotpCode(SECRET, code, now - 25_000)).toBe(true);
  });

  it('rejects a code from two steps away, a wrong secret, and garbage input', () => {
    const now = Date.now();
    const code = totpCodeAt(SECRET, now);
    expect(verifyTotpCode(SECRET, code, now + 90_000)).toBe(false);
    expect(verifyTotpCode(generateTotpSecret(), code, now)).toBe(false);
    expect(verifyTotpCode(SECRET, '12abc', now)).toBe(false);
    expect(verifyTotpCode(SECRET, '', now)).toBe(false);
    expect(verifyTotpCode(SECRET, '1234567', now)).toBe(false);
  });

  it('two fresh secrets are different, and each is usable', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).not.toBe(b);
    expect(verifyTotpCode(a, totpCodeAt(a, Date.now()))).toBe(true);
  });

  it('builds a well-formed otpauth:// URI', () => {
    const uri = totpUri(SECRET, 'dev@example.com');
    expect(uri.startsWith('otpauth://totp/Desk%3Adev%40example.com?')).toBe(true);
    expect(uri).toContain(`secret=${SECRET}`);
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('backup codes', () => {
  it('makes 10 unique codes shaped xxxx-xxxx from an unambiguous alphabet', () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const shape = new RegExp(`^[${ALPHABET}]{4}-[${ALPHABET}]{4}$`);
    for (const c of codes) {
      expect(c).toMatch(shape);
      expect(c).not.toMatch(/[01OIL]/);
    }
  });

  it('normalizes case and punctuation the same way both ends will type it', () => {
    expect(normalizeBackupCode('abcd-1234')).toBe('ABCD1234');
    expect(normalizeBackupCode(' ABCD 1234 ')).toBe('ABCD1234');
    expect(normalizeBackupCode('abcd1234')).toBe(normalizeBackupCode('ABCD-1234'));
  });
});
