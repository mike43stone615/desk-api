# Backup and Restore

---

## Cloudflare D1 (current deployment)

### Automatic backups

Cloudflare D1 takes automatic daily snapshots. These are accessible in the
Cloudflare Dashboard under **D1 → desk-api-db → Backups**.

Retention and recovery options are managed by Cloudflare; there is no manual
action required to enable them.

### Manual export

For an on-demand export of the full database:

```bash
# Export to a local SQL dump
npx wrangler d1 export desk-api-db --output backup-$(date +%Y%m%d).sql

# Export specific table
npx wrangler d1 export desk-api-db --table users --output users-$(date +%Y%m%d).sql
```

Schedule a weekly manual export and store the dump file in a safe location
(e.g., a separate R2 bucket or encrypted cloud storage).

### Restore from SQL dump

```bash
# WARNING: This overwrites existing data in the target database.
# Verify the dump contents first.
npx wrangler d1 execute desk-api-db --remote --file backup-20260101.sql
```

For a full restore, apply in this order:
1. `migrations/001_initial_schema.sql` (recreate schema)
2. The data dump (restore rows)

### Local D1 (development)

Local D1 state is stored in `.wrangler/state/`. To reset:
```bash
rm -rf .wrangler/state
npm run migrate:local
```

---

## Cloudflare R2 (current deployment)

R2 does not have automatic versioning by default. To protect against accidental
deletion, enable object versioning on the bucket:

```bash
npx wrangler r2 bucket object-versioning enable desk-api-storage
```

### Manual R2 backup

Use `rclone` to sync the bucket to a secondary location:

```bash
# Configure rclone with your Cloudflare R2 credentials (use API token, not account key)
rclone sync r2:desk-api-storage backup-location:desk-api-storage-backup
```

Run this on a schedule (weekly or daily depending on upload volume).

### R2 restore

```bash
rclone sync backup-location:desk-api-storage-backup r2:desk-api-storage
```

---

## Self-hosted — PostgreSQL (future deployment)

When running the self-hosted stack from `compose.yaml`:

### Continuous backup with pg_dump

```bash
# Dump all data (run from the Docker host)
docker exec desk-api-postgres pg_dump -U deskapi deskapi > backup-$(date +%Y%m%d-%H%M).sql

# Compress and store off-host
gzip backup-$(date +%Y%m%d-%H%M).sql
rclone copy backup-*.sql.gz remote:desk-api-backups/
```

Add this to a cron job:
```
0 3 * * * /opt/desk-api/scripts/backup-postgres.sh
```

### WAL-based continuous backup (recommended for production)

For point-in-time recovery, configure one of:
- **pgBackRest** — preferred for production, supports WAL archiving and full+incremental backups
- **Barman** — Postgres-native backup server

Both integrate with the `postgres:16-alpine` image used in `compose.yaml`.

### Restore from pg_dump

```bash
# Stop desk-api to prevent writes during restore
docker compose stop desk-api

# Drop and recreate the database
docker exec desk-api-postgres psql -U deskapi -c "DROP DATABASE deskapi;"
docker exec desk-api-postgres psql -U deskapi -c "CREATE DATABASE deskapi;"

# Restore
gunzip < backup-20260101.sql.gz | docker exec -i desk-api-postgres psql -U deskapi deskapi

# Restart
docker compose start desk-api
```

---

## Self-hosted — MinIO (future deployment)

### Backup with rclone

```bash
rclone sync minio:desk-api-storage backup-location:desk-api-storage
```

### MinIO native backup

MinIO supports bucket replication. Configure a replication target in the MinIO
Console (`http://localhost:9001`) under **Buckets → desk-api-storage → Replication**.

---

## Pre-migration export (D1 → PostgreSQL)

Before migrating to self-hosted PostgreSQL:

```bash
# 1. Export D1 to SQL
npx wrangler d1 export desk-api-db --output d1-full-export.sql

# 2. Convert SQLite timestamps and types to PostgreSQL
# The D1 schema uses ISO-8601 strings and INTEGER booleans —
# see docs/POSTGRES-ADAPTER-PLAN.md for the full mapping.

# 3. Apply PostgreSQL schema
psql $DATABASE_URL -f migrations/001_postgres.sql

# 4. Import converted data
psql $DATABASE_URL -f d1-full-export-converted.sql

# 5. Verify row counts
psql $DATABASE_URL -c "SELECT 'users', COUNT(*) FROM users UNION ALL SELECT 'sessions', COUNT(*) FROM sessions;"
```

---

## Retention policy (recommended)

| Backup type | Frequency | Retention |
|---|---|---|
| D1 export (Cloudflare) | Daily (automatic) | 30 days (Cloudflare managed) |
| D1 manual export | Weekly | 12 weeks |
| R2 sync | Weekly | 12 weeks |
| PostgreSQL pg_dump | Daily | 30 days |
| PostgreSQL WAL | Continuous | 7 days |
| MinIO replication | Continuous | — |
