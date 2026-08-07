import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './password';

describe('hashPassword / verifyPassword', () => {
  it('produces a self-describing pbkdf2:sha256:<iterations>:<salt>:<hash> format at 310,000 iterations', async () => {
    const hash = await hashPassword('correct horse battery staple');
    const parts = hash.split(':');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('pbkdf2');
    expect(parts[1]).toBe('sha256');
    expect(parts[2]).toBe('310000');
  });

  it('verifies a correct password and rejects an incorrect one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });

  it('verifies against a lower iteration count stored in an older hash (format is self-describing)', async () => {
    // Simulates a hash written before the 100k -> 310k bump (see
    // password.ts's header comment) — verification must still succeed by
    // reading the iteration count out of the stored hash, not assuming the
    // current constant.
    const crypto = await import('crypto');
    const { promisify } = await import('util');
    const pbkdf2 = promisify(crypto.pbkdf2);
    const salt = Buffer.from('0123456789abcdef');
    const derived = (await pbkdf2('legacy-password', salt, 100_000, 32, 'sha256')) as Buffer;
    const legacyHash = `pbkdf2:sha256:100000:${salt.toString('base64')}:${derived.toString('base64')}`;

    expect(await verifyPassword('legacy-password', legacyHash)).toBe(true);
    expect(await verifyPassword('wrong', legacyHash)).toBe(false);
  });

  it('rejects malformed stored hashes without throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-real-hash')).toBe(false);
    expect(await verifyPassword('anything', 'pbkdf2:sha1:1000:abc:def')).toBe(false);
    expect(await verifyPassword('anything', 'pbkdf2:sha256:notanumber:abc:def')).toBe(false);
  });

  it('produces a different salt (and hash) on every call for the same password', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
  });
});
