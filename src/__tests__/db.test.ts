// The database pool's limits, and that a dropped connection cannot crash the service.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { pool, poolOptions } from '../db';

const KEYS = ['DB_POOL_MAX', 'DB_CONNECT_TIMEOUT_MS', 'DB_IDLE_TIMEOUT_MS', 'DB_STATEMENT_TIMEOUT_MS', 'DB_IDLE_IN_TRANSACTION_TIMEOUT_MS'];
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe('poolOptions', () => {
  it('has a limit for everything that could otherwise hang or pile up', () => {
    const o = poolOptions('postgresql://u:p@localhost/db');
    expect(o).toMatchObject({
      max: 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 20_000,
      query_timeout: 25_000,
      idle_in_transaction_session_timeout: 30_000,
      application_name: 'desk-api',
    });
    expect(o.connectionString).toBe('postgresql://u:p@localhost/db');
  });

  it('every limit can be changed with an environment variable', () => {
    process.env.DB_POOL_MAX = '3';
    process.env.DB_CONNECT_TIMEOUT_MS = '1500';
    process.env.DB_IDLE_TIMEOUT_MS = '1000';
    process.env.DB_STATEMENT_TIMEOUT_MS = '2000';
    process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS = '4000';
    expect(poolOptions(undefined)).toMatchObject({
      max: 3, connectionTimeoutMillis: 1500, idleTimeoutMillis: 1000, statement_timeout: 2000, query_timeout: 7000, idle_in_transaction_session_timeout: 4000,
    });
  });

  it('ignores nonsense values instead of switching a limit off', () => {
    process.env.DB_STATEMENT_TIMEOUT_MS = '0';
    process.env.DB_POOL_MAX = 'lots';
    process.env.DB_CONNECT_TIMEOUT_MS = '-5';
    expect(poolOptions(undefined)).toMatchObject({ statement_timeout: 20_000, max: 10, connectionTimeoutMillis: 5000 });
  });
});

describe('the pool', () => {
  it('survives the database dropping a connection: an error event is logged, not thrown', () => {
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
      expect(write).toHaveBeenCalledTimes(1);
      const line = JSON.parse(String(write.mock.calls[0][0]));
      expect(line).toMatchObject({ level: 'error', event: 'db_pool_error', message: 'terminating connection due to administrator command' });
      // a restart drops many connections at once; it is reported once, not once each
      pool.emit('error', new Error('another'));
      pool.emit('error', new Error('and another'));
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
    }
  });
});
