// Which migration files in this version have not been applied to the database yet. The deploy refuses to start such a
// version (scripts/check-migrations.ts), so this is normally empty; it exists so /health/ready says so loudly if it ever
// is not (for example a migration file added by hand).
import { readdirSync } from 'fs';
import { join } from 'path';
import { pool } from '../../db';

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'migrations');
const CACHE_MS = 60_000;
let cache: { at: number; pending: string[] } | null = null;

export function resetMigrationCache(): void {
  cache = null;
}

export async function pendingMigrations(now = Date.now()): Promise<string[]> {
  if (cache && now - cache.at < CACHE_MS) return cache.pending;
  let files: string[];
  try {
    files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    return []; // no migrations folder shipped: nothing to compare against
  }
  const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));
  const pending = files.filter((f) => !applied.has(f));
  cache = { at: now, pending };
  return pending;
}
