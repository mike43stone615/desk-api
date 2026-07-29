#!/usr/bin/env bash
# Run on the Oracle server AFTER docker compose is up and SQL files are uploaded.
# Usage: sudo bash import-databases.sh <postgres-password>
set -euo pipefail

PGPASS="${1:?Usage: import-databases.sh <postgres-password>}"
CONTAINER=$(docker ps --filter "name=postgres" --format "{{.Names}}" | head -1)

if [ -z "$CONTAINER" ]; then
  echo "ERROR: postgres container not running. Run 'docker compose up -d' first."
  exit 1
fi

echo "=== Creating databases ==="
docker exec -e PGPASSWORD="$PGPASS" "$CONTAINER" \
  psql -U postgres -c "CREATE DATABASE compliance_os;" 2>/dev/null || echo "compliance_os already exists"

docker exec -e PGPASSWORD="$PGPASS" "$CONTAINER" \
  psql -U postgres -c "CREATE DATABASE desk_registry;" 2>/dev/null || echo "desk_registry already exists"

echo ""
echo "=== Importing compliance_os (2.3 GB — a few minutes) ==="
docker exec -e PGPASSWORD="$PGPASS" -i "$CONTAINER" \
  psql -U postgres compliance_os < /opt/deskbusiness/compliance_os_backup.sql
echo "compliance_os: done"

echo ""
echo "=== Importing desk_registry (7.7 GB — 20-40 minutes) ==="
docker exec -e PGPASSWORD="$PGPASS" -i "$CONTAINER" \
  psql -U postgres desk_registry < /opt/deskbusiness/desk_registry_backup.sql
echo "desk_registry: done"

echo ""
echo "=== Verifying row counts ==="
docker exec -e PGPASSWORD="$PGPASS" "$CONTAINER" \
  psql -U postgres compliance_os -c "SELECT relname AS table, n_live_tup AS rows FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 10;"

docker exec -e PGPASSWORD="$PGPASS" "$CONTAINER" \
  psql -U postgres desk_registry -c "SELECT relname AS table, n_live_tup AS rows FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 10;"

echo ""
echo "=== Import complete. Restart services to pick up the populated databases. ==="
echo "Run: docker compose restart compliance-os registry-api"
