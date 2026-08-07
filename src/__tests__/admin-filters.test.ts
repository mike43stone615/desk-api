import { describe, it, expect } from 'vitest';
import { parseFilters, escapeLikeValue, buildFilterClause, validateEditableValue } from '../routes/admin';

describe('parseFilters', () => {
  it('keeps only allowed columns and drops empty values', () => {
    const raw = JSON.stringify({ email: 'alice', not_allowed: 'x', first_name: '' });
    expect(parseFilters(raw, ['email', 'first_name'])).toEqual({ email: 'alice' });
  });

  it('returns {} for invalid JSON or a non-object', () => {
    expect(parseFilters('not json', ['email'])).toEqual({});
    expect(parseFilters('42', ['email'])).toEqual({});
    expect(parseFilters(undefined, ['email'])).toEqual({});
  });
});

describe('escapeLikeValue', () => {
  it('escapes %, _, and backslash', () => {
    expect(escapeLikeValue('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
});

describe('buildFilterClause', () => {
  it('builds a parameterized ILIKE clause per filter', () => {
    const { sql, params } = buildFilterClause({ email: 'alice', first_name: 'Al' });
    expect(sql).toContain('WHERE');
    expect(sql).toContain('ILIKE $1');
    expect(sql).toContain('ILIKE $2');
    expect(params).toEqual(['%alice%', '%Al%']);
  });

  it('returns an empty clause for no filters', () => {
    expect(buildFilterClause({})).toEqual({ sql: '', params: [] });
  });
});

describe('validateEditableValue', () => {
  it('accepts a real Desk industry for businesses.industry', () => {
    expect(validateEditableValue('businesses', 'industry', 'Bakery')).toBe('Bakery');
  });

  it('rejects a value not in the Desk industry list', () => {
    expect(() => validateEditableValue('businesses', 'industry', 'Not A Real Industry')).toThrow();
  });

  it('passes through other columns unchanged', () => {
    expect(validateEditableValue('users', 'first_name', 'Alice')).toBe('Alice');
  });
});
