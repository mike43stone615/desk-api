// Read-only: exits 0 when every migration file in ./migrations has been applied to DATABASE_URL, and 3 (listing the
// missing ones) when some are pending. The deploy runs this before swapping versions so code that needs a new table or
// column is never started against a database that does not have it yet. Changes nothing.
import 'dotenv/config';
import { readdirSync } from 'fs';
import { join } from 'path';
import pg from 'pg';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    let applied = new Set<string>();
    try {
      const { rows } = await client.query<{ filename: string }>('SELECT filename FROM schema_migrations');
      applied = new Set(rows.map((r) => r.filename));
    } catch {
      // no schema_migrations table at all: everything is pending
    }
    const files = readdirSync(join(__dirname, '..', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    const pending = files.filter((f) => !applied.has(f));
    if (pending.length === 0) {
      console.log(`All ${files.length} migrations are applied.`);
      return;
    }
    console.error(`Unapplied migrations (${pending.length}): ${pending.join(', ')}`);
    process.exitCode = 3;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
