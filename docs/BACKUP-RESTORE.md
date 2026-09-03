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

**Known, deliberate gap:** every backup still lands on the same disk as the
live database it's backing up. Off-host storage (cloud object storage, or
the OneDrive already signed into this machine) was considered and
intentionally deferred until a specific destination is chosen, rather than
built toward an undecided one. A single disk failure would still take out
the live data and every backup of it — this is a real, open risk, tracked
in `docs/KNOWN-LIMITATIONS.md`, not an oversight.

---

## Local development (`docker-compose.yml`)

### Manual backup

```bash
# From the repo root, with the local stack running (docker compose up -d)
docker compose exec -T postgres pg_dump -U postgres desk_api > backup-$(date +%Y%m%d-%H%M).sql

# Compress for storage
gzip backup-$(date +%Y%m%d-%H%M).sql
```

### Restore

```bash
# WARNING: this overwrites existing data in the target database.
# Stop the app first so nothing writes during the restore.

# Drop and recreate
docker compose exec -T postgres psql -U postgres -c "DROP DATABASE desk_api;"
docker compose exec -T postgres psql -U postgres -c "CREATE DATABASE desk_api;"

# Restore schema + data
gunzip -c backup-20260101-0000.sql.gz | docker compose exec -T postgres psql -U postgres desk_api

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
