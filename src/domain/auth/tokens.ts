// Ported unchanged in behavior from the WebCrypto version — generateToken/
// generateId now use Node's `crypto.randomBytes` instead of
// `crypto.getRandomValues`, everything else (ISO-8601 string timestamps,
// hex token/id encoding) is identical.
import { randomBytes } from 'crypto';

export function generateToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('hex');
}

export function generateId(): string {
  return generateToken(16);
}

export function nowUtc(): string {
  return new Date().toISOString();
}

export function addHours(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

export function addMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function isExpired(expiresAt: string): boolean {
  return new Date(expiresAt) <= new Date();
}

export function secondsSince(isoTimestamp: string): number {
  return (Date.now() - new Date(isoTimestamp).getTime()) / 1000;
}
