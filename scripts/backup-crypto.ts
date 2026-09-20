// Encrypts a backup file so the off-machine copy (OneDrive) is unreadable to anyone who gets into that account.
//
// Public-key ("hybrid") encryption: each file gets its own random AES-256-GCM key; that key is wrapped with the PUBLIC key
// (RSA-OAEP, SHA-256). This machine only ever holds the public key, so it cannot decrypt its own off-machine copies, and
// stealing the machine or the OneDrive account does not reveal the data. The private key (kept elsewhere, see
// docs/BACKUP-RESTORE.md) is needed only to restore: node scripts/decrypt-backup.mjs <file.enc> <private-key.pem> <out.gz>
//
// File layout:  "DSKBK1\n" | 2-byte length of the wrapped key | wrapped key (AES key + 12-byte nonce) | ciphertext | 16-byte tag
import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from "crypto";
import { createReadStream, createWriteStream, readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { pipeline } from "stream/promises";
import { Transform } from "stream";

export const BACKUP_MAGIC = Buffer.from("DSKBK1\n");
export const DEFAULT_PUBLIC_KEY_FILE = "C:\\Users\\User\\.desk\\backup-public.pem";

export function loadPublicKey(file: string): string {
  const pem = readFileSync(file, "utf8");
  createPublicKey(pem); // throws if it is not a valid public key (e.g. someone pasted the private key by mistake)
  if (/PRIVATE KEY/.test(pem)) throw new Error("The backup key file contains a private key; it must hold only the public key.");
  return pem;
}

/** Streams `source` through AES-256-GCM into `destination`; memory use stays small even for multi-GB backups. */
export async function encryptBackupFile(source: string, destination: string, publicKeyPem: string): Promise<void> {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const wrapped = publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.concat([key, nonce]));
  const header = Buffer.alloc(2);
  header.writeUInt16BE(wrapped.length);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const out = createWriteStream(destination);
  out.write(Buffer.concat([BACKUP_MAGIC, header, wrapped]));
  const appendTag = new Transform({
    transform(chunk, _enc, done) { done(null, chunk); },
    flush(done) { this.push(cipher.getAuthTag()); done(); },
  });
  await pipeline(createReadStream(source), cipher, appendTag, out);
}

/**
 * Keeps the newest `keep` encrypted backups in the off-machine folder. Old UNENCRYPTED copies (from before encryption
 * was switched on) are removed once at least one encrypted backup exists, so nothing readable stays behind.
 */
export function pruneOffHost(dir: string, keep: number): void {
  const names = readdirSync(dir);
  const encrypted = names
    .filter((f) => f.startsWith("backup-") && f.endsWith(".sql.gz.enc"))
    .map((f) => ({ file: f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const stale of encrypted.slice(keep)) {
    unlinkSync(join(dir, stale.file));
    console.log(`Removed old backup: ${join(dir, stale.file)}`);
  }
  if (encrypted.length > 0) {
    for (const legacy of names.filter((f) => f.startsWith("backup-") && f.endsWith(".sql.gz"))) {
      unlinkSync(join(dir, legacy));
      console.log(`Removed old unencrypted backup: ${join(dir, legacy)}`);
    }
  }
}
