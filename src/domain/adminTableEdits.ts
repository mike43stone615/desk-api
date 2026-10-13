// Owner-wide editing in the administrator tables.
//
// Administrators edit only the columns each table lists as editable. An owner may edit every column of every table
// (except a single-column id, which other rows point at). Two things make that safe:
//   - Row keys: some tables have no single id column, only a combination (usage_meter: subject + month + metric). Their
//     rows carry a ROW_KEY made from those columns, so an edit always reaches exactly one row.
//   - Types: a value is checked against the column's real database type (number, true/false, JSON, list, text...) and
//     refused in plain words when it does not fit, instead of being written as text.
import type { Pool } from 'pg';
import { HttpError } from '../middleware/http-error';

/** The field a row's key travels in when its table has no single id column. */
export const ROW_KEY = '_rowKey';

export function encodeRowKey(row: Record<string, unknown>, keyColumns: readonly string[]): string {
  return Buffer.from(JSON.stringify(keyColumns.map((c) => row[c] ?? null)), 'utf8').toString('base64url');
}

/** The WHERE clause that finds one row: by its id column, or by every column of its key. Placeholders start at `first`. */
export function rowWhere(
  id: string,
  primaryKey: string,
  keyColumns: readonly string[] | undefined,
  quote: (name: string) => string,
  first = 1,
): { sql: string; params: unknown[] } {
  if (!keyColumns || keyColumns.length === 0) return { sql: `${quote(primaryKey)} = $${first}`, params: [id] };
  let values: unknown;
  try {
    values = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(404, 'Row not found.', 'row_not_found');
  }
  if (!Array.isArray(values) || values.length !== keyColumns.length) throw new HttpError(404, 'Row not found.', 'row_not_found');
  return {
    sql: keyColumns.map((c, i) => `${quote(c)} = $${first + i}`).join(' AND '),
    params: values,
  };
}

export interface ColumnType { dataType: string; nullable: boolean }

const typeCache = new Map<string, Map<string, ColumnType>>();

/** Each column's database type (looked up once per table). */
export async function columnTypes(pool: Pick<Pool, 'query'>, table: string): Promise<Map<string, ColumnType>> {
  const cached = typeCache.get(table);
  if (cached) return cached;
  const { rows } = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`,
    [table],
  );
  const map = new Map(rows.map((r) => [r.column_name, { dataType: r.data_type, nullable: r.is_nullable === 'YES' }]));
  if (map.size > 0) typeCache.set(table, map);
  return map;
}

/** For tests. */
export function clearColumnTypeCache(): void {
  typeCache.clear();
}

const INTEGER_TYPES = new Set(['smallint', 'integer', 'bigint']);
const DECIMAL_TYPES = new Set(['numeric', 'real', 'double precision', 'decimal']);
const TEXT_TYPES = new Set(['text', 'character varying', 'character', 'citext']);

/**
 * The value to write, fitted to the column's type, or a plain-words 400. An empty box means "no value" (NULL) for every
 * column except text, where it is an empty string; the database still refuses NULL where a value is required.
 */
export function coerceToColumn(column: string, value: unknown, type: ColumnType | undefined): unknown {
  if (!type) return value; // unknown column type: the database decides
  const t = type.dataType;
  const empty = value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
  if (empty) return TEXT_TYPES.has(t) && value === '' ? '' : null;
  if (INTEGER_TYPES.has(t)) {
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isSafeInteger(n)) throw new HttpError(400, `${column} needs a whole number.`, 'invalid_value');
    return n;
  }
  if (DECIMAL_TYPES.has(t)) {
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(n)) throw new HttpError(400, `${column} needs a number.`, 'invalid_value');
    return n;
  }
  if (t === 'boolean') {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw new HttpError(400, `${column} must be true or false.`, 'invalid_value');
  }
  if (t === 'json' || t === 'jsonb') {
    if (typeof value !== 'string') return JSON.stringify(value);
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      throw new HttpError(400, `${column} needs valid JSON.`, 'invalid_value');
    }
  }
  if (t === 'ARRAY') {
    let list: unknown = value;
    if (typeof value === 'string') {
      try {
        list = JSON.parse(value);
      } catch {
        throw new HttpError(400, `${column} needs a list, for example ["a", "b"].`, 'invalid_value');
      }
    }
    if (!Array.isArray(list)) throw new HttpError(400, `${column} needs a list, for example ["a", "b"].`, 'invalid_value');
    return list;
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
