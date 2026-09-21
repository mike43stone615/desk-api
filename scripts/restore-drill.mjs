// Restore drill: takes the newest ENCRYPTED off-machine backup, decrypts it, loads it into an empty database on a
// THROWAWAY PostgreSQL server (its own data folder, port 5544, local only, deleted afterwards), compares row counts with the
// live database, and reports any error the restore hit. Nothing on the live server is written.
//   DATABASE_URL=<live database, read only> node scripts/restore-drill.mjs <backup folder> <private-key.pem>
//   e.g. node scripts/restore-drill.mjs C:/Users/User/OneDrive/DeskPlatformBackups/registry-api C:/Users/User/Desktop/DESK-BACKUP-PRIVATE-KEY.pem
// Needs the PostgreSQL 17 command-line tools (initdb, pg_ctl, psql). Prints only names, counts and timings.
// Why it exists: the first run (September 2026) found that this database's backup could not be restored at all (see
// migrations/018_restore_safe_functions.sql).
import pg from 'pg';
import { readdirSync, statSync, mkdirSync, rmSync, createReadStream, createWriteStream } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const { Client } = pg;

const [, , dir, keyPath] = process.argv;
if (!dir || !keyPath || !process.env.DATABASE_URL) { console.error('usage: DATABASE_URL=... node scripts/restore-drill.mjs <backup folder> <private-key.pem>'); process.exit(2); }
const liveUrl = new URL(process.env.DATABASE_URL);
const svc = 'drill';
const NAME = 'restore_drill';
const PGBIN = process.env.PGBIN || 'C:/Program Files/PostgreSQL/17/bin';
const SP = join(tmpdir(), 'restore-drill');
const PGDATA = join(SP, 'pgdata');
const PSQL = `${PGBIN}/psql.exe`;
const scratchUrl = new URL('postgres://drill@127.0.0.1:5544/' + NAME);
mkdirSync(SP, { recursive: true });
const t0 = Date.now(); const lap = (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);

const newest = readdirSync(dir).filter((f) => f.endsWith('.enc')).map((f) => ({ f, t: statSync(`${dir}/${f}`).mtimeMs })).sort((a, b) => b.t - a.t)[0].f;
lap(`newest encrypted off-machine backup: ${newest} (${(statSync(`${dir}/${newest}`).size / 1048576).toFixed(0)} MB)`);

execFileSync('node', [join(dirname(fileURLToPath(import.meta.url)), 'decrypt-backup.mjs'), `${dir}/${newest}`, keyPath, `${SP}/${svc}.sql.gz`], { stdio: 'pipe' });
lap('decrypted with the private key (authentication tag verified)');
await pipeline(createReadStream(`${SP}/${svc}.sql.gz`), createGunzip(), createWriteStream(`${SP}/${svc}.sql`));
lap(`unzipped: ${(statSync(`${SP}/${svc}.sql`).size / 1048576).toFixed(0)} MB of SQL`);

rmSync(PGDATA, { recursive: true, force: true });
execFileSync(`${PGBIN}/initdb.exe`, ['-D', PGDATA, '-U', 'drill', '--auth=trust', '-E', 'UTF8'], { stdio: 'pipe' });
execFileSync(`${PGBIN}/pg_ctl.exe`, ['-D', PGDATA, '-o', '-p 5544 -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off', '-l', `${SP}/pg.log`, '-w', 'start'], { stdio: 'ignore' });
lap('throwaway PostgreSQL server started on port 5544');
const admin = new Client({ connectionString: 'postgres://drill@127.0.0.1:5544/postgres' }); await admin.connect();
const roleName = decodeURIComponent(liveUrl.username);
await admin.query(`CREATE ROLE "${roleName}" LOGIN`);
await admin.query(`CREATE DATABASE ${NAME}`);
lap(`scratch database ${NAME} created`);
try {
  const code = await new Promise((resolve) => {
    const p = spawn(PSQL, ['-q', '-v', 'ON_ERROR_STOP=0', '-f', `${SP}/${svc}.sql`, scratchUrl.toString()], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errs = 0; const sample = []; const all = new Set();
    p.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (/ERROR/.test(l)) { errs++; const m = l.slice(l.indexOf('ERROR:'), l.indexOf('ERROR:') + 260).replace(/\s+/g, ' '); if (!all.has(m) && all.size < 6) { all.add(m); sample.push(m); } } });
    p.on('close', (c) => { console.log(`psql exit ${c}, ${errs} error lines`, sample); resolve(c); });
  });
  lap('restore finished');
  const s = new Client({ connectionString: scratchUrl.toString() }); await s.connect();
  const live = new Client({ connectionString: liveUrl.toString() }); await live.connect();
  const tables = (await live.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1`)).rows.map((r) => r.tablename);
  const stables = new Set((await s.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'`)).rows.map((r) => r.tablename));
  let same = 0, drift = 0, missing = 0; const notes = [];
  for (const t of tables) {
    if (!stables.has(t)) { missing++; notes.push(`MISSING ${t}`); continue; }
    const a = Number((await s.query(`SELECT count(*) n FROM "${t}"`)).rows[0].n);
    const b = Number((await live.query(`SELECT count(*) n FROM "${t}"`)).rows[0].n);
    if (a === b) same++; else { drift++; notes.push(`${t}: backup ${a} vs live ${b}`); }
  }
  const idx = async (c) => Number((await c.query(`SELECT count(*) n FROM pg_indexes WHERE schemaname='public'`)).rows[0].n);
  const mig = async (c) => (await c.query(`SELECT count(*)::int n FROM schema_migrations`).catch(() => ({ rows: [{ n: 'n/a' }] }))).rows[0].n;
  console.log(`tables: ${tables.length} live; ${same} identical row counts, ${drift} differ (changes since the backup), ${missing} missing from the restore`);
  console.log('differences:', notes.slice(0, 12));
  console.log(`indexes: restored ${await idx(s)} vs live ${await idx(live)}; migrations recorded: restored ${await mig(s)} vs live ${await mig(live)}`);
  await s.end(); await live.end();
} finally {
  await admin.end().catch(() => {});
  try { execFileSync(`${PGBIN}/pg_ctl.exe`, ['-D', PGDATA, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }); } catch { /* already stopped */ }
  rmSync(PGDATA, { recursive: true, force: true });
  rmSync(`${SP}/${svc}.sql`, { force: true }); rmSync(`${SP}/${svc}.sql.gz`, { force: true });
  lap('throwaway server stopped and everything deleted');
}
