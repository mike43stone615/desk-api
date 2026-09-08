// Scheduled Postgres backup — see docs/BACKUP-RESTORE.md and
// docs/KNOWN-LIMITATIONS.md #2 (live, restore-rehearsed automation). Wraps
// pg_dump rather than reimplementing it: pg_dump already
// handles schema + data + the full dump-format tooling correctly, and this
// script's only real job is running it on a schedule, compressing, and
// keeping a bounded number of generations.
//
// Off-host copy: every backup used to land only on the same disk as the
// live database it protects -- a single disk failure took out both at
// once. Also copies each fresh backup into a real OneDrive-synced folder
// (already signed into this machine -- the specific destination
// docs/BACKUP-RESTORE.md's "known, deliberate gap" note had been waiting
// on), pruned to the same generation count. This is additive, not a
// replacement: the local copy and its own retention are unchanged, so a
// missing/unsynced OneDrive folder degrades to the original single-disk
// behavior rather than failing the backup outright.
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
// Usage: tsx scripts/backup-database.ts [--out-dir <dir>] [--keep <n>] [--offhost-dir <dir>]
// (or OFFHOST_BACKUP_DIR env var; pass an empty string to disable the
// off-host copy entirely)
// Requires `pg_dump` on PATH (bundled with any local PostgreSQL install;
// see docs/BACKUP-RESTORE.md's manual-procedure section for the Docker
// Compose equivalent if pg_dump isn't installed on the host directly).
//
// Registered as the "Desk API Database Backup" scheduled task (daily) —
// see scripts/run-backup-task.ps1 and docs/BACKUP-RESTORE.md for the
// restore-side commands this pairs with.
import "dotenv/config";
import { spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, createWriteStream, copyFileSync } from "fs";
import { join } from "path";
import { createGzip } from "zlib";
import { pipeline } from "stream/promises";

// Real OneDrive folder on this machine (confirmed signed in and actively
// syncing) -- can be overridden or disabled (empty string) via env var.
// A relative fallback like "OneDrive" would resolve wrong once run from
// scripts run-as a different working directory (e.g. the scheduled task's
// own wrapper), so this defaults to the real absolute path directly.
const DEFAULT_OFFHOST_DIR = "C:\\Users\\User\\OneDrive\\DeskPlatformBackups\\desk-api";

function parseArgs(argv: string[]): { outDir: string; keep: number; offHostDir: string } {
  let outDir = "backups";
  let keep = 14;
  let offHostDir = process.env.OFFHOST_BACKUP_DIR ?? DEFAULT_OFFHOST_DIR;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out-dir") outDir = argv[++i];
    else if (argv[i] === "--keep") keep = Number(argv[++i]);
    else if (argv[i] === "--offhost-dir") offHostDir = argv[++i];
  }
  return { outDir, keep, offHostDir };
}

// Prunes to `keep` most recent generations, matching the local retention
// logic below -- an off-host copy that grows forever isn't a real backup
// policy either.
function pruneOldBackups(dir: string, keep: number): void {
  const dumps = readdirSync(dir)
    .filter((f) => f.startsWith("backup-") && f.endsWith(".sql.gz"))
    .map((f) => ({ file: f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const stale of dumps.slice(keep)) {
    unlinkSync(join(dir, stale.file));
    console.log(`Removed old backup: ${join(dir, stale.file)}`);
  }
}

// Best-effort: a missing/unsynced OneDrive folder degrades to the original
// single-disk behavior (still a real local backup) rather than failing the
// scheduled task outright over a copy step.
function copyToOffHost(gzPath: string, fileName: string, offHostDir: string, keep: number): void {
  if (!offHostDir) {
    console.log("Off-host backup copy disabled (OFFHOST_BACKUP_DIR set to empty).");
    return;
  }
  try {
    mkdirSync(offHostDir, { recursive: true });
    copyFileSync(gzPath, join(offHostDir, fileName));
    pruneOldBackups(offHostDir, keep);
    console.log(`Copied backup off-host -> ${join(offHostDir, fileName)}`);
  } catch (err) {
    console.error(`Off-host backup copy failed (local backup is still intact): ${String(err)}`);
  }
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

  const { outDir, keep, offHostDir } = parseArgs(process.argv.slice(2));
  mkdirSync(outDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `backup-${timestamp}.sql.gz`;
  const gzPath = join(outDir, fileName);

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

  if (!existsSync(gzPath)) {
    console.error("Backup file missing after write -- treat this run as failed.");
    process.exit(1);
  }

  pruneOldBackups(outDir, keep);
  copyToOffHost(gzPath, fileName, offHostDir, keep);
}

main();
