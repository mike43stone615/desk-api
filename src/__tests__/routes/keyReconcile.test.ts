// Drift between the backend keys desk-api holds and the ones the backends actually have.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { createFakeDb } from '../helpers/fake-db';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { pool } from '../../db';
import { config } from '../../config';
import { reconcileBackendKeys } from '../../domain/gateway/reconcile';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;
const realFetch = globalThis.fetch;
const saved = { ...config };
config.registryApiUrl = 'http://registry.test';
config.registryApiAdminKey = 'reg-admin';
config.marketApiUrl = 'http://market.test';
config.marketApiAdminKey = 'mkt-admin';

type Up = { id: string; label: string; createdAt: string };
let upstream: Record<'registry' | 'market', Up[] | 'down'>;
let revoked: string[];

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 3_600_000;

vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const which = url.startsWith('http://registry.test') ? 'registry' : 'market';
  const list = upstream[which];
  if (init?.method === 'DELETE') {
    revoked.push(url.split('/').pop()!);
    return new Response(null, { status: 204 });
  }
  if (list === 'down') throw new Error('ECONNREFUSED');
  return new Response(JSON.stringify({ apiKeys: list }), { status: 200 });
}));
afterAll(() => {
  Object.assign(config, saved);
  vi.stubGlobal('fetch', realFetch);
});

function seedKey(id: string, opts: { revoked?: boolean; grants?: Array<[string, string]> } = {}) {
  fakeDb.gatewayKeys.set(id, { id, owner_user_id: 'u1', label: 'k', key_hash: id, key_prefix: 'deskgw_x', created_at: '', last_used_at: null, revoked_at: opts.revoked ? '2026-01-01' : null });
  for (const [service, backend] of opts.grants ?? []) fakeDb.gatewayGrants.push({ id: `${id}-${service}`, api_key_id: id, service, backend_key_id: backend, encrypted_backend_key: 'enc' });
}

beforeEach(() => {
  fakeDb.gatewayKeys.clear();
  fakeDb.gatewayGrants.length = 0;
  upstream = { registry: [], market: [] };
  revoked = [];
});

describe('reconcileBackendKeys', () => {
  it('finds nothing when both sides agree', async () => {
    seedKey('k1', { grants: [['registry_api', 'r1'], ['market_validation_api', 'm1']] });
    upstream = {
      registry: [{ id: 'r1', label: 'gateway:u1:k1', createdAt: ago(HOUR) }, { id: 'other', label: 'a key made by hand', createdAt: ago(HOUR) }],
      market: [{ id: 'm1', label: 'gateway:u1:k1', createdAt: ago(HOUR) }],
    };
    expect(await reconcileBackendKeys()).toEqual({ orphansRevoked: 0, orphansFailed: 0, missing: 0, unreachable: [] });
    expect(revoked).toEqual([]);
  });

  it('revokes a live backend key no grant refers to, on either backend, and only that one', async () => {
    seedKey('k1', { grants: [['registry_api', 'r1']] });
    upstream = {
      registry: [{ id: 'r1', label: 'gateway:u1:k1', createdAt: ago(HOUR) }, { id: 'r-orphan', label: 'gateway:gone-user:gone-key', createdAt: ago(HOUR) }, { id: 'hand-made', label: 'ops key', createdAt: ago(HOUR) }],
      market: [{ id: 'm-orphan', label: 'gateway:gone-user:gone-key2', createdAt: ago(HOUR) }],
    };
    const report = await reconcileBackendKeys();
    expect(report.orphansRevoked).toBe(2);
    expect(revoked.sort()).toEqual(['m-orphan', 'r-orphan']);
  });

  it('leaves a key that is only minutes old (its grant may be about to be saved)', async () => {
    upstream.registry = [{ id: 'fresh', label: 'gateway:u1:new-key', createdAt: ago(60_000) }];
    expect((await reconcileBackendKeys()).orphansRevoked).toBe(0);
    expect(revoked).toEqual([]);
  });

  it('never revokes a backend key whose gateway key is still active, even if the grant does not match', async () => {
    seedKey('k-live');
    upstream.registry = [{ id: 'r-x', label: 'gateway:u1:k-live', createdAt: ago(HOUR) }];
    expect((await reconcileBackendKeys()).orphansRevoked).toBe(0);
  });

  it('does revoke one whose gateway key was already revoked', async () => {
    seedKey('k-dead', { revoked: true });
    upstream.registry = [{ id: 'r-y', label: 'gateway:u1:k-dead', createdAt: ago(HOUR) }];
    expect((await reconcileBackendKeys()).orphansRevoked).toBe(1);
    expect(revoked).toEqual(['r-y']);
  });

  it('reports (does not repair) an active grant whose backend key is gone', async () => {
    seedKey('k1', { grants: [['registry_api', 'r1'], ['market_validation_api', 'm1']] });
    upstream = { registry: [], market: [{ id: 'm1', label: 'gateway:u1:k1', createdAt: ago(HOUR) }] };
    const report = await reconcileBackendKeys();
    expect(report.missing).toBe(1);
    expect(fakeDb.gatewayGrants.find((g) => g.service === 'registry_api')!.backend_key_id).toBe('r1');
  });

  it('ignores grants of an already-revoked gateway key when counting missing keys', async () => {
    seedKey('k-dead', { revoked: true, grants: [['registry_api', 'r-dead']] });
    expect((await reconcileBackendKeys()).missing).toBe(0);
  });

  it('a backend that cannot be reached is reported and skipped, not treated as empty', async () => {
    seedKey('k1', { grants: [['registry_api', 'r1'], ['market_validation_api', 'm1']] });
    upstream = { registry: 'down', market: [{ id: 'm1', label: 'gateway:u1:k1', createdAt: ago(HOUR) }] };
    const report = await reconcileBackendKeys();
    expect(report.unreachable).toEqual(['registry_api']);
    expect(report.missing).toBe(0);
    expect(revoked).toEqual([]);
  });
});
