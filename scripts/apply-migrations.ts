// Applies pending migrations/*.sql files against DATABASE_URL and records
// each one in the schema_migrations table (see
// migrations/0001_schema_migrations.sql), so repeated runs are safe and only
// genuinely-new migrations get applied. Ported verbatim from
// registry-api's/market-validation-api's scripts/apply-migrations.ts.
//
// Usage:
//   npm run migrate                 # apply + record everything pending
//   npm run migrate -- --dry-run    # print what WOULD run, without running it
import 'dotenv/config';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import pg from 'pg';

const { Client } = pg;

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const BOOTSTRAP_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    text PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now()
  );
`;

function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // filenames are zero-padded numeric prefixes (0001_, 0002_, ...) — lexical sort is numeric order
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    if (!dryRun) {
      await client.query(BOOTSTRAP_SQL);
    }

    let applied: Set<string>;
    try {
      const { rows } = await client.query<{ filename: string }>('SELECT filename FROM schema_migrations');
      applied = new Set(rows.map((r) => r.filename));
    } catch {
      applied = new Set();
    }

    const files = listMigrationFiles();
    const pending = files.filter((f) => !applied.has(f));

    if (files.length === 0) {
      console.log(`No .sql files found in ${MIGRATIONS_DIR}`);
      return;
    }

    console.log(`Found ${files.length} migration file(s), ${applied.size} already recorded, ${pending.length} pending.`);

    if (pending.length === 0) {
      console.log('Nothing to do — schema_migrations is up to date.');
      return;
    }

    for (const filename of pending) {
      if (dryRun) {
        console.log(`[dry-run] would apply + record: ${filename}`);
        continue;
      }

      const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
      console.log(`Applying ${filename} ...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [filename]);
        await client.query('COMMIT');
        console.log(`  done (applied + recorded).`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  FAILED — ${filename} was rolled back and not recorded.`);
        throw err;
      }
    }

    console.log(`Applied ${pending.length} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
