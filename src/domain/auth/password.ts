const ITERATIONS = 100_000;
const KEY_LENGTH_BITS = 256;
const ALGO = 'PBKDF2';
const HASH = 'SHA-256';
const PREFIX = 'pbkdf2:sha256';

export async function hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), ALGO, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: ALGO, salt: salt.buffer as ArrayBuffer, iterations: ITERATIONS, hash: HASH },
    keyMaterial,
    KEY_LENGTH_BITS,
  );
  return `${PREFIX}:${ITERATIONS}:${b64(salt)}:${b64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;
  const iterations = parseInt(parts[2], 10);
  const salt = fromB64(parts[3]);
  const expected = fromB64(parts[4]);
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), ALGO, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: ALGO, salt: salt.buffer as ArrayBuffer, iterations, hash: HASH },
    keyMaterial,
    KEY_LENGTH_BITS,
  );
  return constantTimeEqual(new Uint8Array(bits), expected);
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
