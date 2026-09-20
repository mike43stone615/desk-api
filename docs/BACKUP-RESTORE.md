# Backup and Restore

This describes the **current** Fastify/TypeScript/PostgreSQL architecture
(see git history around commit `aceb5e8` for the earlier Cloudflare
Workers/D1/R2 build this replaced — that backup story no longer applies).

PostgreSQL (accessed via the `pg` package, `src/db.ts`; schema tracked in
`schema_migrations` via `migrations/*.sql`) is the only stateful datastore
this service owns. Redis (`REDIS_URL`) holds only rate-limit counters —
disposable, not something that needs backing up (see the table at the
bottom of this doc).

This service is **live in production** at `api.deskbusiness.co`.
`docker-compose.yml` starts Postgres + Redis for local development only —
production runs against the real host's own Postgres instance directly.

**Automated backup is live:** `scripts/backup-database.ts` runs `pg_dump`,
streams it straight through gzip (not buffered in memory — this matters
once a database grows past a few hundred MB), and prunes to the 14 most
recent generations. It's registered as the "Desk API Database Backup"
Windows scheduled task, running daily at 3:30am (staggered against the
other three services' identical setups so they don't all hit the shared
Postgres instance at once). **A real restore rehearsal has been run and
verified** — see the restore section below for exactly what that proved.

**Off-host copy is also live:** every backup is additionally copied into
`C:\Users\User\OneDrive\DeskPlatformBackups\desk-api\` (the OneDrive
already signed into this machine — the destination this doc's earlier
"known, deliberate gap" note had been waiting on), pruned to the same 14
generations. Confirmed live: the copy genuinely lands in the real,
actively-syncing OneDrive folder, not just a local path with that name.
This is additive — the local copy and its retention are unchanged, so a
missing or unsynced OneDrive folder degrades to the original single-disk
behavior rather than failing the scheduled backup outright. Override with
`OFFHOST_BACKUP_DIR` (or `--offhost-dir`); set it to an empty string to
disable the off-host copy entirely. A single disk failure now takes out
the live data and the local backup copy, but not the off-host one — the
platform-wide "everything lives on one machine" risk (this host itself
still being a single point of failure) is separate and remains open,
tracked in `docs/KNOWN-LIMITATIONS.md`.

---

## Local development (`docker-compose.yml`)

### Manual backup

```bash
# From the repo root, with the local stack running (docker compose up -d)
docker compose exec -T postgres pg_dump -U desk_api_dev desk_api_dev > backup-$(date +%Y%m%d-%H%M).sql

# Compress for storage
gzip backup-$(date +%Y%m%d-%H%M).sql
```

### Restore

```bash
# WARNING: this overwrites existing data in the target database.
# Stop the app first so nothing writes during the restore.

# Drop and recreate
docker compose exec -T postgres psql -U desk_api_dev -d postgres -c "DROP DATABASE desk_api_dev;"
docker compose exec -T postgres psql -U desk_api_dev -d postgres -c "CREATE DATABASE desk_api_dev;"

# Restore schema + data
gunzip -c backup-20260101-0000.sql.gz | docker compose exec -T postgres psql -U desk_api_dev desk_api_dev

# Re-apply any migrations newer than the dump (a no-op if the dump already
# includes every row of schema_migrations up to the current HEAD)
npm run migrate
```

### Reset local state entirely (throwaway dev data, no backup needed)

```bash
docker compose down -v   # -v also drops the postgres_data named volume
docker compose up -d
npm run migrate
```

---

## Production

The scheduled task described above runs, unmodified:

```bash
tsx scripts/backup-database.ts
# writes backups/backup-<timestamp>.sql.gz, streamed + gzipped, keeping the
# 14 most recent generations
```

`DATABASE_URL` and `PGDUMP_PATH` (if `pg_dump` isn't on the scheduled
task's PATH — see the script's `resolvePgDump()`) come from the service's
own `.env`, the same one every other part of this service reads.

**Acceptable data-loss window:** up to 24 hours (time since the last daily
dump). If that's ever too wide, move to WAL-based continuous backup
(pgBackRest, Barman, or a managed Postgres provider's point-in-time
recovery) — not needed today, but worth revisiting if this service starts
holding data where losing up to a day of it would be a real problem.

### Restore from a production backup

```bash
# Stop the app first — no writes during restore
gunzip -c backups/backup-2026-09-01T03-30-00-000Z.sql.gz | psql "$DATABASE_URL"
```

**This exact procedure has been rehearsed for real**, against an isolated
throwaway database (`desk_api_restore_test`, never the live `desk_api`
database) rather than just assumed to work: the most recent real backup at
the time decompressed and restored cleanly with `psql -f` — every table,
index, and foreign-key constraint created without error — and the restored
data was verified by direct row counts against what was actually in the
live database at that time. The throwaway database and the decompressed
temp file were both deleted immediately after.

---

## What's covered / not covered

| Data | Backed up by the above? |
|---|---|
| `users`, `sessions`, `password_reset_tokens`, `email_confirmation_tokens` | Yes — in Postgres |
| `business_setup_drafts`, `businesses`, `business_memberships` | Yes — in Postgres |
| `mutation_audit_log`, `idempotency_keys` | Yes — in Postgres |
| `schema_migrations` | Yes — in Postgres (a dump/restore preserves migration history) |
| Redis rate-limit counters | No — and shouldn't need to be. These are disposable, short-TTL sliding-window counters (`src/middleware/api-protection.ts`), not a source of truth for anything; losing them just means rate-limit windows reset. |
| registry-api / compliance-os / market-validation-api data | No — each sibling service owns and is responsible for backing up its own database independently. |

---

## Related

- `docs/KNOWN-LIMITATIONS.md` #2 — the full history of this backup's
  automation and both restore rehearsals, plus the still-open off-host
  storage gap.
- `migrations/*.sql` — schema, applied via `npm run migrate`
  (`scripts/apply-migrations.ts`), tracked in `schema_migrations`.

## Encrypted off-machine copies (from 20 September 2026)

The copies in the OneDrive folder (`DeskPlatformBackups\<service>\backup-*.sql.gz.enc`) are encrypted with a **public** key kept on this machine (`C:\Users\User\.desk\backup-public.pem`). Each file gets its own random AES-256-GCM key, wrapped with that public key, so this machine (and anyone who reaches the OneDrive account) can create backups but **cannot read them**. The local copies in each repo's `backups\` folder stay plain, because they are protected by the machine itself.

- **The private key** is `DESK-BACKUP-PRIVATE-KEY.pem`. It is needed *only* to restore from an off-machine copy. It must be kept somewhere that survives losing this machine (a password manager or an encrypted USB stick), and **not** in OneDrive. If it is lost, the off-machine copies cannot be read by anyone, ever.
- **Restore:** `node scripts/decrypt-backup.mjs <backup.sql.gz.enc> <private-key.pem> <output.sql.gz>`, then load the output as in the manual procedure above. A damaged or altered file is refused, not partly decrypted.
- **Fail closed:** if the public key is missing, nothing is copied off the machine (a readable copy is never written), the backup task ends with an error, and the local backup is unaffected.
- **Watched:** the uptime watch (`offhost-backups-encrypted`) alerts when an off-machine copy is older than 40 hours, missing, or a readable `.sql.gz` is found there.
- OneDrive keeps deleted files in its recycle bin for a while. The old readable copies removed when encryption was switched on are in that bin until it is emptied (OneDrive web, Recycle bin, Empty).
