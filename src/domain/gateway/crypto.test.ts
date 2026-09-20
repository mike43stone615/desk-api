import { describe, it, expect } from 'vitest';
import { createCipheriv, randomBytes } from 'crypto';
import { blobKeyId, decryptSecret, encryptSecret, keyFingerprint } from './crypto';

const KEY_A = 'ab'.repeat(32);
const KEY_B = 'cd'.repeat(32);
const KEY_C = 'ef'.repeat(32);

/** A value exactly as the first release stored it (v1, no key id), so old rows must keep working. */
function legacyV1(plaintext: string, secretHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(secretHex, 'hex'), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

describe('gateway secret encryption (AES-256-GCM)', () => {
  it('round-trips a secret', () => {
    const blob = encryptSecret('regapi_supersecret', KEY_A);
    expect(decryptSecret(blob, KEY_A)).toBe('regapi_supersecret');
  });

  it('never contains the plaintext, and uses a fresh IV each time', () => {
    const a = encryptSecret('regapi_supersecret', KEY_A);
    const b = encryptSecret('regapi_supersecret', KEY_A);
    expect(a.startsWith('v2:')).toBe(true);
    expect(a).not.toContain('regapi_supersecret');
    expect(a).not.toBe(b);
  });

  it('refuses to decrypt with the wrong key', () => {
    const blob = encryptSecret('regapi_supersecret', KEY_A);
    expect(() => decryptSecret(blob, KEY_B)).toThrow();
  });

  it('detects tampering with the ciphertext', () => {
    const [v, kid, iv, tag, ct] = encryptSecret('regapi_supersecret', KEY_A).split(':');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 0xff;
    expect(() => decryptSecret([v, kid, iv, tag, flipped.toString('base64')].join(':'), KEY_A)).toThrow();
  });

  it('rejects an unknown format/version and a malformed secret', () => {
    expect(() => decryptSecret('v3:a:b:c', KEY_A)).toThrow(/format/);
    expect(() => decryptSecret('v2:a:b:c', KEY_A)).toThrow(/format/);
    expect(() => decryptSecret('garbage', KEY_A)).toThrow(/format/);
    expect(() => encryptSecret('x', 'not-hex')).toThrow(/64 hex/);
  });
});

describe('rotating the secret', () => {
  it('a value says which key it needs, without revealing the key', () => {
    const blob = encryptSecret('s', KEY_A);
    expect(blobKeyId(blob)).toBe(keyFingerprint(KEY_A));
    expect(keyFingerprint(KEY_A)).toMatch(/^[0-9a-f]{8}$/);
    expect(keyFingerprint(KEY_A)).not.toBe(keyFingerprint(KEY_B));
    expect(blob).not.toContain(KEY_A);
    expect(blobKeyId(legacyV1('s', KEY_A))).toBeNull();
  });

  it('opens a value with whichever of several known keys it was made with', () => {
    const underA = encryptSecret('regapi_one', KEY_A);
    const underB = encryptSecret('regapi_two', KEY_B);
    expect(decryptSecret(underA, [KEY_B, KEY_A])).toBe('regapi_one');
    expect(decryptSecret(underB, [KEY_B, KEY_A])).toBe('regapi_two');
  });

  it('fails clearly when none of the known keys is the right one', () => {
    const underA = encryptSecret('regapi_one', KEY_A);
    expect(() => decryptSecret(underA, [KEY_B, KEY_C])).toThrow(/None of the configured/);
    expect(() => decryptSecret(underA, [])).toThrow(/None of the configured/);
  });

  it('still reads the original v1 format, trying each known key', () => {
    const old = legacyV1('regapi_legacy', KEY_A);
    expect(decryptSecret(old, KEY_A)).toBe('regapi_legacy');
    expect(decryptSecret(old, [KEY_B, KEY_A])).toBe('regapi_legacy');
    expect(() => decryptSecret(old, [KEY_B, KEY_C])).toThrow();
    expect(() => decryptSecret(old, [])).toThrow();
  });

  it('re-encrypting a value under a new key keeps the plaintext and drops the need for the old key', () => {
    const before = encryptSecret('regapi_keep', KEY_A);
    const after = encryptSecret(decryptSecret(before, [KEY_B, KEY_A]), KEY_B);
    expect(blobKeyId(after)).toBe(keyFingerprint(KEY_B));
    expect(decryptSecret(after, KEY_B)).toBe('regapi_keep');
    expect(() => decryptSecret(after, KEY_A)).toThrow();
  });
});
