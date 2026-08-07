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
  fakeDb.sessions.set('admin-token', {
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
  fakeDb.sessions.set('member-token', {
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
