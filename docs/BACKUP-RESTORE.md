# Backup and Restore

This describes the **current** Fastify/TypeScript/PostgreSQL architecture
(see git history around commit `aceb5e8` for the earlier Cloudflare
Workers/D1/R2 build this replaced — that backup story no longer applies).

PostgreSQL (accessed via the `pg` package, `src/db.ts`; schema tracked in
`schema_migrations` via `migrations/*.sql`) is the only stateful datastore
this service owns. Redis (`REDIS_URL`) holds only rate-limit counters —
disposable, not something that needs backing up (see the table at the
bottom of this doc).

This service is **not currently deployed** anywhere (see `README.md`) —
`docker-compose.yml` starts Postgres + Redis for local development only.

**Current gap:** no automated backup — scheduled `pg_dump` or WAL-based
continuous backup — is wired up anywhere in this repo yet. There is no such
script in `scripts/` (only `apply-migrations.ts` and `export-openapi.ts`
exist there) and no backup service defined in `docker-compose.yml`. This is
tracked in `docs/KNOWN-LIMITATIONS.md`. The manual procedure below is what
to use in the meantime, and an automated version of it (cron + off-host
storage, or a managed Postgres provider's built-in backups) should be set
up before this service holds any real user data.

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

## Production (once this service is actually deployed)

No production backup process exists yet, because there is no production
database yet — this build has not been cut over from the live Cloudflare
Worker (see `README.md`, `docs/KNOWN-LIMITATIONS.md`). Before cutover, set
up one of:

- **Scheduled `pg_dump`** — simplest. Run on a cron against `DATABASE_URL`,
  compress, and ship the file off-host (e.g. `rclone`, an S3-compatible
  bucket, or whatever the eventual hosting provider offers). Acceptable
  data-loss window with this approach = time since the last dump.
- **WAL-based continuous backup** (pgBackRest, Barman, or a managed
  Postgres provider's built-in point-in-time recovery) — needed if the
  acceptable data-loss window is smaller than "since last daily dump."
  Recommended once this service holds real user data (accounts,
  business-setup drafts, businesses, memberships) rather than only local
  test data.

Whichever is chosen, verify it with an actual restore rehearsal — not just
confirming the dump file exists — before relying on it in an incident.

### Example: scheduled `pg_dump` against a running instance

```bash
pg_dump "$DATABASE_URL" | gzip > backup-$(date +%Y%m%d-%H%M).sql.gz
# ship backup-*.sql.gz off-host on the same schedule
```

### Example: restore from a `pg_dump`

```bash
# Stop the app first — no writes during restore
gunzip -c backup-20260101-0000.sql.gz | psql "$DATABASE_URL"
```

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

- `docs/KNOWN-LIMITATIONS.md` — tracks the "no automated backup configured
  yet" gap, and the pending D1 → Postgres data migration needed before
  cutover.
- `migrations/*.sql` — schema, applied via `npm run migrate`
  (`scripts/apply-migrations.ts`), tracked in `schema_migrations`.
