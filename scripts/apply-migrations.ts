// Applies pending migrations/*.sql files against DATABASE_URL and records
// each one in the schema_migrations table (see
// migrations/0001_schema_migrations.sql), so repeated runs are safe and only
// genuinely-new migrations get applied. Ported verbatim from
// registry-api's/market-validation-api's scripts/apply-migrations.ts.
//
// Usage:
//   npm run migrate                 # apply + record everything pending (development / test databases only)
//   npm run migrate -- --dry-run    # print what WOULD run, without running it
//   npm run migrate -- --production --env-file <the deployed service's .env>
//                                   # the real database: needs BOTH flags, so it can never happen by accident
//
// Safety: unless the database name ends in _dev or _test, this refuses to run without --production. A developer's
// local .env points at the dev database, so a stray `npm run migrate` cannot touch production.
import dotenv from 'dotenv';
dotenv.config();
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
  const production = process.argv.includes('--production');
  const envFileIndex = process.argv.indexOf('--env-file');
  if (envFileIndex !== -1) {
    const path = process.argv[envFileIndex + 1];
    if (!path) {
      console.error('--env-file needs a path.');
      process.exit(1);
    }
    dotenv.config({ path, override: true });
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
  const isSafeTarget = /_(dev|test)$/.test(databaseName);
  if (!isSafeTarget && !production) {
    console.error(
      `Refusing to run: database "${databaseName}" is not a development or test database (its name must end in _dev or _test).
` +
        'To migrate the real database on purpose, add --production (and --env-file <path to the deployed .env>).',
    );
    process.exit(1);
  }
  if (isSafeTarget && production) {
    console.error(`--production was given but "${databaseName}" looks like a development database. Check the env file.`);
    process.exit(1);
  }
  console.log(`Target database: ${databaseName}${production ? ' (PRODUCTION)' : ''}${dryRun ? ' — dry run' : ''}`);

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
