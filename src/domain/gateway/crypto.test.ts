import { describe, it, expect } from 'vitest';
import { decryptSecret, encryptSecret } from './crypto';

const KEY_A = 'ab'.repeat(32);
const KEY_B = 'cd'.repeat(32);

describe('gateway secret encryption (AES-256-GCM)', () => {
  it('round-trips a secret', () => {
    const blob = encryptSecret('regapi_supersecret', KEY_A);
    expect(decryptSecret(blob, KEY_A)).toBe('regapi_supersecret');
  });

  it('never contains the plaintext, and uses a fresh IV each time', () => {
    const a = encryptSecret('regapi_supersecret', KEY_A);
    const b = encryptSecret('regapi_supersecret', KEY_A);
    expect(a.startsWith('v1:')).toBe(true);
    expect(a).not.toContain('regapi_supersecret');
    expect(a).not.toBe(b);
  });

  it('refuses to decrypt with the wrong key', () => {
    const blob = encryptSecret('regapi_supersecret', KEY_A);
    expect(() => decryptSecret(blob, KEY_B)).toThrow();
  });

  it('detects tampering with the ciphertext', () => {
    const [v, iv, tag, ct] = encryptSecret('regapi_supersecret', KEY_A).split(':');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 0xff;
    expect(() => decryptSecret([v, iv, tag, flipped.toString('base64')].join(':'), KEY_A)).toThrow();
  });

  it('rejects an unknown format/version and a malformed secret', () => {
    expect(() => decryptSecret('v2:a:b:c', KEY_A)).toThrow(/format/);
    expect(() => decryptSecret('garbage', KEY_A)).toThrow(/format/);
    expect(() => encryptSecret('x', 'not-hex')).toThrow(/64 hex/);
  });
});
