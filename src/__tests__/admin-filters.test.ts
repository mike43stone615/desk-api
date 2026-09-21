import { describe, it, expect } from 'vitest';
import { parseFilters, escapeLikeValue, buildFilterClause, validateEditableValue, friendlyDbError } from '../routes/admin';

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

describe('validateEditableValue for the platform tables', () => {
  const bad = (table: never, column: string, value: unknown) => expect(() => validateEditableValue(table, column, value)).toThrow();

  it('whole-number columns take numbers and numeric text, and only the optional ones may be emptied', () => {
    expect(validateEditableValue('plans' as never, 'monthly_price_cents', '3100')).toBe(3100);
    expect(validateEditableValue('plans' as never, 'max_keys', 25)).toBe(25);
    expect(validateEditableValue('plans' as never, 'per_minute_limit', '')).toBeNull();
    expect(validateEditableValue('teams' as never, 'rate_limit_per_minute', null)).toBeNull();
    bad('plans' as never, 'monthly_price_cents', '');
    bad('plans' as never, 'monthly_price_cents', 'lots');
    bad('plans' as never, 'monthly_price_cents', -1);
    bad('plans' as never, 'monthly_price_cents', 1.5);
    bad('plans' as never, 'monthly_price_cents', 3_000_000_000);
  });

  it('true/false columns accept true, false and their text forms, nothing else', () => {
    expect(validateEditableValue('plans' as never, 'active', 'true')).toBe(true);
    expect(validateEditableValue('webhook_endpoints' as never, 'active', false)).toBe(false);
    bad('plans' as never, 'active', 'maybe');
  });

  it('a column with a fixed list of choices accepts only those', () => {
    expect(validateEditableValue('subscriptions' as never, 'status', 'past_due')).toBe('past_due');
    expect(validateEditableValue('invoices' as never, 'status', 'void')).toBe('void');
    bad('invoices' as never, 'status', 'paid-ish');
    bad('invoices' as never, 'status', '');
    bad('team_members' as never, 'role', null);
  });
});

describe('friendlyDbError', () => {
  it('turns the database rules into plain refusals, and leaves anything else alone', () => {
    expect(friendlyDbError({ code: '23503' })?.status).toBe(409);
    expect(friendlyDbError({ code: '23505' })?.status).toBe(409);
    expect(friendlyDbError({ code: '23514', constraint: 'plans_max_keys_check' })?.message).toContain('plans_max_keys_check');
    expect(friendlyDbError({ code: '23502', column: 'name' })?.message).toContain('name');
    expect(friendlyDbError({ code: '22P02' })?.status).toBe(400);
    expect(friendlyDbError({ code: '08006' })).toBeNull();
    expect(friendlyDbError(new Error('plain'))).toBeNull();
    expect(friendlyDbError(null)).toBeNull();
  });
});
