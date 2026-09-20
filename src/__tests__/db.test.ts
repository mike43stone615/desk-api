// The database pool's limits, and that a dropped connection cannot crash the service.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { pool, poolOptions } from '../db';

const KEYS = ['DB_POOL_MAX', 'DB_CONNECT_TIMEOUT_MS', 'DB_IDLE_TIMEOUT_MS', 'DB_STATEMENT_TIMEOUT_MS', 'DB_IDLE_IN_TRANSACTION_TIMEOUT_MS'];
let clock = Date.parse('2026-01-01T00:00:00Z');
beforeEach(() => {
  // each test starts well after the previous report, so the once-per-10-seconds rule does not couple them
  clock += 60_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(() => {
  vi.restoreAllMocks();
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
  it('also survives a checked-out connection being ended by the database', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const client = new EventEmitter();
      // what the pool does whenever it opens a new connection
      pool.emit('connect', client as never);
      expect(client.listenerCount('error')).toBeGreaterThan(0);
      expect(() => client.emit('error', new Error('terminating connection due to idle-in-transaction timeout'))).not.toThrow();
    } finally {
      write.mockRestore();
    }
  });

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
