// Scheduled Postgres backup — see docs/BACKUP-RESTORE.md and
// docs/KNOWN-LIMITATIONS.md #2 ("no automated database backup exists
// yet"). Wraps pg_dump rather than reimplementing it: pg_dump already
// handles schema + data + the full dump-format tooling correctly, and this
// script's only real job is running it on a schedule, compressing, and
// keeping a bounded number of generations.
//
// Usage: tsx scripts/backup-database.ts [--out-dir <dir>] [--keep <n>]
// Requires `pg_dump` on PATH (bundled with any local PostgreSQL install;
// see docs/BACKUP-RESTORE.md's manual-procedure section for the Docker
// Compose equivalent if pg_dump isn't installed on the host directly).
//
// Not wired into a scheduler here deliberately -- this repo has no
// deployment yet (see README.md), so there's no production host to
// schedule against. Once deployed, invoke this from cron/systemd-timer/the
// hosting platform's scheduled-job feature; see docs/BACKUP-RESTORE.md for
// the restore-side commands this pairs with.
import "dotenv/config";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { gzipSync } from "zlib";
import { readFileSync, writeFileSync } from "fs";

function parseArgs(argv: string[]): { outDir: string; keep: number } {
  let outDir = "backups";
  let keep = 14;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out-dir") outDir = argv[++i];
    else if (argv[i] === "--keep") keep = Number(argv[++i]);
  }
  return { outDir, keep };
}

// `pg_dump` isn't on PATH in this environment's shells (confirmed: neither
// is `psql` -- see scripts/apply-migrations.ts's Node-`pg`-client
// workaround for the same underlying gap). Falls back to the common
// Windows PostgreSQL install location rather than failing outright.
function resolvePgDump(): string {
  const result = spawnSync("pg_dump", ["--version"]);
  if (result.status === 0) return "pg_dump";
  const fallback = "C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe";
  if (existsSync(fallback)) return fallback;
  throw new Error(
    "pg_dump not found on PATH or at the default Windows install location. Set PGDUMP_PATH or install the PostgreSQL client tools.",
  );
}

function main(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required.");
    process.exit(1);
  }

  const { outDir, keep } = parseArgs(process.argv.slice(2));
  mkdirSync(outDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dumpPath = join(outDir, `backup-${timestamp}.sql`);
  const gzPath = `${dumpPath}.gz`;

  const pgDump = process.env.PGDUMP_PATH ?? resolvePgDump();
  console.log(`Running pg_dump -> ${dumpPath} ...`);
  const result = spawnSync(pgDump, [databaseUrl, "-f", dumpPath], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`pg_dump exited with status ${result.status}.`);
    process.exit(result.status ?? 1);
  }

  const compressed = gzipSync(readFileSync(dumpPath));
  writeFileSync(gzPath, compressed);
  unlinkSync(dumpPath);
  console.log(`Wrote ${gzPath} (${compressed.length} bytes).`);

  const dumps = readdirSync(outDir)
    .filter((f) => f.startsWith("backup-") && f.endsWith(".sql.gz"))
    .map((f) => ({ file: f, mtime: statSync(join(outDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const stale of dumps.slice(keep)) {
    unlinkSync(join(outDir, stale.file));
    console.log(`Removed old backup: ${stale.file}`);
  }

  if (!existsSync(gzPath)) {
    console.error("Backup file missing after write -- treat this run as failed.");
    process.exit(1);
  }
}

main();
