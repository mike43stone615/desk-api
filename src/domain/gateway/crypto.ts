// AES-256-GCM for the real backend keys stored behind registry_api /
// market_validation_api grants. Unlike the gateway keys themselves (SHA-256
// hashed, never recoverable), these have to be read back to forward a
// request, so they're encrypted, not hashed.
//
// Stored as `v2:<kid>:<iv>:<authTag>:<ciphertext>` (iv/tag/ciphertext base64). <kid> is a short fingerprint of the
// key that encrypted it (the first 8 hex of its SHA-256; not secret and not usable to recover it), so when the secret
// is rotated each stored value says which key it needs. Rotation is: deploy the new secret as
// GATEWAY_KEY_ENCRYPTION_SECRET with the old one in GATEWAY_KEY_ENCRYPTION_SECRET_PREVIOUS, run
// scripts/rotate-gateway-secret.ts, then drop the old one (see docs/ROTATING-GATEWAY-SECRETS.md).
//
// The original `v1:<iv>:<authTag>:<ciphertext>` format (no key id) is still readable: it is tried against each known
// key in turn.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const IV_BYTES = 12; // GCM's standard nonce size

function keyBuffer(secretHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(secretHex)) {
    throw new Error('Encryption secret must be 64 hex characters (32 bytes).');
  }
  return Buffer.from(secretHex, 'hex');
}

/** Short public identifier of a key, stored next to what it encrypted. Reveals nothing usable about the key. */
export function keyFingerprint(secretHex: string): string {
  return createHash('sha256').update(keyBuffer(secretHex)).digest('hex').slice(0, 8);
}

/** The fingerprint a stored value was encrypted under, or null for the old v1 format / anything unrecognised. */
export function blobKeyId(blob: string): string | null {
  const parts = blob.split(':');
  return parts.length === 5 && parts[0] === 'v2' ? parts[1] : null;
}

export function encryptSecret(plaintext: string, secretHex: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyBuffer(secretHex), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v2', keyFingerprint(secretHex), iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

function open(ivB64: string, tagB64: string, ctB64: string, secretHex: string): string {
  const decipher = createDecipheriv('aes-256-gcm', keyBuffer(secretHex), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * Decrypts with the given key, or with whichever of several known keys it needs (current first, then previous ones).
 * Throws on a wrong key, a tampered value, an unknown version, or when none of the keys is the one it was made with.
 */
export function decryptSecret(blob: string, secrets: string | readonly string[]): string {
  const keys = typeof secrets === 'string' ? [secrets] : secrets;
  const parts = blob.split(':');

  if (parts.length === 5 && parts[0] === 'v2') {
    const [, kid, ivB64, tagB64, ctB64] = parts;
    const key = keys.find((k) => keyFingerprint(k) === kid);
    if (!key) throw new Error('None of the configured encryption secrets can open this value.');
    return open(ivB64, tagB64, ctB64, key);
  }
  if (parts.length === 4 && parts[0] === 'v1') {
    const [, ivB64, tagB64, ctB64] = parts;
    let last: unknown = new Error('No encryption secret configured.');
    for (const key of keys) {
      try {
        return open(ivB64, tagB64, ctB64, key);
      } catch (err) {
        last = err;
      }
    }
    throw last;
  }
  throw new Error('Unrecognized encrypted secret format.');
}
