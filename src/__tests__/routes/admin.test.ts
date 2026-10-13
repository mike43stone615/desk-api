import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createFakeDb } from '../helpers/fake-db';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { pool } from '../../db';
import { buildApp } from '../../app';
import type { FastifyInstance } from 'fastify';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;

let app: FastifyInstance;
let adminHeaders: Record<string, string>;
let memberHeaders: Record<string, string>;

beforeAll(async () => {
  app = await buildApp();

  const now = new Date().toISOString();
  fakeDb.users.set('admin-1', {
    id: 'admin-1',
    email: 'admin@example.com', // matches ADMIN_EMAILS set in __tests__/setup.ts
    password_hash: 'x',
    first_name: 'Admin',
    last_name: 'User',
    email_confirmed_at: now,
    created_at: now,
    updated_at: now,
  });
  fakeDb.seedSession('admin-token', {
    id: 'admin-session',
    user_id: 'admin-1',
    token: 'admin-token',
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    created_at: now,
  });
  adminHeaders = { authorization: 'Bearer admin-token' };

  fakeDb.users.set('member-1', {
    id: 'member-1',
    email: 'member@example.com',
    password_hash: 'x',
    first_name: 'Regular',
    last_name: 'Member',
    email_confirmed_at: now,
    created_at: now,
    updated_at: now,
  });
  fakeDb.seedSession('member-token', {
    id: 'member-session',
    user_id: 'member-1',
    token: 'member-token',
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    created_at: now,
  });
  memberHeaders = { authorization: 'Bearer member-token' };
});

describe('admin gating', () => {
  it('returns 401 for GET /admin/tables without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/tables' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for a signed-in user not on the admin allowlist', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/tables', headers: memberHeaders });
    expect(res.statusCode).toBe(403);
  });

  it('returns 200 with the local table list for an allowlisted admin', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/tables', headers: adminHeaders });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const names = body.tables.map((t: { name: string }) => t.name);
    expect(names).toContain('desk.users');
    expect(names).toContain('desk.businesses');
    expect(names).toContain('desk.business_memberships');
  });

  it('does not expose GET /admin/oews/status or POST /admin/oews/import (dropped per spec)', async () => {
    const status = await app.inject({ method: 'GET', url: '/admin/oews/status', headers: adminHeaders });
    expect(status.statusCode).toBe(404);
    const importRes = await app.inject({ method: 'POST', url: '/admin/oews/import', headers: adminHeaders });
    expect(importRes.statusCode).toBe(404);
  });
});

describe('PATCH /admin/tables/desk.users/rows/:id writes a mutation_audit_log entry', () => {
  it('updates an editable field and logs the mutation with the admin actor', async () => {
    const before = fakeDb.mutationAuditLog.length;
    const res = await app.inject({
      method: 'PATCH',
      url: '/admin/tables/desk.users/rows/member-1',
      headers: adminHeaders,
      payload: { values: { first_name: 'Updated' } },
    });
    expect(res.statusCode).toBe(200);
    expect(fakeDb.mutationAuditLog.length).toBe(before + 1);
    const entry = fakeDb.mutationAuditLog[fakeDb.mutationAuditLog.length - 1];
    expect(entry.user_email).toBe('admin@example.com');
    expect(entry.action).toBe('admin_table.update');
    expect(entry.entity_type).toBe('users');
    expect(entry.entity_id).toBe('member-1');
  });

  it('rejects a non-editable column', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/admin/tables/desk.users/rows/member-1',
      headers: adminHeaders,
      payload: { values: { password_hash: 'hacked' } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('owners edit every column; listed administrators keep the per-table lists', () => {
  const tablesFor = async (headers: Record<string, string>) =>
    (await app.inject({ method: 'GET', url: '/admin/tables', headers })).json().tables as Array<{ name: string; primaryKey: string; editableColumns: string[] }>;

  it('an owner is offered every column except a single id column, and the usage tables by their row key', async () => {
    const tables = await tablesFor(adminHeaders); // admin@example.com is on ADMIN_EMAILS: an owner
    const users = tables.find((t) => t.name === 'desk.users')!;
    expect(users.editableColumns).toEqual(expect.arrayContaining(['email', 'first_name', 'email_confirmed_at', 'created_at', 'updated_at']));
    expect(users.editableColumns).not.toContain('id');
    const meter = tables.find((t) => t.name === 'desk.usage_meter')!;
    expect(meter.primaryKey).toBe('_rowKey');
    expect(meter.editableColumns).toEqual(expect.arrayContaining(['quantity', 'month']));
    const calls = tables.find((t) => t.name === 'desk.api_usage')!;
    expect(calls.editableColumns).toContain('calls');
    for (const t of tables.filter((x) => x.name.startsWith('desk.'))) expect(t.editableColumns.length, t.name).toBeGreaterThan(0);
  });

  it('a listed administrator gets the same short lists as before, and cannot edit beyond them', async () => {
    const now = new Date().toISOString();
    fakeDb.users.set('helper-1', { id: 'helper-1', email: 'helper@example.com', password_hash: 'x', first_name: 'H', last_name: 'L', email_confirmed_at: now, created_at: now, updated_at: now });
    fakeDb.seedSession('helper-token', { id: 'helper-session', user_id: 'helper-1', token: 'helper-token', expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now });
    fakeDb.platformAdmins.add('helper-1');
    try {
      const helperHeaders = { authorization: 'Bearer helper-token' };
      const tables = await tablesFor(helperHeaders);
      expect(tables.find((t) => t.name === 'desk.users')!.editableColumns).toEqual(['email', 'first_name', 'last_name']);
      expect(tables.find((t) => t.name === 'desk.usage_meter')!.editableColumns).toEqual([]);
      const refused = await app.inject({ method: 'PATCH', url: '/admin/tables/desk.users/rows/member-1', headers: helperHeaders, payload: { values: { created_at: '2020-01-01T00:00:00Z' } } });
      expect(refused.statusCode).toBe(400);
    } finally {
      fakeDb.platformAdmins.delete('helper-1');
    }
  });

  it('an owner can edit a column outside the old list, and the edit is audited', async () => {
    const before = fakeDb.mutationAuditLog.length;
    const res = await app.inject({ method: 'PATCH', url: '/admin/tables/desk.users/rows/member-1', headers: adminHeaders, payload: { values: { created_at: '2020-01-01T00:00:00Z' } } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().row.created_at).toBe('2020-01-01T00:00:00Z');
    expect(fakeDb.mutationAuditLog.length).toBe(before + 1);
  });

  it('an owner still cannot change a row id', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/admin/tables/desk.users/rows/member-1', headers: adminHeaders, payload: { values: { id: 'someone-else' } } });
    expect(res.statusCode).toBe(400);
  });
});

describe('Registry and Market tables: the owner signal is sent only for an owner', () => {
  it('asks the sibling service with x-desk-admin-owner for an owner, and without it for a listed administrator', async () => {
    const { config } = await import('../../config');
    const saved = { a: config.registryApiUrl, b: config.registryApiAdminKey, c: config.marketApiUrl, d: config.marketApiAdminKey };
    const seen: Array<{ url: string; owner: string | undefined }> = [];
    const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url, owner: init?.headers?.['x-desk-admin-owner'] });
      return new Response(JSON.stringify(url.includes('/rows/') ? { row: { id: 1 } } : { tables: [] }), { status: 200 });
    });
    Object.assign(config, { registryApiUrl: 'http://registry.test', registryApiAdminKey: 'k', marketApiUrl: 'http://market.test', marketApiAdminKey: 'k' });
    vi.stubGlobal('fetch', fetchMock);
    const now = new Date().toISOString();
    fakeDb.users.set('helper-2', { id: 'helper-2', email: 'helper2@example.com', password_hash: 'x', first_name: 'H', last_name: 'L', email_confirmed_at: now, created_at: now, updated_at: now });
    fakeDb.seedSession('helper2-token', { id: 'helper2-session', user_id: 'helper-2', token: 'helper2-token', expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now });
    fakeDb.platformAdmins.add('helper-2');
    try {
      await app.inject({ method: 'GET', url: '/admin/tables', headers: adminHeaders });
      await app.inject({ method: 'PATCH', url: '/admin/tables/registry.state_business_registry_sources/rows/FL', headers: adminHeaders, payload: { values: { notes: 'x' } } });
      expect(seen.length).toBe(3);
      for (const call of seen) expect(call.owner, call.url).toBe('admin@example.com');

      seen.length = 0;
      await app.inject({ method: 'GET', url: '/admin/tables', headers: { authorization: 'Bearer helper2-token' } });
      await app.inject({ method: 'PATCH', url: '/admin/tables/market.import_runs/rows/r1', headers: { authorization: 'Bearer helper2-token' }, payload: { values: { status: 'failed' } } });
      expect(seen.length).toBe(3);
      for (const call of seen) expect(call.owner, call.url).toBeUndefined();
    } finally {
      fakeDb.platformAdmins.delete('helper-2');
      vi.unstubAllGlobals();
      Object.assign(config, { registryApiUrl: saved.a, registryApiAdminKey: saved.b, marketApiUrl: saved.c, marketApiAdminKey: saved.d });
    }
  });
});
