import { describe, it, expect } from 'vitest';
import { generateToken, generateId, isExpired, addMinutes, addHours, secondsSince } from './tokens';

describe('generateToken / generateId', () => {
  it('generateToken(32) returns 64 lowercase hex chars', () => {
    const token = generateToken(32);
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]+$/);
  });

  it('generateId returns 32 lowercase hex chars (16 bytes)', () => {
    const id = generateId();
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[0-9a-f]+$/);
  });

  it('produces distinct values across calls', () => {
    expect(generateToken(32)).not.toBe(generateToken(32));
  });
});

describe('isExpired / addMinutes / addHours / secondsSince', () => {
  it('a future timestamp is not expired; a past one is', () => {
    expect(isExpired(addMinutes(10))).toBe(false);
    expect(isExpired(new Date(Date.now() - 1000).toISOString())).toBe(true);
  });

  it('addHours produces a timestamp further out than addMinutes for the same magnitude', () => {
    const inHours = new Date(addHours(1)).getTime();
    const inMinutes = new Date(addMinutes(1)).getTime();
    expect(inHours).toBeGreaterThan(inMinutes);
  });

  it('secondsSince reports roughly elapsed time', () => {
    const past = new Date(Date.now() - 5000).toISOString();
    expect(secondsSince(past)).toBeGreaterThanOrEqual(4);
    expect(secondsSince(past)).toBeLessThan(10);
  });
});
