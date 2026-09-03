// Scheduled Postgres backup — see docs/BACKUP-RESTORE.md and
// docs/KNOWN-LIMITATIONS.md #2 (live, restore-rehearsed automation; the
// off-host storage gap tracked there is still open). Wraps pg_dump rather
// than reimplementing it: pg_dump already
// handles schema + data + the full dump-format tooling correctly, and this
// script's only real job is running it on a schedule, compressing, and
// keeping a bounded number of generations.
//
// Streams pg_dump's stdout straight through gzip into the output file
// instead of buffering the whole dump in memory first — the original
// buffered version of this script (readFileSync + gzipSync) worked fine
// against this service's small database, but the identical approach hit
// Node's ERR_FS_FILE_TOO_LARGE the moment it was copied to registry-api's
// multi-GB database and left compliance-os's pg_dump running well past a
// reasonable window. Rewritten here too so this doesn't quietly break the
// same way once this database grows.
//
// Usage: tsx scripts/backup-database.ts [--out-dir <dir>] [--keep <n>]
// Requires `pg_dump` on PATH (bundled with any local PostgreSQL install;
// see docs/BACKUP-RESTORE.md's manual-procedure section for the Docker
// Compose equivalent if pg_dump isn't installed on the host directly).
//
// Registered as the "Desk API Database Backup" scheduled task (daily) —
// see scripts/run-backup-task.ps1 and docs/BACKUP-RESTORE.md for the
// restore-side commands this pairs with.
import "dotenv/config";
import { spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, createWriteStream } from "fs";
import { join } from "path";
import { createGzip } from "zlib";
import { pipeline } from "stream/promises";

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

async function dumpAndCompress(pgDump: string, databaseUrl: string, gzPath: string): Promise<void> {
  const child = spawn(pgDump, [databaseUrl], { stdio: ["ignore", "pipe", "inherit"] });
  const gzip = createGzip();
  const out = createWriteStream(gzPath);

  const pipelineDone = pipeline(child.stdout, gzip, out);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

  await pipelineDone;
  if (exitCode !== 0) {
    throw new Error(`pg_dump exited with status ${exitCode}.`);
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required.");
    process.exit(1);
  }

  const { outDir, keep } = parseArgs(process.argv.slice(2));
  mkdirSync(outDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const gzPath = join(outDir, `backup-${timestamp}.sql.gz`);

  const pgDump = process.env.PGDUMP_PATH ?? resolvePgDump();
  console.log(`Running pg_dump -> ${gzPath} (streamed + gzipped) ...`);

  try {
    await dumpAndCompress(pgDump, databaseUrl, gzPath);
  } catch (err) {
    if (existsSync(gzPath)) unlinkSync(gzPath);
    console.error(String(err));
    process.exit(1);
  }

  console.log(`Wrote ${gzPath} (${statSync(gzPath).size} bytes).`);

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
