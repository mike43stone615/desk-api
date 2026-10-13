import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pool } from '../../db';

// Rehearses migration 0033 (two link tables -> email_tokens) on data shaped like production: the old tables are re-created
// in a scratch schema, filled with awkward rows (used and unused links, several per user, odd timestamps), the real
// migration file is run there, and every row is compared before and after. Also proves the migration refuses (and changes
// nothing) when the two old tables would clash. Skipped when E2E_DATABASE_URL is not set.
const hasDb = !!process.env.E2E_DATABASE_URL;
const MIGRATION = readFileSync(join(__dirname, '../../../migrations/0033_merge_email_tokens.sql'), 'utf8');
const OLD_SHAPE = `
  CREATE TABLE users (id TEXT PRIMARY KEY);
  CREATE TABLE password_reset_tokens (id TEXT NOT NULL PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token TEXT NOT NULL,
    expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  CREATE UNIQUE INDEX ON password_reset_tokens (token);
  CREATE TABLE email_confirmation_tokens (id TEXT NOT NULL PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token TEXT NOT NULL,
    expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  CREATE UNIQUE INDEX ON email_confirmation_tokens (token);`;

async function inScratchSchema<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>) => Promise<T>): Promise<T> {
  const schema = `merge_rehearsal_${randomBytes(4).toString('hex')}`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    return await fn((sql, params) => client.query(sql, params as never));
  } finally {
    await client.query('RESET search_path').catch(() => {});
    await client.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    client.release();
  }
}

describe.skipIf(!hasDb)('E2E: table-merge migration 0033 keeps every row', () => {
  it('copies every link with every value, keeps the old names working for the running version, and cascades on user delete', async () => {
    await inScratchSchema(async (q) => {
      await q(OLD_SHAPE);
      const users = Array.from({ length: 30 }, (_, i) => `u${i}`);
      await q(`INSERT INTO users SELECT unnest($1::text[])`, [users]);
      const rows: Array<[string, string, string, string, string | null, string]> = [];
      for (let i = 0; i < 400; i++) {
        const used = i % 3 === 0 ? `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00Z` : null;
        rows.push([`id-${i}`, users[i % users.length], `sha256:${randomBytes(32).toString('hex')}`, `2026-1${i % 3}-01T00:00:00Z`, used, `2026-08-${String(1 + (i % 28)).padStart(2, '0')}T0${i % 10}:00:00Z`]);
      }
      const half = rows.length / 2;
      for (const [table, part] of [['password_reset_tokens', rows.slice(0, half)], ['email_confirmation_tokens', rows.slice(half)]] as const) {
        for (const r of part) await q(`INSERT INTO ${table} (id, user_id, token, expires_at, used_at, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, r);
      }
      const snapshot = async (table: string) => (await q(`SELECT id, user_id, token, expires_at, used_at, created_at FROM ${table} ORDER BY id`)).rows;
      const beforeReset = await snapshot('password_reset_tokens');
      const beforeConfirm = await snapshot('email_confirmation_tokens');

      await q('BEGIN'); await q(MIGRATION); await q('COMMIT');

      expect((await q(`SELECT count(*)::int n FROM email_tokens`)).rows[0].n).toBe(rows.length);
      expect((await q(`SELECT id, user_id, token, expires_at, used_at, created_at FROM email_tokens WHERE purpose = 'password_reset' ORDER BY id`)).rows).toEqual(beforeReset);
      expect((await q(`SELECT id, user_id, token, expires_at, used_at, created_at FROM email_tokens WHERE purpose = 'email_confirmation' ORDER BY id`)).rows).toEqual(beforeConfirm);
      // the old names (views) answer exactly as the old tables did, so the version still running keeps working
      expect(await snapshot('password_reset_tokens')).toEqual(beforeReset);
      expect(await snapshot('email_confirmation_tokens')).toEqual(beforeConfirm);
      // ... including the writes the old version makes: insert, mark used, delete expired
      await q(`INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES ('new-reset', 'u1', 'sha256:new-r', '2027-01-01T00:00:00Z')`);
      await q(`INSERT INTO email_confirmation_tokens (id, user_id, token, expires_at) VALUES ('new-confirm', 'u1', 'sha256:new-c', '2027-01-01T00:00:00Z')`);
      expect((await q(`SELECT purpose FROM email_tokens WHERE id IN ('new-reset','new-confirm') ORDER BY id`)).rows.map((r) => r.purpose)).toEqual(['email_confirmation', 'password_reset']);
      await q(`UPDATE password_reset_tokens SET used_at = 'x' WHERE token = 'sha256:new-c'`); // the other kind's token: no effect
      expect((await q(`SELECT used_at FROM email_tokens WHERE id = 'new-confirm'`)).rows[0].used_at).toBeNull();
      await q(`DELETE FROM email_confirmation_tokens WHERE expires_at < '2026-11-00'`);
      expect((await q(`SELECT count(*)::int n FROM email_tokens WHERE purpose = 'password_reset'`)).rows[0].n).toBe(half + 1); // reset links untouched
      // deleting a user still removes their links
      await q(`DELETE FROM users WHERE id = 'u1'`);
      expect((await q(`SELECT count(*)::int n FROM email_tokens WHERE user_id = 'u1'`)).rows[0].n).toBe(0);
    });
  });

  it('refuses and changes nothing when the two tables clash (same id in both)', async () => {
    await inScratchSchema(async (q) => {
      await q(OLD_SHAPE);
      await q(`INSERT INTO users VALUES ('u')`);
      await q(`INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES ('same', 'u', 't1', 'e')`);
      await q(`INSERT INTO email_confirmation_tokens (id, user_id, token, expires_at) VALUES ('same', 'u', 't2', 'e')`);
      await q('BEGIN');
      await expect(q(MIGRATION)).rejects.toThrow();
      await q('ROLLBACK');
      expect((await q(`SELECT to_regclass('email_tokens') AS t`)).rows[0].t).toBeNull();
      expect((await q(`SELECT count(*)::int n FROM password_reset_tokens`)).rows[0].n).toBe(1);
      expect((await q(`SELECT count(*)::int n FROM email_confirmation_tokens`)).rows[0].n).toBe(1);
    });
  });
});
