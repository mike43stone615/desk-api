// Re-encrypts every stored backend key (gateway_api_key_grants.encrypted_backend_key) under the CURRENT
// GATEWAY_KEY_ENCRYPTION_SECRET, so the previous secret can then be removed. Safe to run repeatedly and while the
// service is live: each row is replaced only if it has not changed since it was read.
//
// Usage (see docs/ROTATING-GATEWAY-SECRETS.md):
//   npx tsx --env-file=<the deployed service's .env> scripts/rotate-gateway-secret.ts --dry-run
//   npx tsx --env-file=<the deployed service's .env> scripts/rotate-gateway-secret.ts
// Prints counts only; never a secret or a key.
import { pool } from '../src/db';
import { config } from '../src/config';
import { blobKeyId, decryptSecret, encryptSecret, keyFingerprint } from '../src/domain/gateway/crypto';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const current = config.gatewayKeyEncryptionSecret;
  if (!current) {
    console.error('GATEWAY_KEY_ENCRYPTION_SECRET is not set: nothing to rotate to.');
    process.exit(1);
  }
  const known = [current, ...config.gatewayKeyEncryptionSecretsPrevious];
  const currentId = keyFingerprint(current);

  const { rows } = await pool.query<{ id: string; encrypted_backend_key: string }>(
    `SELECT id, encrypted_backend_key FROM gateway_api_key_grants WHERE encrypted_backend_key IS NOT NULL ORDER BY id`,
  );
  let alreadyCurrent = 0;
  let rotated = 0;
  let unreadable = 0;
  const byOldKey = new Map<string, number>();

  for (const row of rows) {
    if (blobKeyId(row.encrypted_backend_key) === currentId) {
      alreadyCurrent++;
      continue;
    }
    let plaintext: string;
    try {
      plaintext = decryptSecret(row.encrypted_backend_key, known);
    } catch {
      unreadable++;
      continue;
    }
    const label = blobKeyId(row.encrypted_backend_key) ?? 'v1';
    byOldKey.set(label, (byOldKey.get(label) ?? 0) + 1);
    if (dryRun) continue;
    const result = await pool.query(
      `UPDATE gateway_api_key_grants SET encrypted_backend_key = $1 WHERE id = $2 AND encrypted_backend_key = $3`,
      [encryptSecret(plaintext, current), row.id, row.encrypted_backend_key],
    );
    if (result.rowCount) rotated++;
  }

  console.log(
    JSON.stringify({
      dryRun,
      total: rows.length,
      alreadyUnderCurrentKey: alreadyCurrent,
      [dryRun ? 'wouldRotate' : 'rotated']: dryRun ? [...byOldKey.values()].reduce((a, b) => a + b, 0) : rotated,
      unreadable,
      fromKeys: Object.fromEntries(byOldKey),
    }),
  );
  if (unreadable > 0) {
    console.error(`${unreadable} value(s) cannot be opened by any configured secret. Add the missing previous secret to GATEWAY_KEY_ENCRYPTION_SECRET_PREVIOUS.`);
    process.exitCode = 2;
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
