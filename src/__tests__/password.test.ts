import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../domain/auth/password.js';

describe('hashPassword', () => {
  it('produces a PBKDF2 formatted hash', async () => {
    const hash = await hashPassword('secret123');
    const parts = hash.split(':');
    expect(parts[0]).toBe('pbkdf2');
    expect(parts[1]).toBe('sha256');
    expect(parts[2]).toBe('100000');
    expect(parts).toHaveLength(5);
  });

  it('produces different hashes for the same password (salted)', async () => {
    const h1 = await hashPassword('same');
    const h2 = await hashPassword('same');
    expect(h1).not.toBe(h2);
  });
});

describe('verifyPassword', () => {
  it('returns true for correct password', async () => {
    const hash = await hashPassword('correct-horse');
    expect(await verifyPassword('correct-horse', hash)).toBe(true);
  });

  it('returns false for wrong password', async () => {
    const hash = await hashPassword('correct-horse');
    expect(await verifyPassword('wrong-horse', hash)).toBe(false);
  });

  it('returns false for malformed hash', async () => {
    expect(await verifyPassword('anything', 'not:a:valid:hash')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
    expect(await verifyPassword('anything', 'bcrypt:$2b$10$...')).toBe(false);
  });

  it('returns false for dummy hash used in timing-safe path', async () => {
    const dummy = 'pbkdf2:sha256:100000:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    expect(await verifyPassword('anypassword', dummy)).toBe(false);
  });
});
