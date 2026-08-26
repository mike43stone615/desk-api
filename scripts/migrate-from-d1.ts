// One-time D1 -> Postgres data migration -- see docs/KNOWN-LIMITATIONS.md
// #1. Migrates the 7 real user-data tables from the live Cloudflare Worker's
// D1 database into this service's Postgres. Column names/types are 1:1
// identical (both TEXT/ISO-8601, no coercion needed -- see
// migrations/0002_auth.sql's header comment) so this is a straight INSERT.
//
// Deliberately excludes the D1 database's market_* tables (oews_wage_rows,
// market_reference_values, market_commuter_density, market_sba_lending,
// etc.) -- those are obsolete leftovers from before market-validation-api
// was split out as its own service with its own database; this rewrite's
// admin.ts explicitly dropped the equivalent routes (see its header
// comment). Nothing here should read or write them.
//
// Usage:
//   1. Export each table from the live D1 database:
//        CLOUDFLARE_API_TOKEN=... npx wrangler d1 execute desk-api-db \
//          --remote --command "SELECT * FROM <table>" --json > d1-export/<table>.json
//      (run from the Worker repo, since that's where wrangler.toml lives)
//   2. tsx scripts/migrate-from-d1.ts --export-dir <dir> [--clear-first]
//
// --clear-first deletes all existing rows from the 7 target tables before
// inserting (in FK-safe order) -- use for a genuinely clean migration into
// a database that has local dev/test data in it, not a truly empty one.
// Without it, insertion uses ON CONFLICT (id) DO NOTHING, so a partial
// prior run or overlapping test data won't crash the script, but also
// won't overwrite anything already there under the same id.
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";

const TABLES_IN_FK_ORDER = [
  "users",
  "sessions",
  "password_reset_tokens",
  "email_confirmation_tokens",
  "business_setup_drafts",
  "businesses",
  "business_memberships",
] as const;

function parseArgs(argv: string[]): { exportDir: string; clearFirst: boolean } {
  let exportDir = "";
  let clearFirst = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--export-dir") exportDir = argv[++i];
    else if (argv[i] === "--clear-first") clearFirst = true;
  }
  if (!exportDir) throw new Error("Usage: tsx scripts/migrate-from-d1.ts --export-dir <dir> [--clear-first]");
  return { exportDir, clearFirst };
}

function loadExport(exportDir: string, table: string): Record<string, unknown>[] {
  const path = join(exportDir, `${table}.json`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Array<{ results: Record<string, unknown>[] }>;
  return parsed[0]?.results ?? [];
}

async function main(): Promise<void> {
  const { exportDir, clearFirst } = parseArgs(process.argv.slice(2));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (clearFirst) {
      // Reverse FK order for deletes.
      for (const table of [...TABLES_IN_FK_ORDER].reverse()) {
        const { rowCount } = await client.query(`DELETE FROM ${table}`);
        console.log(`Cleared ${rowCount} existing row(s) from ${table}.`);
      }
    }

    const sourceCounts: Record<string, number> = {};

    for (const table of TABLES_IN_FK_ORDER) {
      const rows = loadExport(exportDir, table);
      sourceCounts[table] = rows.length;
      if (rows.length === 0) {
        console.log(`${table}: 0 source rows, nothing to insert.`);
        continue;
      }

      const columns = Object.keys(rows[0]);
      let inserted = 0;
      for (const row of rows) {
        const values = columns.map((c) => row[c]);
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
        const result = await client.query(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`,
          values,
        );
        inserted += result.rowCount ?? 0;
      }
      console.log(`${table}: inserted ${inserted} of ${rows.length} source row(s).`);
    }

    // Verify: every table's post-migration Postgres count must be >= the
    // source count (>= rather than == to tolerate --clear-first not being
    // passed on a database that already had unrelated rows this migration
    // didn't touch, e.g. a fresh cordata-style row created by something
    // else entirely -- but for a --clear-first run these should be exactly
    // equal, checked explicitly below).
    console.log("\nVerifying row counts...");
    let allOk = true;
    for (const table of TABLES_IN_FK_ORDER) {
      const { rows } = await client.query(`SELECT count(*) FROM ${table}`);
      const actual = Number(rows[0].count);
      const expected = sourceCounts[table];
      const ok = clearFirst ? actual === expected : actual >= expected;
      if (!ok) allOk = false;
      console.log(`  ${table}: source=${expected}, postgres=${actual} ${ok ? "OK" : "MISMATCH"}`);
    }

    if (!allOk) {
      throw new Error("Row count verification failed -- rolling back.");
    }

    await client.query("COMMIT");
    console.log("\nMigration committed.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed, rolled back:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
