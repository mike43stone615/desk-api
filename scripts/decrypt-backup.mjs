// Restores an encrypted backup:  node scripts/decrypt-backup.mjs <backup.sql.gz.enc> <private-key.pem> <output.sql.gz>
// Then restore as usual: gunzip the output and load it with psql (docs/BACKUP-RESTORE.md). Needs only Node, no packages.
import { constants, createDecipheriv, privateDecrypt } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const [, , inputPath, keyPath, outputPath] = process.argv;
if (!inputPath || !keyPath || !outputPath) { console.error('usage: node scripts/decrypt-backup.mjs <backup.sql.gz.enc> <private-key.pem> <output.sql.gz>'); process.exit(2); }

const MAGIC = Buffer.from('DSKBK1\n');
const fd = openSync(inputPath, 'r');
const size = fstatSync(fd).size;
const head = Buffer.alloc(MAGIC.length + 2);
readSync(fd, head, 0, head.length, 0);
if (!head.subarray(0, MAGIC.length).equals(MAGIC)) { console.error('This is not an encrypted Desk backup (wrong header).'); process.exit(1); }
const wrappedLength = head.readUInt16BE(MAGIC.length);
const wrapped = Buffer.alloc(wrappedLength);
readSync(fd, wrapped, 0, wrappedLength, head.length);
const tag = Buffer.alloc(16);
readSync(fd, tag, 0, 16, size - 16);
closeSync(fd);

let material;
try {
  material = privateDecrypt({ key: readFileSync(keyPath, 'utf8'), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, wrapped);
} catch { console.error('That private key does not match this backup.'); process.exit(1); }
const decipher = createDecipheriv('aes-256-gcm', material.subarray(0, 32), material.subarray(32, 44));
decipher.setAuthTag(tag);
const start = head.length + wrappedLength;
try {
  await pipeline(createReadStream(inputPath, { start, end: size - 17 }), decipher, createWriteStream(outputPath));
} catch { console.error('The backup is damaged or has been tampered with (integrity check failed). The output file must not be used.'); process.exit(1); }
console.log(`Decrypted to ${outputPath}`);
