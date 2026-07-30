import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { AppConfig, AppEnv } from '../../config.js';
import { requireAuth } from '../middleware/auth.js';
import { ApiError } from '../middleware/errors.js';
import type { User } from '../../interfaces/database.js';

type Env = {
  Bindings: AppEnv;
  Variables: { config: AppConfig; currentUser: User; requestId: string };
};

const router = new Hono<Env>();

const TABLES = {
  users: {
    primaryKey: 'id',
    columns: ['id', 'email', 'first_name', 'last_name', 'password_hash', 'email_confirmed_at', 'created_at', 'updated_at'],
    editable: ['email', 'first_name', 'last_name', 'email_confirmed_at'],
    secret: ['password_hash'],
  },
  sessions: {
    primaryKey: 'id',
    columns: ['id', 'user_id', 'token', 'expires_at', 'created_at'],
    editable: ['expires_at'],
    secret: ['token'],
  },
  password_reset_tokens: {
    primaryKey: 'id',
    columns: ['id', 'user_id', 'token', 'expires_at', 'used_at', 'created_at'],
    editable: ['expires_at', 'used_at'],
    secret: ['token'],
  },
  email_confirmation_tokens: {
    primaryKey: 'id',
    columns: ['id', 'user_id', 'token', 'expires_at', 'used_at', 'created_at'],
    editable: ['expires_at', 'used_at'],
    secret: ['token'],
  },
} as const;

type TableName = keyof typeof TABLES;

type AdminTableConfig = {
  primaryKey: string;
  columns: readonly string[];
  editable: readonly string[];
  secret: readonly string[];
};

router.use('*', requireAuth(), requireAdmin());

router.get('/tables', async (c) => {
  const tables = Object.entries(TABLES).map(([name, table]) => ({
    name,
    primaryKey: table.primaryKey,
    columns: table.columns,
    editableColumns: table.editable,
    secretColumns: table.secret,
  }));
  return c.json({ tables });
});

router.get('/tables/:table/rows', async (c) => {
  const tableName = parseTableName(c.req.param('table'));
  const table = TABLES[tableName];
  const limit = parseBoundedInt(c.req.query('limit'), 100, 1, 500);
  const offset = parseBoundedInt(c.req.query('offset'), 0, 0, 100000);
  const columns = table.columns.join(', ');

  const result = await c.env.DB
    .prepare(`SELECT ${columns} FROM ${tableName} ORDER BY ${table.primaryKey} LIMIT ? OFFSET ?`)
    .bind(limit, offset)
    .all<Record<string, unknown>>();
  const count = await c.env.DB
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
    .first<{ count: number }>();

  return c.json({
    table: tableName,
    primaryKey: table.primaryKey,
    columns: table.columns,
    editableColumns: table.editable,
    secretColumns: table.secret,
    rows: (result.results ?? []).map((row) => maskSecrets(row, table)),
    totalRows: count?.count ?? 0,
  });
});

router.patch('/tables/:table/rows/:id', async (c) => {
  const tableName = parseTableName(c.req.param('table'));
  const table = TABLES[tableName];
  const id = c.req.param('id');
  const body = await c.req.json<{ values?: Record<string, unknown> }>();
  const values = body.values ?? {};
  const editableColumns = table.editable as readonly string[];
  const entries = Object.entries(values).filter(([column]) => editableColumns.includes(column));

  if (entries.length === 0) throw new ApiError(400, 'No editable fields were provided.');

  const assignments = entries.map(([column]) => `${column} = ?`).join(', ');
  const params = entries.map(([, value]) => normalizeValue(value));
  await c.env.DB
    .prepare(`UPDATE ${tableName} SET ${assignments} WHERE ${table.primaryKey} = ?`)
    .bind(...params, id)
    .run();

  const row = await c.env.DB
    .prepare(`SELECT ${table.columns.join(', ')} FROM ${tableName} WHERE ${table.primaryKey} = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) throw new ApiError(404, 'Row not found.');

  return c.json({ row: maskSecrets(row, table) });
});

router.delete('/tables/:table/rows/:id', async (c) => {
  const tableName = parseTableName(c.req.param('table'));
  const table = TABLES[tableName];
  const id = c.req.param('id');

  await c.env.DB.prepare(`DELETE FROM ${tableName} WHERE ${table.primaryKey} = ?`).bind(id).run();
  return c.json({ ok: true });
});

export { router as adminRouter };

function requireAdmin(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const config = c.get('config');
    const user = c.get('currentUser');
    const email = user.email.trim().toLowerCase();
    if (!config.adminEmails.includes(email)) throw new ApiError(403, 'Admin access required.');
    await next();
  };
}

function parseTableName(raw: string): TableName {
  if (raw in TABLES) return raw as TableName;
  throw new ApiError(404, 'Table not found.');
}

function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = raw ? parseInt(raw, 10) : fallback;
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function maskSecrets(row: Record<string, unknown>, table: AdminTableConfig): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...row };
  for (const column of table.secret) {
    if (copy[column] != null) copy[column] = '[hidden]';
  }
  return copy;
}


