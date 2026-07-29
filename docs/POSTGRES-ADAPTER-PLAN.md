# PostgreSQL Adapter Plan

This document describes exactly how each `DatabaseRepository` method translates from
the current D1 (SQLite) adapter to a future PostgreSQL adapter.

The interface (`src/interfaces/database.ts`) does not change. Only the adapter
implementation changes.

## Schema differences

| D1 / SQLite | PostgreSQL |
|---|---|
| `TEXT PRIMARY KEY` | `TEXT PRIMARY KEY` (compatible) |
| `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')` | `to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` |
| No native UUID function | `gen_random_uuid()::text` |
| `INTEGER` for booleans | `BOOLEAN` |

## D1 → PostgreSQL method mapping

| Method | D1 approach | PostgreSQL approach |
|---|---|---|
| `findUserById` | `.prepare().bind().first<T>()` | `pool.query<T>('SELECT ... WHERE id = $1', [id])` → `.rows[0]` |
| `findUserByEmail` | `.prepare().bind().first<T>()` | `pool.query<T>('... WHERE email = $1', [email])` → `.rows[0]` |
| `createUser` | `.prepare().bind().run()` + refetch | `pool.query('INSERT ... RETURNING *')` → `.rows[0]` |
| `updateUserPassword` | `.prepare().bind().run()` | `pool.query('UPDATE ... WHERE id = $1', [hash, userId])` |
| `createSession` | `.prepare().bind().run()` + refetch | `pool.query('INSERT ... RETURNING *')` |
| `findSessionByToken` | `.prepare().bind().first<T>()` | `pool.query<T>('... WHERE token = $1', [token])` |
| `deleteSession` | `.prepare().bind().run()` | `pool.query('DELETE ... WHERE token = $1', [token])` |
| `deleteExpiredSessions` | `WHERE expires_at < strftime(...)` | `WHERE expires_at < NOW()` |
| `createResetToken` | Two statements | Two statements with `pool.query` |
| `findResetToken` | `.first<T>()` | `.rows[0]` |
| `markResetTokenUsed` | `.run()` | `.query(...)` |

## PostgreSQL migration script

```sql
-- migrations/001_postgres.sql
CREATE TABLE IF NOT EXISTS users (
  id           TEXT    PRIMARY KEY,
  email        TEXT    NOT NULL UNIQUE,
  password_hash TEXT   NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT         PRIMARY KEY,
  user_id    TEXT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT         NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ  NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         TEXT         PRIMARY KEY,
  user_id    TEXT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT         NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ  NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prt_user_id ON password_reset_tokens (user_id);
```

## Timestamp portability note

The current D1 adapter stores timestamps as ISO-8601 strings (e.g.
`2026-01-15T12:00:00Z`). The PostgreSQL adapter should store them as
`TIMESTAMPTZ` and serialize them to ISO-8601 strings in the mapper functions,
maintaining the same `User`, `Session`, `PasswordResetToken` interface shapes.

## Contract test

A contract test suite should run the same test cases against both adapters
to verify behavioral equivalence. This can be gated by an environment variable:

```typescript
// tests/contract/database-repo.test.ts
const adapter = process.env.TEST_DB === 'postgres'
  ? new PostgresAdapter(pool)
  : new D1Adapter(db);

test('createUser returns user with normalized email', async () => { ... });
test('findUserByEmail is case-insensitive', async () => { ... });
// ...
```
