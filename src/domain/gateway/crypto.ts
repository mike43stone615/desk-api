// AES-256-GCM for the real backend keys stored behind registry_api /
// market_validation_api grants. Unlike the gateway keys themselves (SHA-256
// hashed, never recoverable), these have to be read back to forward a
// request, so they're encrypted, not hashed. Stored as
// `v1:<iv>:<authTag>:<ciphertext>` (each base64) — the version prefix leaves
// room to rotate the algorithm/key later without a guessing game.
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const VERSION = 'v1';
const IV_BYTES = 12; // GCM's standard nonce size

function keyBuffer(secretHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(secretHex)) {
    throw new Error('Encryption secret must be 64 hex characters (32 bytes).');
  }
  return Buffer.from(secretHex, 'hex');
}

export function encryptSecret(plaintext: string, secretHex: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyBuffer(secretHex), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

/** Throws on a wrong key, a tampered blob, or an unknown version. */
export function decryptSecret(blob: string, secretHex: string): string {
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Unrecognized encrypted secret format.');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv('aes-256-gcm', keyBuffer(secretHex), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
