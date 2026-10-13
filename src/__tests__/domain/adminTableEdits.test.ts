import { describe, it, expect, vi } from 'vitest';
import { clearColumnTypeCache, coerceToColumn, columnTypes, encodeRowKey, rowWhere } from '../../domain/adminTableEdits';

const q = (n: string) => `"${n}"`;
const col = (dataType: string, nullable = true) => ({ dataType, nullable });

describe('row keys for tables with no single id column', () => {
  it('round-trip: the key made from a row finds exactly that row', () => {
    const row = { subject_type: 'user', subject_id: 'u1', month: '2026-10', metric: 'market_analyses', quantity: 5 };
    const key = encodeRowKey(row, ['subject_type', 'subject_id', 'month', 'metric']);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/); // safe in a URL path as is
    expect(rowWhere(key, 'subject_id', ['subject_type', 'subject_id', 'month', 'metric'], q)).toEqual({
      sql: '"subject_type" = $1 AND "subject_id" = $2 AND "month" = $3 AND "metric" = $4',
      params: ['user', 'u1', '2026-10', 'market_analyses'],
    });
  });

  it('numbers the placeholders after the ones already used', () => {
    const key = encodeRowKey({ a: 'x', b: 'y' }, ['a', 'b']);
    expect(rowWhere(key, 'a', ['a', 'b'], q, 3).sql).toBe('"a" = $3 AND "b" = $4');
  });

  it('a single id column is used as is', () => {
    expect(rowWhere('abc', 'id', undefined, q, 2)).toEqual({ sql: '"id" = $2', params: ['abc'] });
  });

  it('a damaged or wrong-length key is "row not found", never a broad update', () => {
    expect(() => rowWhere('!!!', 'a', ['a', 'b'], q)).toThrow(/Row not found/);
    expect(() => rowWhere(encodeRowKey({ a: 1 }, ['a']), 'a', ['a', 'b'], q)).toThrow(/Row not found/);
    expect(() => rowWhere(Buffer.from('{"a":1}').toString('base64url'), 'a', ['a'], q)).toThrow(/Row not found/);
  });
});

describe('values fitted to the column type', () => {
  it('whole numbers', () => {
    expect(coerceToColumn('quantity', '0', col('integer'))).toBe(0);
    expect(coerceToColumn('quantity', 7, col('bigint'))).toBe(7);
    expect(() => coerceToColumn('quantity', 'lots', col('integer'))).toThrow('quantity needs a whole number.');
    expect(() => coerceToColumn('quantity', '1.5', col('integer'))).toThrow(/whole number/);
  });

  it('decimals and true/false', () => {
    expect(coerceToColumn('p50', '1.25', col('numeric'))).toBe(1.25);
    expect(() => coerceToColumn('p50', 'abc', col('double precision'))).toThrow('p50 needs a number.');
    expect(coerceToColumn('active', 'false', col('boolean'))).toBe(false);
    expect(coerceToColumn('active', true, col('boolean'))).toBe(true);
    expect(() => coerceToColumn('active', 'maybe', col('boolean'))).toThrow(/true or false/);
  });

  it('JSON is checked and stored as JSON text; lists become lists', () => {
    expect(coerceToColumn('draft_json', '{"a": 1}', col('jsonb'))).toBe('{"a":1}');
    expect(coerceToColumn('draft_json', { a: 1 }, col('jsonb'))).toBe('{"a":1}');
    expect(() => coerceToColumn('draft_json', '{nope', col('jsonb'))).toThrow('draft_json needs valid JSON.');
    expect(coerceToColumn('events', '["key.created"]', col('ARRAY'))).toEqual(['key.created']);
    expect(coerceToColumn('events', ['a'], col('ARRAY'))).toEqual(['a']);
    expect(() => coerceToColumn('events', 'key.created', col('ARRAY'))).toThrow(/needs a list/);
    expect(() => coerceToColumn('events', '{"a":1}', col('ARRAY'))).toThrow(/needs a list/);
  });

  it('an empty box is no value (NULL), except plain text where it is empty text', () => {
    expect(coerceToColumn('expires_at', '', col('text'))).toBe('');
    expect(coerceToColumn('resolved_at', '', col('timestamp with time zone'))).toBeNull();
    expect(coerceToColumn('quantity', '  ', col('integer'))).toBeNull();
    expect(coerceToColumn('note', null, col('text'))).toBeNull();
  });

  it('text and unknown types pass through', () => {
    expect(coerceToColumn('name', 12, col('text'))).toBe('12');
    expect(coerceToColumn('at', '2026-10-13T00:00:00Z', col('timestamp with time zone'))).toBe('2026-10-13T00:00:00Z');
    expect(coerceToColumn('x', { a: 1 }, undefined)).toEqual({ a: 1 });
  });
});

describe('columnTypes', () => {
  it('asks the database once per table', async () => {
    clearColumnTypeCache();
    const query = vi.fn(async () => ({ rows: [{ column_name: 'quantity', data_type: 'integer', is_nullable: 'NO' }] }));
    const pool = { query } as never;
    const first = await columnTypes(pool, 'usage_meter');
    await columnTypes(pool, 'usage_meter');
    expect(first.get('quantity')).toEqual({ dataType: 'integer', nullable: false });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
