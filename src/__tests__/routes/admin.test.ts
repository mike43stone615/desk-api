import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
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

// Tables nobody edits or deletes from here, owners included (secrets-adjacent, or the system's own bookkeeping).
const READ_ONLY_TABLES = ['desk.gateway_api_key_grants', 'desk.oauth_codes', 'desk.payment_methods', 'desk.system_state', 'desk.totp_backup_codes', 'desk.schema_migrations'];

describe('owners edit every column; listed administrators keep the per-table lists', () => {
  const tablesFor = async (headers: Record<string, string>) =>
    (await app.inject({ method: 'GET', url: '/admin/tables', headers })).json().tables as Array<{ name: string; primaryKey: string; columns: string[]; editableColumns: string[]; deletable: boolean }>;

  it('an owner is offered every column except a single id column, and the usage tables by their row key', async () => {
    const tables = await tablesFor(adminHeaders); // admin@example.com is on ADMIN_EMAILS: an owner
    const users = tables.find((t) => t.name === 'desk.users')!;
    expect(users.editableColumns).toEqual(['email', 'first_name', 'last_name', 'email_confirmed_at', 'totp_enabled_at']); // created/updated stay locked, owners too
    expect(users.editableColumns).not.toContain('id');
    const meter = tables.find((t) => t.name === 'desk.usage_meter')!;
    expect(meter.primaryKey).toBe('_rowKey');
    expect(meter.editableColumns).toEqual(['quantity']); // whose count, which month and what is counted are keys: locked
    const calls = tables.find((t) => t.name === 'desk.api_usage')!;
    expect(calls.editableColumns).toContain('calls');
    // read-only here (platform_admins is changed in "Who has access"; the rest are logs, secrets-adjacent or system bookkeeping)
    const audit = ['desk.mutation_audit_log', 'desk.security_events', 'desk.platform_admins', ...READ_ONLY_TABLES];
    // can be deleted or acted on, but no column is for editing
    const noEdit = ['desk.gateway_key_shares', 'desk.idempotency_keys', 'desk.mfa_pending_logins', 'desk.status_subscribers', 'desk.webhook_deliveries'];
    for (const t of tables.filter((x) => x.name.startsWith('desk.') && !audit.includes(x.name) && !noEdit.includes(x.name))) expect(t.editableColumns.length, t.name).toBeGreaterThan(0);
    for (const name of noEdit) expect(tables.find((t) => t.name === name)!.editableColumns, name).toEqual([]);
    // the audit record stays read-only, even for an owner
    for (const name of audit) expect(tables.find((t) => t.name === name)!.editableColumns, name).toEqual([]);
  });

  it('owners and listed administrators can delete rows of every table but the audit tables', async () => {
    const tables = await tablesFor(adminHeaders);
    for (const t of tables.filter((x) => x.name.startsWith('desk.'))) {
      expect(t.deletable, t.name).toBe(!['desk.mutation_audit_log', 'desk.security_events', 'desk.platform_admins', 'desk.invoices', ...READ_ONLY_TABLES].includes(t.name));
    }
    const refused = await app.inject({ method: 'DELETE', url: '/admin/tables/desk.security_events/rows/any-row', headers: adminHeaders });
    expect(refused.statusCode).toBe(403);
    const now = new Date().toISOString();
    fakeDb.users.set('helper-2', { id: 'helper-2', email: 'helper2@example.com', password_hash: 'x', first_name: 'H', last_name: 'L', email_confirmed_at: now, created_at: now, updated_at: now });
    fakeDb.seedSession('helper2-token', { id: 'helper2-session', user_id: 'helper-2', token: 'helper2-token', expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now });
    fakeDb.platformAdmins.add('helper-2');
    try {
      const helper = { authorization: 'Bearer helper2-token' };
      const list = await tablesFor(helper);
      expect(list.find((t) => t.name === 'desk.plans')!.deletable).toBe(true);
      expect(list.find((t) => t.name === 'desk.users')!.deletable).toBe(true);
      expect(list.find((t) => t.name === 'desk.security_events')!.deletable).toBe(false); // the audit record stays read-only for everyone
      expect((await app.inject({ method: 'DELETE', url: '/admin/tables/desk.security_events/rows/x', headers: helper })).statusCode).toBe(403);
    } finally {
      fakeDb.platformAdmins.delete('helper-2');
    }
  });

  it('an owner cannot edit the audit tables', async () => {
    for (const table of ['mutation_audit_log', 'security_events']) {
      const res = await app.inject({ method: 'PATCH', url: `/admin/tables/desk.${table}/rows/any-row`, headers: adminHeaders, payload: { values: { ip_address: '0.0.0.0', created_at: '2020-01-01T00:00:00Z' } } });
      expect(res.statusCode, table).toBe(400);
    }
  });

  it('a listed administrator edits the same columns an owner does, and still cannot touch locked ones', async () => {
    const now = new Date().toISOString();
    fakeDb.users.set('helper-1', { id: 'helper-1', email: 'helper@example.com', password_hash: 'x', first_name: 'H', last_name: 'L', email_confirmed_at: now, created_at: now, updated_at: now });
    fakeDb.seedSession('helper-token', { id: 'helper-session', user_id: 'helper-1', token: 'helper-token', expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now });
    fakeDb.platformAdmins.add('helper-1');
    try {
      const helperHeaders = { authorization: 'Bearer helper-token' };
      const tables = await tablesFor(helperHeaders);
      expect(tables.find((t) => t.name === 'desk.users')!.editableColumns).toEqual(['email', 'first_name', 'last_name', 'email_confirmed_at', 'totp_enabled_at']);
      expect(tables.find((t) => t.name === 'desk.usage_meter')!.editableColumns.length).toBeGreaterThan(0);
      const refused = await app.inject({ method: 'PATCH', url: '/admin/tables/desk.users/rows/member-1', headers: helperHeaders, payload: { values: { created_at: '2020-01-01T00:00:00Z' } } });
      expect(refused.statusCode).toBe(400);
    } finally {
      fakeDb.platformAdmins.delete('helper-1');
    }
  });

  it('locked columns cannot be edited by anyone, owners included; the unlocked ones can, and the edit is audited', async () => {
    const tables = await tablesFor(adminHeaders);
    const editable = (name: string) => tables.find((t) => t.name === `desk.${name}`)!.editableColumns;
    expect(editable('sessions')).toEqual(['expires_at']);
    expect(editable('email_tokens')).toEqual(['expires_at', 'used_at']);
    expect(editable('business_setup_drafts')).toContain('formation_state');
    expect(editable('business_setup_drafts')).not.toContain('draft_json');
    const locked = await app.inject({ method: 'PATCH', url: '/admin/tables/desk.users/rows/member-1', headers: adminHeaders, payload: { values: { created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z' } } });
    expect(locked.statusCode).toBe(400);
    const before = fakeDb.mutationAuditLog.length;
    const res = await app.inject({ method: 'PATCH', url: '/admin/tables/desk.users/rows/member-1', headers: adminHeaders, payload: { values: { first_name: 'Renamed' } } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().row.first_name).toBe('Renamed');
    expect(fakeDb.mutationAuditLog.length).toBe(before + 1);
  });

  it('the plans table no longer shows descriptions, and businesses no longer show a user id', async () => {
    const tables = await tablesFor(adminHeaders);
    expect(tables.find((t) => t.name === 'desk.plans')!.columns).not.toContain('description');
    const biz = tables.find((t) => t.name === 'desk.businesses')!;
    expect(biz.columns).not.toContain('user_id'); // who belongs is in Business memberships
    expect(biz.columns).toContain('formation_state');
    expect(biz.columns).not.toContain('business_json');
    expect(biz.editableColumns).toContain('legal_entity');
    expect(biz.editableColumns).not.toContain('user_id');
    expect(biz.editableColumns).not.toContain('created_at');
  });

  it('an owner still cannot change a row id', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/admin/tables/desk.users/rows/member-1', headers: adminHeaders, payload: { values: { id: 'someone-else' } } });
    expect(res.statusCode).toBe(400);
  });
});

describe('Registry and Market tables: the signed-in person signal is sent for owners and listed administrators', () => {
  it('asks the sibling service with x-desk-admin-owner for an owner and for a listed administrator alike', async () => {
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
      for (const call of seen) expect(call.owner, call.url).toBe('helper2@example.com');
    } finally {
      fakeDb.platformAdmins.delete('helper-2');
      vi.unstubAllGlobals();
      Object.assign(config, { registryApiUrl: saved.a, registryApiAdminKey: saved.b, marketApiUrl: saved.c, marketApiAdminKey: saved.d });
    }
  });

  it('a delete is sent with no JSON content type (an empty JSON body was refused), and the backend reason comes back', async () => {
    const { config } = await import('../../config');
    const saved = { a: config.registryApiUrl, b: config.registryApiAdminKey };
    const calls: Array<{ method?: string; headers?: Record<string, string>; body?: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
      calls.push(init ?? {});
      return init?.method === 'DELETE' && String(_url).endsWith('/rows/gone')
        ? new Response(JSON.stringify({ statusCode: 404, message: 'Row not found.' }), { status: 404 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
    Object.assign(config, { registryApiUrl: 'http://registry.test', registryApiAdminKey: 'k' });
    try {
      const ok = await app.inject({ method: 'DELETE', url: '/admin/tables/registry.business_name_registry_sync_runs/rows/7', headers: adminHeaders });
      expect(ok.statusCode).toBe(200);
      expect(calls[0].method).toBe('DELETE');
      expect(calls[0].body).toBeUndefined();
      expect(Object.keys(calls[0].headers ?? {}).map((h) => h.toLowerCase())).not.toContain('content-type');
      const gone = await app.inject({ method: 'DELETE', url: '/admin/tables/registry.business_name_registry_sync_runs/rows/gone', headers: adminHeaders });
      expect(gone.statusCode).toBe(404);
      expect(gone.json().detail).toBe('Row not found.');
    } finally {
      vi.unstubAllGlobals();
      Object.assign(config, { registryApiUrl: saved.a, registryApiAdminKey: saved.b });
    }
  });
});

describe('POST /admin/tables/:table/rows adds a row by hand (owners only)', () => {
  type Insert = { table: string; names: string[]; values: Record<string, unknown> };
  let inserts: Insert[] = [];
  let spy: { mockRestore: () => void } | undefined;
  const plansTaken = new Set<string>();

  const install = () => {
    inserts = [];
    // The fake database's query is already a mock: put a wrapper in front of its implementation, and put that back after.
    const q = fakeDb.query as unknown as { getMockImplementation: () => (sql: string, params?: unknown[]) => Promise<unknown>; mockImplementation: (fn: unknown) => void };
    const original = q.getMockImplementation();
    q.mockImplementation((async (sql: string, params: unknown[] = []) => {
      const text = String(sql);
      const m = /^INSERT INTO "([a-z_]+)" \((.+?)\) VALUES/.exec(text);
      if (m) {
        const names = m[2].split(', ').map((n) => n.replace(/"/g, ''));
        const values = Object.fromEntries(names.map((n, i) => [n, params[i]]));
        inserts.push({ table: m[1], names, values });
        // Like the real database: only the columns after RETURNING come back
        const returning = /RETURNING (.+)$/.exec(text)?.[1].split(', ').map((n) => n.replace(/"/g, '')) ?? names;
        return { rows: [Object.fromEntries(returning.map((n) => [n, values[n] ?? null]))], rowCount: 1 };
      }
      if (text.startsWith('SELECT 1 FROM plans WHERE id')) {
        const taken = plansTaken.has(String(params[0]));
        return { rows: taken ? [{ '?column?': 1 }] : [], rowCount: taken ? 1 : 0 };
      }
      return original(sql, params);
    }) as never);
    spy = { mockRestore: () => q.mockImplementation(original) };
  };
  const post = (table: string, values: Record<string, unknown>, headers = adminHeaders) =>
    app.inject({ method: 'POST', url: `/admin/tables/${table}/rows`, headers, payload: { values } });

  it('only an owner is offered "Add row", and only where a hand-made row is safe', async () => {
    const tables = (await app.inject({ method: 'GET', url: '/admin/tables', headers: adminHeaders })).json().tables as Array<{ name: string; createColumns?: string[]; requiredColumns?: string[]; generatedColumns?: Record<string, string> }>;
    const incidents = tables.find((t) => t.name === 'desk.incidents')!;
    expect(incidents.createColumns).toEqual(['title', 'severity', 'status', 'resolved_at']);
    expect(incidents.requiredColumns).toEqual(['title', 'severity', 'status']);
    expect(Object.keys(incidents.generatedColumns ?? {})).toEqual(['id', 'started_at']);
    for (const name of ['desk.sessions', 'desk.email_tokens', 'desk.business_setup_drafts', 'desk.businesses', 'desk.webhook_endpoints', 'desk.webhook_deliveries', 'desk.oauth_clients', 'desk.gateway_api_keys', 'desk.platform_admins', 'desk.mutation_audit_log', 'desk.security_events']) {
      expect(tables.find((t) => t.name === name)!.createColumns, name).toBeUndefined();
    }
  });

  it('adds an incident, making the ID itself', async () => {
    install();
    try {
      const res = await post('desk.incidents', { title: 'Search is slow', severity: 'minor', status: 'investigating' });
      expect(res.statusCode).toBe(201);
      expect(inserts).toHaveLength(1);
      expect(inserts[0].table).toBe('incidents');
      expect(String(inserts[0].values.id)).toMatch(/^[0-9a-f-]{36}$/);
      expect(inserts[0].names).not.toContain('started_at'); // the database fills in the time
      expect(inserts[0].names).not.toContain('resolved_at'); // left empty: no value
      expect(res.json().row.title).toBe('Search is slow');
    } finally {
      spy?.mockRestore();
    }
  });

  it('refuses a missing required field, a value outside the choices, and invalid JSON, saving nothing', async () => {
    install();
    try {
      const missing = await post('desk.incidents', { severity: 'minor', status: 'investigating' });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().detail).toContain('title is required');
      const choice = await post('desk.incidents', { title: 'x', severity: 'huge', status: 'investigating' });
      expect(choice.statusCode).toBe(400);
      expect(choice.json().detail).toContain('severity must be one of');
      const json = await post('desk.invoices', { subject_type: 'user', subject_id: 'u1', plan_id: 'free', period_start: '2026-10-01', period_end: '2026-11-01', lines: '{oops' });
      expect(json.statusCode).toBe(400);
      expect(json.json().detail).toContain('lines needs valid JSON');
      expect(inserts).toHaveLength(0);
    } finally {
      spy?.mockRestore();
    }
  });

  it('makes a plan ID from its name (a new one when that is taken), and adds an invoice up from its lines', async () => {
    install();
    plansTaken.add('team-plus');
    try {
      const plan = await post('desk.plans', { name: 'Team Plus' });
      expect(plan.statusCode).toBe(201);
      expect(inserts[0].values.id).toBe('team-plus-2');
      const invoice = await post('desk.invoices', {
        subject_type: 'user', subject_id: 'u1', plan_id: 'free', period_start: '2026-10-01', period_end: '2026-11-01',
        lines: JSON.stringify([{ description: 'a', quantity: 1, unitCents: 100, totalCents: 100 }, { description: 'b', quantity: 2, unitCents: 50, totalCents: 100 }]),
      });
      expect(invoice.statusCode).toBe(201);
      expect(inserts[1].values.subtotal_cents).toBe(200);
      expect(inserts[1].names).not.toContain('number'); // the database hands out the next invoice number
    } finally {
      plansTaken.clear();
      spy?.mockRestore();
    }
  });

  it('adds a user in the "needs a new password" state and emails them a confirmation link and a password link', async () => {
    install();
    const { authService } = await import('../../infrastructure/auth');
    const confirm = vi.spyOn(authService, 'requestEmailConfirmation').mockResolvedValue('confirm-token');
    const reset = vi.spyOn(authService, 'requestPasswordReset').mockResolvedValue('reset-token');
    try {
      const res = await post('desk.users', { email: '  New.Person@Example.com ', first_name: ' New ', last_name: 'Person' });
      expect(res.statusCode, res.body).toBe(201);
      expect(inserts[0].values.email).toBe('new.person@example.com'); // trimmed and lower case, as sign-up stores it
      expect(inserts[0].values.first_name).toBe('New');
      expect(inserts[0].values.password_hash).toBe('NEEDS_RESET'); // sign-in then says a new password is needed
      expect(res.json().row.password_hash).toBeUndefined(); // the stored text is never sent back
      expect(res.json().notice).toContain('We emailed new.person@example.com');
      expect(confirm).toHaveBeenCalledWith('new.person@example.com');
      expect(reset).toHaveBeenCalledWith('new.person@example.com');
    } finally {
      confirm.mockRestore();
      reset.mockRestore();
      spy?.mockRestore();
    }
  });

  it('says so when the emails could not be sent, and still makes the account', async () => {
    install();
    const { authService } = await import('../../infrastructure/auth');
    const confirm = vi.spyOn(authService, 'requestEmailConfirmation').mockRejectedValue(new Error('mail is down'));
    try {
      const res = await post('desk.users', { email: 'quiet@example.com', first_name: 'Q', last_name: 'T' });
      expect(res.statusCode).toBe(201);
      expect(res.json().notice).toContain('could not be sent');
      expect(inserts).toHaveLength(1);
    } finally {
      confirm.mockRestore();
      spy?.mockRestore();
    }
  });

  it('refuses a bad email, name or duplicate with the sign-up page\'s own messages, saving nothing', async () => {
    install();
    try {
      const empty = await post('desk.users', { first_name: 'A', last_name: 'B' });
      expect(empty.statusCode).toBe(400);
      expect(empty.json().detail).toContain('is required'); // the add form itself says "Enter your email." first (see the library UI)
      const invalid = await post('desk.users', { email: 'not-an-email', first_name: 'A', last_name: 'B' });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().detail).toContain('email must be a valid email address');
      const long = await post('desk.users', { email: `${'a'.repeat(250)}@example.com`, first_name: 'A', last_name: 'B' });
      expect(long.statusCode).toBe(400);
      expect(long.json().detail).toContain('email must be at most 254 characters');
      const noName = await post('desk.users', { email: 'ok@example.com', first_name: ' ', last_name: 'B' });
      expect(noName.statusCode).toBe(400);
      fakeDb.users.set('dup-1', { id: 'dup-1', email: 'taken@example.com', password_hash: 'x', first_name: 'T', last_name: 'T', email_confirmed_at: null, created_at: 'x', updated_at: 'x' });
      const dup = await post('desk.users', { email: 'Taken@Example.com', first_name: 'A', last_name: 'B' });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().detail).toBe('An account with this email already exists.');
      expect(inserts).toHaveLength(0);
    } finally {
      fakeDb.users.delete('dup-1');
      spy?.mockRestore();
    }
  });

  it('refuses tables the system must make itself', async () => {
    install();
    try {
      for (const table of ['desk.sessions', 'desk.gateway_api_keys', 'desk.security_events']) {
        const res = await post(table, { id: 'x' });
        expect(res.statusCode, table).toBe(403);
      }
      const now = new Date().toISOString();
      fakeDb.users.set('helper-3', { id: 'helper-3', email: 'helper3@example.com', password_hash: 'x', first_name: 'H', last_name: 'L', email_confirmed_at: now, created_at: now, updated_at: now });
      fakeDb.seedSession('helper3-token', { id: 'helper3-session', user_id: 'helper-3', token: 'helper3-token', expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now });
      fakeDb.platformAdmins.add('helper-3');
      try {
        const res = await post('desk.incidents', { title: 'x', severity: 'minor', status: 'investigating' }, { authorization: 'Bearer helper3-token' });
        expect(res.statusCode).toBe(201);
        const list = (await app.inject({ method: 'GET', url: '/admin/tables', headers: { authorization: 'Bearer helper3-token' } })).json().tables as Array<{ name: string; createColumns?: string[] }>;
        expect(list.some((t) => t.createColumns), 'a listed administrator is offered Add row').toBe(true);
      } finally {
        fakeDb.platformAdmins.delete('helper-3');
      }
      expect(inserts).toHaveLength(1); // only the administrator's own allowed add
    } finally {
      spy?.mockRestore();
    }
  });
});

describe('Registry and Market tables: adding a row is passed to the sibling service, for an owner only', () => {
  it('sends the POST with the owner signal and the typed values, and gives the service answer back', async () => {
    const { config } = await import('../../config');
    const saved = { a: config.registryApiUrl, b: config.registryApiAdminKey };
    const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      calls.push({ url, ...init });
      return new Response(JSON.stringify({ row: { id: 'new' } }), { status: 201 });
    }));
    Object.assign(config, { registryApiUrl: 'http://registry.test', registryApiAdminKey: 'k' });
    try {
      const res = await app.inject({ method: 'POST', url: '/admin/tables/registry.business_name_registry_entries/rows', headers: adminHeaders, payload: { values: { entity_name: 'Sunrise Coffee LLC' } } });
      expect(res.statusCode).toBe(201);
      expect(res.json().row.id).toBe('new');
      expect(calls[0].url).toBe('http://registry.test/admin/tables/business_name_registry_entries/rows');
      expect(calls[0].method).toBe('POST');
      expect(calls[0].headers?.['x-desk-admin-owner']).toBe('admin@example.com');
      expect(JSON.parse(String(calls[0].body))).toEqual({ values: { entity_name: 'Sunrise Coffee LLC' } });

      // a listed administrator reaches the service too, with their own address in the signal
      calls.length = 0;
      const now = new Date().toISOString();
      fakeDb.users.set('helper-4', { id: 'helper-4', email: 'helper4@example.com', password_hash: 'x', first_name: 'H', last_name: 'L', email_confirmed_at: now, created_at: now, updated_at: now });
      fakeDb.seedSession('helper4-token', { id: 'helper4-session', user_id: 'helper-4', token: 'helper4-token', expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now });
      fakeDb.platformAdmins.add('helper-4');
      try {
        const added = await app.inject({ method: 'POST', url: '/admin/tables/registry.business_name_registry_entries/rows', headers: { authorization: 'Bearer helper4-token' }, payload: { values: { entity_name: 'X LLC' } } });
        expect(added.statusCode).toBe(201);
        expect(calls[0].headers?.['x-desk-admin-owner']).toBe('helper4@example.com');
      } finally {
        fakeDb.platformAdmins.delete('helper-4');
      }
    } finally {
      vi.unstubAllGlobals();
      Object.assign(config, { registryApiUrl: saved.a, registryApiAdminKey: saved.b });
    }
  });
});

describe('Users: owners can set email confirmed and two-factor; every edit stamps updated_at', () => {
  const patch = (id: string, values: Record<string, unknown>, headers = adminHeaders) =>
    app.inject({ method: 'PATCH', url: `/admin/tables/desk.users/rows/${id}`, headers, payload: { values } });

  it('an owner sets email_confirmed_at to a date (stored the way the system writes it) and clears it with an empty value', async () => {
    const set = await patch('member-1', { email_confirmed_at: '2026-10-21 09:30:15' });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().row.email_confirmed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const cleared = await patch('member-1', { email_confirmed_at: '' });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().row.email_confirmed_at).toBeNull();
    expect((await patch('member-1', { email_confirmed_at: 'next tuesday-ish' })).statusCode).toBe(400);
    await patch('member-1', { email_confirmed_at: new Date().toISOString() });
  });

  it('two-factor can be switched off (empty) but not on from here, because it needs the person\'s own secret', async () => {
    const off = await patch('member-1', { totp_enabled_at: '' });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().row.totp_enabled_at).toBeNull();
    const on = await patch('member-1', { totp_enabled_at: '2026-10-21T12:00:00Z' });
    expect(on.statusCode).toBe(400);
    expect(on.json().detail).toContain('Two-factor cannot be switched on here');
  });

  it('a listed administrator can set both columns too', async () => {
    const now = new Date().toISOString();
    fakeDb.users.set('helper-5', { id: 'helper-5', email: 'helper5@example.com', password_hash: 'x', first_name: 'H', last_name: 'L', email_confirmed_at: now, created_at: now, updated_at: now });
    fakeDb.seedSession('helper5-token', { id: 'helper5-session', user_id: 'helper-5', token: 'helper5-token', expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now });
    fakeDb.platformAdmins.add('helper-5');
    try {
      const res = await patch('member-1', { email_confirmed_at: now, totp_enabled_at: '' }, { authorization: 'Bearer helper5-token' });
      expect(res.statusCode, res.body).toBe(200);
    } finally {
      fakeDb.platformAdmins.delete('helper-5');
    }
  });

  it('an edit made here stamps updated_at, on every table that has the column', async () => {
    const q = fakeDb.query as unknown as { getMockImplementation: () => (sql: string, params?: unknown[]) => Promise<unknown>; mockImplementation: (fn: unknown) => void };
    const original = q.getMockImplementation();
    const updates: string[] = [];
    q.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (String(sql).startsWith('UPDATE "')) updates.push(String(sql));
      return original(sql, params);
    });
    try {
      await patch('member-1', { first_name: 'Stamped' });
      const users = updates.find((u) => u.startsWith('UPDATE "users"'))!;
      expect(users).toContain(`"updated_at" = to_char(now() AT TIME ZONE 'UTC'`);
    } finally {
      q.mockImplementation(original);
    }
  });
});

describe('Users-related tables: suspensions are managed here, platform admins are read-only', () => {
  it('platform_admins can be viewed but not edited, added to or deleted, even by an owner', async () => {
    const tables = (await app.inject({ method: 'GET', url: '/admin/tables', headers: adminHeaders })).json().tables as Array<{ name: string; editableColumns: string[]; deletable: boolean; createColumns?: string[]; columns: string[] }>;
    const t = tables.find((x) => x.name === 'desk.platform_admins')!;
    expect(t.columns).toEqual(['user_id', 'person_name', 'role', 'note', 'added_by_email', 'added_at', 'promoted_by_email', 'promoted_at']);
    expect(t.editableColumns).toEqual([]);
    expect(t.deletable).toBe(false);
    expect(t.createColumns).toBeUndefined();
    expect((await app.inject({ method: 'DELETE', url: '/admin/tables/desk.platform_admins/rows/member-1', headers: adminHeaders })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/admin/tables/desk.platform_admins/rows', headers: adminHeaders, payload: { values: { user_id: 'member-1' } } })).statusCode).toBe(403);
  });

  it('a suspension is added with the signed-in owner recorded as who suspended, and only the reason can be edited', async () => {
    const q = fakeDb.query as unknown as { getMockImplementation: () => (sql: string, params?: unknown[]) => Promise<unknown>; mockImplementation: (fn: unknown) => void };
    const original = q.getMockImplementation();
    let insert: { sql: string; params: unknown[] } | null = null;
    q.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (String(sql).startsWith('INSERT INTO "account_suspensions"')) { insert = { sql: String(sql), params }; return { rows: [{ user_id: params[0], suspended_at: 'now', reason: params[1] ?? '', suspended_by: params[2] }], rowCount: 1 }; }
      return original(sql, params);
    });
    try {
      const tables = (await app.inject({ method: 'GET', url: '/admin/tables', headers: adminHeaders })).json().tables as Array<{ name: string; editableColumns: string[]; createColumns?: string[]; deletable: boolean }>;
      const t = tables.find((x) => x.name === 'desk.account_suspensions')!;
      expect(t.editableColumns).toEqual(['reason']);
      expect(t.createColumns).toEqual(['user_id', 'reason']);
      expect(t.deletable).toBe(true);
      const res = await app.inject({ method: 'POST', url: '/admin/tables/desk.account_suspensions/rows', headers: adminHeaders, payload: { values: { user_id: 'member-1', reason: 'Abuse report' } } });
      expect(res.statusCode, res.body).toBe(201);
      expect(insert!.params).toEqual(['member-1', 'Abuse report', 'admin@example.com']);
      expect(insert!.sql.split(' VALUES')[0]).not.toContain('suspended_at'); // the database fills in the time
    } finally {
      q.mockImplementation(original);
    }
  });
});

describe("deleting a person's account lists what else goes first", () => {
  it('counts, for that person, what is deleted with the account and what stays', async () => {
    const q = fakeDb.query as unknown as { getMockImplementation: () => (sql: string, params?: unknown[]) => Promise<unknown>; mockImplementation: (fn: unknown) => void };
    const original = q.getMockImplementation();
    const asked: unknown[][] = [];
    q.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const text = String(sql);
      if (text.startsWith('SELECT COUNT(*) AS n FROM')) {
        asked.push(params);
        if (text.includes('FROM sessions')) return { rows: [{ n: '3' }] };
        if (text.includes('FROM gateway_api_keys')) return { rows: [{ n: '2' }] };
        if (text.includes('FROM invoices')) return { rows: [{ n: '7' }] };
        if (text.includes('FROM payment_methods')) throw new Error('relation does not exist'); // skipped, never an error
        return { rows: [{ n: '0' }] };
      }
      return original(sql, params);
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/users/member-1/delete-impact', headers: adminHeaders });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as { goes: Array<{ label: string; count: number }>; stays: Array<{ label: string; count: number }> };
      expect(body.goes).toEqual([
        { label: 'sign-in sessions', count: 3 },
        { label: 'API keys (ended first, so they stop working at once)', count: 2 },
      ]);
      expect(body.stays).toEqual([{ label: 'invoices', count: 7 }]);
      expect(asked.every((p) => p[0] === 'member-1')).toBe(true);
      expect((await app.inject({ method: 'GET', url: '/admin/users/member-1/delete-impact' })).statusCode).toBe(401);
    } finally {
      q.mockImplementation(original);
    }
  });
});

describe('the tables the Administration page did not show before', () => {
  const tables = async () => (await app.inject({ method: 'GET', url: '/admin/tables', headers: adminHeaders })).json().tables as Array<{ name: string; columns: string[]; editableColumns: string[]; deletable: boolean; createColumns?: string[]; primaryKey: string }>;
  const NEW_TABLES = ['business_email_invites', 'email_outbox', 'email_suppressions', 'gateway_api_key_grants', 'gateway_backend_key_revocations', 'gateway_key_shares', 'gateway_key_usage', 'idempotency_keys', 'key_suspensions', 'mfa_pending_logins', 'oauth_codes', 'oauth_tokens', 'payment_methods', 'status_subscribers', 'system_state', 'totp_backup_codes', 'schema_migrations'];

  it('all 17 are listed', async () => {
    const names = (await tables()).map((t) => t.name);
    for (const t of NEW_TABLES) expect(names, t).toContain(`desk.${t}`);
  });

  it('never show a secret, a hash, a token, a stored answer or the body of an email', async () => {
    const forbidden = ['html', 'text_body', 'token_hash', 'access_hash', 'refresh_hash', 'previous_refresh_hash', 'code_challenge', 'encrypted_backend_key', 'request_hash', 'response_body', 'confirm_token_hash', 'unsubscribe_token', 'code_hash_secret', 'provider_ref'];
    for (const t of (await tables()).filter((x) => NEW_TABLES.includes(x.name.replace('desk.', '')))) {
      for (const c of forbidden) expect(t.columns, `${t.name} must not show ${c}`).not.toContain(c);
    }
  });

  it('can be changed only where that is safe: suppressions, key suspensions, retries, revoking an app', async () => {
    const list = await tables();
    const get = (n: string) => list.find((t) => t.name === `desk.${n}`)!;
    expect(get('email_suppressions').editableColumns).toEqual(['reason']);
    expect(get('key_suspensions').editableColumns).toEqual(['reason']);
    expect(get('email_outbox').editableColumns).toEqual(['attempts', 'next_attempt_at']);
    expect(get('gateway_backend_key_revocations').editableColumns).toEqual(['attempts']);
    expect(get('oauth_tokens').editableColumns).toEqual(['revoked_at']);
    expect(get('business_email_invites').editableColumns).toEqual(['role']);
    for (const n of ['gateway_api_key_grants', 'oauth_codes', 'payment_methods', 'system_state', 'totp_backup_codes', 'schema_migrations']) {
      expect(get(n).editableColumns, n).toEqual([]);
      expect(get(n).deletable, n).toBe(false);
    }
  });

  it('offer "Add row" only for email suppressions and key suspensions', async () => {
    const withAdd = (await tables()).filter((t) => NEW_TABLES.includes(t.name.replace('desk.', '')) && t.createColumns).map((t) => t.name).sort();
    expect(withAdd).toEqual(['desk.email_suppressions', 'desk.key_suspensions']);
  });

  it('an address added to the suppression list is checked like a sign-up address and stored lower case', async () => {
    const q = fakeDb.query as unknown as { getMockImplementation: () => (sql: string, params?: unknown[]) => Promise<unknown>; mockImplementation: (fn: unknown) => void };
    const original = q.getMockImplementation();
    const inserts: unknown[][] = [];
    q.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (String(sql).startsWith('INSERT INTO "email_suppressions"')) { inserts.push(params); return { rows: [{ email: params[0], reason: params[1], created_at: 'now' }], rowCount: 1 }; }
      return original(sql, params);
    });
    try {
      const bad = await app.inject({ method: 'POST', url: '/admin/tables/desk.email_suppressions/rows', headers: adminHeaders, payload: { values: { email: 'not-an-email', reason: 'bounced' } } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().detail).toContain('email must be a valid email address');
      const ok = await app.inject({ method: 'POST', url: '/admin/tables/desk.email_suppressions/rows', headers: adminHeaders, payload: { values: { email: '  Blocked@Example.COM ', reason: 'complained' } } });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(inserts).toEqual([['blocked@example.com', 'complained']]);
    } finally {
      q.mockImplementation(original);
    }
  });

  it('suspending a key records the signed-in owner, like suspending an account', async () => {
    const q = fakeDb.query as unknown as { getMockImplementation: () => (sql: string, params?: unknown[]) => Promise<unknown>; mockImplementation: (fn: unknown) => void };
    const original = q.getMockImplementation();
    let params: unknown[] = [];
    q.mockImplementation(async (sql: string, p: unknown[] = []) => {
      if (String(sql).startsWith('INSERT INTO "key_suspensions"')) { params = p; return { rows: [{ api_key_id: p[0], suspended_at: 'now', reason: p[1], suspended_by: p[2] }], rowCount: 1 }; }
      return original(sql, p);
    });
    try {
      const res = await app.inject({ method: 'POST', url: '/admin/tables/desk.key_suspensions/rows', headers: adminHeaders, payload: { values: { api_key_id: 'key-1', reason: 'Abuse' } } });
      expect(res.statusCode, res.body).toBe(201);
      expect(params).toEqual(['key-1', 'Abuse', 'admin@example.com']);
    } finally {
      q.mockImplementation(original);
    }
  });

  it('an edit stamps updated_at in the column\'s own kind (text in most tables, a real timestamp in a few)', async () => {
    // system_state is read-only, so check the rule on the pure pieces: the text kind is what users use
    const q = fakeDb.query as unknown as { getMockImplementation: () => (sql: string, params?: unknown[]) => Promise<unknown>; mockImplementation: (fn: unknown) => void };
    const original = q.getMockImplementation();
    const updates: string[] = [];
    q.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (String(sql).startsWith('UPDATE "users"')) updates.push(String(sql));
      return original(sql, params);
    });
    try {
      await app.inject({ method: 'PATCH', url: '/admin/tables/desk.users/rows/member-1', headers: adminHeaders, payload: { values: { first_name: 'Kind' } } });
      expect(updates[0]).toContain(`"updated_at" = to_char(now() AT TIME ZONE 'UTC'`);
    } finally {
      q.mockImplementation(original);
    }
  });
});

describe('Sessions: who signed in is shown, and active or expired is worked out', () => {
  type Mock = { getMockImplementation: () => (sql: string, params?: unknown[]) => Promise<unknown>; mockImplementation: (fn: unknown) => void };
  const q = () => fakeDb.query as unknown as Mock;
  const row = { id: 's1', user_id: 'u1', status: 'active', expires_at: '2099-01-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z', user_agent: 'Firefox', ip: '203.0.113.9', last_used_at: '2026-10-20T00:00:00Z' };

  it('shows user agent, address, last used and status; only expires_at is editable, for owners and administrators alike', async () => {
    const asOwner = (await app.inject({ method: 'GET', url: '/admin/tables', headers: adminHeaders })).json().tables as Array<{ name: string; columns: string[]; editableColumns: string[] }>;
    const sessions = asOwner.find((t) => t.name === 'desk.sessions')!;
    expect(sessions.columns).toEqual(['id', 'user_id', 'person_name', 'status', 'expires_at', 'created_at', 'user_agent', 'ip', 'last_used_at']);
    expect(sessions.columns).not.toContain('token');
    expect(sessions.editableColumns).toEqual(['expires_at']);

    const now = new Date().toISOString();
    fakeDb.users.set('helper-6', { id: 'helper-6', email: 'helper6@example.com', password_hash: 'x', first_name: 'H', last_name: 'L', email_confirmed_at: now, created_at: now, updated_at: now });
    fakeDb.seedSession('helper6-token', { id: 'helper6-session', user_id: 'helper-6', token: 'helper6-token', expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now });
    fakeDb.platformAdmins.add('helper-6');
    try {
      const helper = { authorization: 'Bearer helper6-token' };
      const asAdmin = (await app.inject({ method: 'GET', url: '/admin/tables', headers: helper })).json().tables as Array<{ name: string; editableColumns: string[] }>;
      expect(asAdmin.find((t) => t.name === 'desk.sessions')!.editableColumns).toEqual(['expires_at']);
      // ...and both can really end a session
      const original = q().getMockImplementation();
      const updates: string[] = [];
      q().mockImplementation(async (sql: string, params?: unknown[]) => {
        const text = String(sql);
        if (text.includes('FROM "sessions" WHERE "id"')) return { rows: [row] };
        if (text.startsWith('UPDATE "sessions"')) { updates.push(text); return { rows: [{ ...row, expires_at: '2020-01-01T00:00:00Z', status: 'expired' }] }; }
        return original(sql, params);
      });
      try {
        for (const headers of [adminHeaders, helper]) {
          const res = await app.inject({ method: 'PATCH', url: '/admin/tables/desk.sessions/rows/s1', headers, payload: { values: { expires_at: '2020-01-01T00:00:00Z' } } });
          expect(res.statusCode, res.body).toBe(200);
          expect(res.json().row.status).toBe('expired');
        }
        expect(updates).toHaveLength(2);
        const refused = await app.inject({ method: 'PATCH', url: '/admin/tables/desk.sessions/rows/s1', headers: adminHeaders, payload: { values: { ip: '1.2.3.4', status: 'active', user_agent: 'x' } } });
        expect(refused.statusCode).toBe(400); // the read-only columns cannot be written, even by an owner
      } finally {
        q().mockImplementation(original);
      }
    } finally {
      fakeDb.platformAdmins.delete('helper-6');
    }
  });

  it('works status out from expires_at in the query, and can filter and sort by it', async () => {
    const original = q().getMockImplementation();
    const selects: Array<{ sql: string; params: unknown[] }> = [];
    q().mockImplementation(async (sql: string, params: unknown[] = []) => {
      const text = String(sql);
      if (text.includes('FROM "sessions"') && text.startsWith('SELECT')) { selects.push({ sql: text, params }); return text.includes('COUNT(*)') ? { rows: [{ count: '1' }] } : { rows: [row] }; }
      return original(sql, params);
    });
    try {
      const res = await app.inject({ method: 'GET', url: `/admin/tables/desk.sessions/rows?filters=${encodeURIComponent(JSON.stringify({ status: 'expired' }))}&sortColumn=status&sortDirection=desc`, headers: adminHeaders });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().rows[0].status).toBe('active');
      const page = selects.find((x) => !x.sql.includes('COUNT(*)'))!;
      expect(page.sql).toContain(`(CASE WHEN expires_at > to_char(now() AT TIME ZONE 'UTC'`);
      expect(page.sql).toContain(`AS "status"`);
      expect(page.sql).toMatch(/WHERE \(CASE WHEN expires_at > .*\)::text ILIKE \$1/s); // filtered on the worked-out value
      expect(page.sql).toMatch(/ORDER BY \(CASE WHEN expires_at > .*\) DESC/s);
      expect(page.sql).not.toContain('token');
    } finally {
      q().mockImplementation(original);
    }
  });
});

describe('Email tokens: status and the address a link was sent to', () => {
  it('shows status and sent_to read-only; expires_at and used_at stay editable, and the link itself is never shown', async () => {
    const tables = (await app.inject({ method: 'GET', url: '/admin/tables', headers: adminHeaders })).json().tables as Array<{ name: string; columns: string[]; editableColumns: string[]; createColumns?: string[] }>;
    const t = tables.find((x) => x.name === 'desk.email_tokens')!;
    expect(t.columns).toEqual(['id', 'purpose', 'status', 'user_id', 'person_name', 'sent_to', 'expires_at', 'used_at', 'created_at']);
    expect(t.columns).not.toContain('token');
    expect(t.editableColumns).toEqual(['expires_at', 'used_at']);
    expect(t.createColumns).toBeUndefined();
  });

  it('works status out as used, expired or unused', async () => {
    const q = fakeDb.query as unknown as { getMockImplementation: () => (sql: string, params?: unknown[]) => Promise<unknown>; mockImplementation: (fn: unknown) => void };
    const original = q.getMockImplementation();
    let sql = '';
    q.mockImplementation(async (text: string, params?: unknown[]) => {
      if (String(text).includes('FROM "email_tokens"') && String(text).startsWith('SELECT') && !String(text).includes('COUNT(*)')) { sql = String(text); return { rows: [] }; }
      if (String(text).includes('FROM "email_tokens"') && String(text).includes('COUNT(*)')) return { rows: [{ count: '0' }] };
      return original(text, params);
    });
    try {
      const res = await app.inject({ method: 'GET', url: `/admin/tables/desk.email_tokens/rows?filters=${encodeURIComponent(JSON.stringify({ status: 'unused' }))}`, headers: adminHeaders });
      expect(res.statusCode, res.body).toBe(200);
      expect(sql).toContain(`CASE WHEN used_at IS NOT NULL THEN 'used' WHEN expires_at <= to_char(now() AT TIME ZONE 'UTC'`);
      expect(sql).toContain(`THEN 'expired' ELSE 'unused' END`);
      expect(sql).not.toContain('"token"');
    } finally {
      q.mockImplementation(original);
    }
  });
});

describe('Business setup drafts: version, no Add row, and an edit counts as a save', () => {
  type Mock = { getMockImplementation: () => (sql: string, params?: unknown[]) => Promise<unknown>; mockImplementation: (fn: unknown) => void };
  const q = () => fakeDb.query as unknown as Mock;

  it('shows version read-only and offers no Add row', async () => {
    const tables = (await app.inject({ method: 'GET', url: '/admin/tables', headers: adminHeaders })).json().tables as Array<{ name: string; columns: string[]; editableColumns: string[]; createColumns?: string[] }>;
    const t = tables.find((x) => x.name === 'desk.business_setup_drafts')!;
    expect(t.columns.slice(0, 6)).toEqual(['id', 'user_id', 'person_name', 'version', 'created_at', 'updated_at']);
    expect(t.columns).toContain('legal_entity'); // each fact of the draft is its own column…
    expect(t.columns).not.toContain('draft_json'); // …and the JSON itself is not shown
    expect(t.editableColumns).not.toContain('version');
    expect(t.editableColumns).not.toContain('person_name');
    expect(t.createColumns).toBeUndefined();
    const post = await app.inject({ method: 'POST', url: '/admin/tables/desk.business_setup_drafts/rows', headers: adminHeaders, payload: { values: { user_id: 'member-1', draft_json: '{}' } } });
    expect(post.statusCode).toBe(403);
  });

  it('an edit to the draft raises its version by one, so someone with it open is told it changed', async () => {
    const original = q().getMockImplementation();
    const updates: string[] = [];
    q().mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes('safe_jsonb("draft_json") IS NULL')) return { rows: [{ bad: false }] };
      if (text.includes('FROM "business_setup_drafts" WHERE "id"')) return { rows: [{ id: 'd1', user_id: 'u1', version: 3, created_at: 'x', updated_at: 'x' }] };
      if (text.startsWith('UPDATE "business_setup_drafts"')) { updates.push(text); return { rows: [{ id: 'd1', user_id: 'u1', version: 4, created_at: 'x', updated_at: 'y' }] }; }
      return original(sql, params);
    });
    try {
      const res = await app.inject({ method: 'PATCH', url: '/admin/tables/desk.business_setup_drafts/rows/d1', headers: adminHeaders, payload: { values: { formation_state: 'WI' } } });
      expect(res.statusCode, res.body).toBe(200);
      expect(updates[0]).toContain('"version" = "version" + 1');
      expect(updates[0]).toContain(`"draft_json" = (COALESCE(safe_jsonb("draft_json"), '{}'::jsonb) ||`); // merged into the draft, not replaced
      expect(res.json().row.version).toBe(4);
    } finally {
      q().mockImplementation(original);
    }
  });

  it('refuses a wrong kind of value, or a damaged stored draft, saving nothing', async () => {
    const original = q().getMockImplementation();
    let updated = false;
    let damaged = false;
    q().mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes('safe_jsonb("draft_json") IS NULL')) return { rows: [{ bad: damaged }] };
      if (text.includes('FROM "business_setup_drafts" WHERE "id"')) return { rows: [{ id: 'd1', user_id: 'u1', version: 1, created_at: 'x', updated_at: 'x' }] };
      if (text.startsWith('UPDATE "business_setup_drafts"')) { updated = true; return { rows: [] }; }
      return original(sql, params);
    });
    try {
      const res = await app.inject({ method: 'PATCH', url: '/admin/tables/desk.business_setup_drafts/rows/d1', headers: adminHeaders, payload: { values: { number_of_partners: 'two' } } });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toContain('number_of_partners needs a whole number');
      damaged = true;
      const bad = await app.inject({ method: 'PATCH', url: '/admin/tables/desk.business_setup_drafts/rows/d1', headers: adminHeaders, payload: { values: { formation_state: 'WI' } } });
      expect(bad.statusCode).toBe(409);
      expect(updated).toBe(false);
    } finally {
      q().mockImplementation(original);
    }
  });
});

describe('Businesses: setup facts are their own columns', () => {
  const q = () => fakeDb.query as unknown as { getMockImplementation: () => (sql: string, params?: unknown[]) => Promise<unknown>; mockImplementation: (fn: unknown) => void };
  const patch = (values: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: '/admin/tables/desk.businesses/rows/b1', headers: adminHeaders, payload: { values } });

  async function withDb(rows: { bad?: boolean }, run: (updates: Array<{ text: string; params: unknown[] }>) => Promise<void>) {
    const original = q().getMockImplementation();
    const updates: Array<{ text: string; params: unknown[] }> = [];
    q().mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes('safe_jsonb("business_json") IS NULL')) return { rows: [{ bad: !!rows.bad }] };
      if (text.startsWith('UPDATE "businesses"')) { updates.push({ text, params: params ?? [] }); return { rows: [{ id: 'b1', name: 'Acme' }] }; }
      if (text.includes('FROM "businesses" WHERE "id"')) return { rows: [{ id: 'b1', name: 'Acme' }] };
      return original(sql, params);
    });
    try { await run(updates); } finally { q().mockImplementation(original); }
  }

  it('an edit of one fact is merged into the stored text, leaving the others as they were', async () => {
    await withDb({}, async (updates) => {
      const res = await patch({ formation_state: 'WI', has_partners: 'true', number_of_partners: '3' });
      expect(res.statusCode, res.body).toBe(200);
      expect(updates[0].text).toContain('"business_json" = (COALESCE(safe_jsonb("business_json"), \'{}\'::jsonb) ||');
      expect(JSON.parse(String(updates[0].params[0]))).toEqual({ formationState: 'WI', hasPartners: true, numberOfPartners: 3 });
    });
  });

  it('owners and administrators can both edit them', async () => {
    const tables = (await app.inject({ method: 'GET', url: '/admin/tables', headers: adminHeaders })).json().tables as Array<{ name: string; editableColumns: string[] }>;
    const biz = tables.find((t) => t.name === 'desk.businesses')!;
    expect(biz.editableColumns).toEqual(expect.arrayContaining(['name', 'industry', 'business_name', 'tax_election']));
  });

  it('says in plain words when a value is the wrong kind, saving nothing', async () => {
    await withDb({}, async (updates) => {
      const a = await patch({ number_of_partners: 'two' });
      expect(a.statusCode).toBe(400);
      expect(a.json().detail).toContain('number_of_partners needs a whole number');
      const b = await patch({ has_partners: 'maybe' });
      expect(b.statusCode).toBe(400);
      const c = await patch({ market_research: '{oops' });
      expect(c.statusCode).toBe(400);
      expect(updates).toHaveLength(0);
    });
  });

  it('refuses to edit a business whose stored text is damaged', async () => {
    await withDb({ bad: true }, async (updates) => {
      const res = await patch({ formation_state: 'WI' });
      expect(res.statusCode).toBe(409);
      expect(res.json().detail).toContain('damaged');
      expect(updates).toHaveLength(0);
    });
  });

  it('created_at, updated_at and the creator cannot be edited', async () => {
    for (const column of ['user_id', 'created_at', 'updated_at']) {
      const res = await patch({ [column]: 'x' });
      expect(res.statusCode).toBe(400);
    }
  });

  it('counts what deleting a business takes with it', async () => {
    const original = q().getMockImplementation();
    q().mockImplementation(async (sql: string, params?: unknown[]) => (String(sql).includes('SELECT COUNT(*) AS n') ? { rows: [{ n: '2' }] } : original(sql, params)));
    let res;
    try {
      res = await app.inject({ method: 'GET', url: '/admin/businesses/b1/delete-impact', headers: adminHeaders });
    } finally {
      q().mockImplementation(original);
    }
    expect(res.statusCode, res.body).toBe(200);
    const labels = (res.json().goes as Array<{ label: string }>).map((g) => g.label).join('|');
    expect(labels).toContain('members who have joined');
    expect(labels).toContain('invitations sent by email');
  });
});

describe('Business memberships: owners and administrators edit, names are read-only', () => {
  it('shows the person and business names (read-only); owners and administrators edit role, invited_at and accepted_at', async () => {
    const owner = (await app.inject({ method: 'GET', url: '/admin/tables', headers: adminHeaders })).json().tables as Array<{ name: string; columns: string[]; editableColumns: string[] }>;
    const m = owner.find((t) => t.name === 'desk.business_memberships')!;
    expect(m.columns).toEqual(expect.arrayContaining(['person_name', 'business_name']));
    expect(m.editableColumns.sort()).toEqual(['accepted_at', 'invited_at', 'role']);
  });
});

describe('Add row: blanks take the lowest value, memberships are checked, lookups search by name', () => {
  type Q = { getMockImplementation: () => (sql: string, params?: unknown[]) => Promise<unknown>; mockImplementation: (fn: unknown) => void };
  const q = () => fakeDb.query as unknown as Q;
  const known = { businesses: new Set(['b1']), users: new Set(['u1']), pairs: new Set<string>() };
  let inserted: Array<{ table: string; values: Record<string, unknown> }> = [];
  let original: ReturnType<Q['getMockImplementation']>;

  beforeEach(() => {
    inserted = [];
    original = q().getMockImplementation();
    q().mockImplementation(async (sql: string, params: unknown[] = []) => {
      const text = String(sql);
      const ins = /^INSERT INTO "([a-z_]+)" \((.+?)\) VALUES/.exec(text);
      if (ins) {
        const names = ins[2].split(', ').map((n) => n.replace(/"/g, ''));
        const values = Object.fromEntries(names.map((n, i) => [n, params[i]]));
        inserted.push({ table: ins[1], values });
        return { rows: [values], rowCount: 1 };
      }
      if (text.startsWith('SELECT id FROM businesses WHERE id')) return { rows: known.businesses.has(String(params[0])) ? [{ id: params[0] }] : [] };
      if (text.startsWith('SELECT id FROM users WHERE id')) return { rows: known.users.has(String(params[0])) ? [{ id: params[0] }] : [] };
      if (text.startsWith('SELECT id FROM business_memberships WHERE business_id')) return { rows: known.pairs.has(`${params[0]}|${params[1]}`) ? [{ id: 'm' }] : [] };
      if (text.startsWith('SELECT 1 FROM plans WHERE id')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM users') && text.includes('ILIKE')) return { rows: [{ id: 'u1', label: 'Pat Lee', detail: 'pat@example.com' }] };
      return original(sql, params);
    });
  });
  afterEach(() => { q().mockImplementation(original); known.pairs.clear(); });

  const post = (table: string, values: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/admin/tables/desk.${table}/rows`, headers: adminHeaders, payload: { values } });

  it('a membership left with only the business and person is the lowest role, joined now, invited by the signed-in person', async () => {
    const res = await post('business_memberships', { business_id: 'b1', user_id: 'u1' });
    expect(res.statusCode, res.body).toBe(201);
    const v = inserted[0].values;
    expect(v.role).toBe('member');
    expect(String(v.accepted_at)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(String(v.invited_at)).toMatch(/Z$/);
    expect(v.invited_by_user_id).toBeTruthy();
  });

  it('a membership cleared of its accepted time stays a pending invitation', async () => {
    const res = await post('business_memberships', { business_id: 'b1', user_id: 'u1', accepted_at: '' });
    expect(res.statusCode, res.body).toBe(201);
    expect(inserted[0].values.accepted_at ?? null).toBeNull();
  });

  it('says which of the business, the person, or the pair is the problem, and checks the dates', async () => {
    const noBusiness = await post('business_memberships', { business_id: 'nope', user_id: 'u1' });
    expect(noBusiness.statusCode).toBe(400);
    expect(noBusiness.json().detail).toBe('No business has that ID.');
    const noPerson = await post('business_memberships', { business_id: 'b1', user_id: 'nope' });
    expect(noPerson.json().detail).toBe('No person has that ID.');
    known.pairs.add('b1|u1');
    const twice = await post('business_memberships', { business_id: 'b1', user_id: 'u1' });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().detail).toContain('already has a place');
    known.pairs.clear();
    const badDate = await post('business_memberships', { business_id: 'b1', user_id: 'u1', accepted_at: 'last tuesday-ish' });
    expect(badDate.statusCode).toBe(400);
    expect(badDate.json().detail).toContain('accepted_at needs a date and time');
    expect(inserted).toHaveLength(0);
  });

  it('a new plan with only a name starts switched off with the lowest limits; the two per-call prices may stay empty', async () => {
    const res = await post('plans', { name: 'Tiny' });
    expect(res.statusCode, res.body).toBe(201);
    const v = inserted[0].values;
    expect(v).toMatchObject({ monthly_price_cents: 0, included_analyses: 0, max_keys: 1, max_webhooks: 0, max_apps: 0, active: false, sort_order: 0 });
    expect(v.overage_cents_per_call ?? null).toBeNull();
  });

  it('a suspension needs a reason', async () => {
    const res = await post('account_suspensions', { user_id: 'u1' });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toBe('reason is required.');
  });

  it('tells the page the defaults and which fields can be searched', async () => {
    const tables = (await app.inject({ method: 'GET', url: '/admin/tables', headers: adminHeaders })).json().tables as Array<{ name: string; createDefaults?: Record<string, unknown>; createLookups?: Record<string, string> }>;
    const m = tables.find((t) => t.name === 'desk.business_memberships')!;
    expect(m.createDefaults).toMatchObject({ role: 'member', accepted_at: '@now' });
    expect(m.createLookups).toEqual({ business_id: 'businesses', user_id: 'users' });
  });

  it('GET /admin/lookup/users finds people by name or email, and an unknown kind is refused', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/lookup/users?q=pat', headers: adminHeaders });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().items[0]).toEqual({ id: 'u1', label: 'Pat Lee', detail: 'pat@example.com' });
    expect((await app.inject({ method: 'GET', url: '/admin/lookup/secrets', headers: adminHeaders })).statusCode).toBe(404);
  });
});

describe('Users: password_set is shown, worked out, and read-only', () => {
  it('is a column nobody can edit, and the stored password text is never selected', async () => {
    const tables = (await app.inject({ method: 'GET', url: '/admin/tables', headers: adminHeaders })).json().tables as Array<{ name: string; columns: string[]; editableColumns: string[] }>;
    const users = tables.find((t) => t.name === 'desk.users')!;
    expect(users.columns).toContain('password_set');
    expect(users.editableColumns).not.toContain('password_set');
    expect(users.columns).not.toContain('password_hash');
    const res = await app.inject({ method: 'PATCH', url: '/admin/tables/desk.users/rows/member-1', headers: adminHeaders, payload: { values: { password_set: false } } });
    expect(res.statusCode).toBe(400);
  });
});

describe('Business memberships: deleting the last joined member is warned about', () => {
  type Q = { getMockImplementation: () => (sql: string, params?: unknown[]) => Promise<unknown>; mockImplementation: (fn: unknown) => void };
  const check = async (othersJoined: number, accepted: string | null) => {
    const q = fakeDb.query as unknown as Q;
    const original = q.getMockImplementation();
    q.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text.startsWith('SELECT business_id, accepted_at FROM business_memberships')) return { rows: [{ business_id: 'b1', accepted_at: accepted }] };
      if (text.includes('FROM business_memberships WHERE business_id = $1 AND id <> $2')) return { rows: [{ n: String(othersJoined) }] };
      return original(sql, params);
    });
    try {
      return (await app.inject({ method: 'GET', url: '/admin/business_memberships/m1/delete-impact', headers: adminHeaders })).json();
    } finally {
      q.mockImplementation(original);
    }
  };
  it('warns when nobody else has joined, and is quiet otherwise (also for a pending invitation)', async () => {
    expect((await check(0, '2026-01-01T00:00:00Z')).warning).toContain('last joined member');
    expect((await check(2, '2026-01-01T00:00:00Z')).warning).toBeUndefined();
    expect((await check(0, null)).warning).toBeUndefined();
  });
});

describe('Plans: subscribers column, the Free plan is protected, a used plan cannot be deleted', () => {
  type Q = { getMockImplementation: () => (sql: string, params?: unknown[]) => Promise<unknown>; mockImplementation: (fn: unknown) => void };
  const withCounts = async (subs: number, invoices: number, run: (deleted: string[]) => Promise<void>) => {
    const q = fakeDb.query as unknown as Q;
    const original = q.getMockImplementation();
    const deleted: string[] = [];
    q.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes('FROM subscriptions WHERE plan_id = $1 OR scheduled_plan_id')) return { rows: [{ n: String(subs) }] };
      if (text.includes('FROM invoices WHERE plan_id = $1')) return { rows: [{ n: String(invoices) }] };
      if (text.startsWith('DELETE FROM "plans"')) { deleted.push(text); return { rows: [], rowCount: 1 }; }
      if (text.includes('FROM "plans" WHERE "id"')) return { rows: [{ id: params?.[0], name: 'x' }] };
      return original(sql, params);
    });
    try { await run(deleted); } finally { q.mockImplementation(original); }
  };
  const del = (id: string) => app.inject({ method: 'DELETE', url: `/admin/tables/desk.plans/rows/${id}`, headers: adminHeaders });

  it('shows a read-only Subscribers column', async () => {
    const tables = (await app.inject({ method: 'GET', url: '/admin/tables', headers: adminHeaders })).json().tables as Array<{ name: string; columns: string[]; editableColumns: string[] }>;
    const plans = tables.find((t) => t.name === 'desk.plans')!;
    expect(plans.columns).toContain('subscribers');
    expect(plans.editableColumns).not.toContain('subscribers');
  });

  it('refuses to delete the Free plan, or a plan still used, and says why; an unused plan is deleted', async () => {
    await withCounts(0, 0, async (deleted) => {
      const free = await del('free');
      expect(free.statusCode).toBe(409);
      expect(free.json().detail).toContain('Free plan cannot be deleted');
      expect(deleted).toHaveLength(0);
    });
    await withCounts(3, 1, async (deleted) => {
      const used = await del('team-plus');
      expect(used.statusCode).toBe(409);
      expect(used.json().detail).toContain('3 subscriptions and 1 invoice');
      expect(deleted).toHaveLength(0);
      const impact = await app.inject({ method: 'GET', url: '/admin/plans/team-plus/delete-impact', headers: adminHeaders });
      expect(impact.json().warning).toContain('Switch it off instead');
    });
    await withCounts(0, 0, async (deleted) => {
      expect((await del('old-plan')).statusCode).toBe(200);
      expect(deleted).toHaveLength(1);
      const impact = await app.inject({ method: 'GET', url: '/admin/plans/old-plan/delete-impact', headers: adminHeaders });
      expect(impact.json().warning).toBeUndefined();
    });
  });

  it('the Free plan cannot be switched off', async () => {
    await withCounts(0, 0, async () => {
      const res = await app.inject({ method: 'PATCH', url: '/admin/tables/desk.plans/rows/free', headers: adminHeaders, payload: { values: { active: false } } });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().detail).toContain('Free plan cannot be switched off');
    });
  });
});

describe('Subscriptions: locked columns, subscriber name, date checks, clearer errors', () => {
  type Q = { getMockImplementation: () => (sql: string, params?: unknown[]) => Promise<unknown>; mockImplementation: (fn: unknown) => void };
  const q = () => fakeDb.query as unknown as Q;
  const tables = async () => (await app.inject({ method: 'GET', url: '/admin/tables', headers: adminHeaders })).json().tables as Array<{ name: string; columns: string[]; editableColumns: string[]; createDefaults?: Record<string, unknown>; createLookups?: Record<string, string> }>;

  it('subject, created_at and subscriber name are locked; the rest stays editable; subscriber name is shown', async () => {
    const t = (await tables()).find((x) => x.name === 'desk.subscriptions')!;
    expect(t.columns).toContain('subscriber_name');
    for (const c of ['subject_type', 'subject_id', 'created_at', 'subscriber_name']) expect(t.editableColumns, c).not.toContain(c);
    expect(t.editableColumns).toEqual(expect.arrayContaining(['plan_id', 'status', 'period_start', 'period_end', 'canceled_at']));
  });

  it('the Add row form starts as a user subscription on Free, now to a month on, and searches for the person', async () => {
    const t = (await tables()).find((x) => x.name === 'desk.subscriptions')!;
    expect(t.createDefaults).toMatchObject({ subject_type: 'user', plan_id: 'free', status: 'active', provider: 'manual', period_start: '@now', period_end: '@now+1month' });
    expect(t.createLookups).toEqual({ subject_id: 'users', plan_id: 'plans' });
  });

  const withDb = async (run: (inserts: Array<Record<string, unknown>>) => Promise<void>, dup = false) => {
    const original = q().getMockImplementation();
    const inserts: Array<Record<string, unknown>> = [];
    q().mockImplementation(async (sql: string, params: unknown[] = []) => {
      const text = String(sql);
      const ins = /^INSERT INTO "subscriptions" \((.+?)\) VALUES/.exec(text);
      if (ins) {
        if (dup) throw Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_subscriptions_active_subject' });
        const names = ins[1].split(', ').map((n) => n.replace(/"/g, ''));
        const values = Object.fromEntries(names.map((n, i) => [n, params[i]]));
        inserts.push(values);
        return { rows: [values], rowCount: 1 };
      }
      return original(sql, params);
    });
    try { await run(inserts); } finally { q().mockImplementation(original); }
  };
  const post = (values: Record<string, unknown>) => app.inject({ method: 'POST', url: '/admin/tables/desk.subscriptions/rows', headers: adminHeaders, payload: { values } });

  it('adds with the defaults when only the person is given, and stores the dates in the billing format', async () => {
    await withDb(async (inserts) => {
      const res = await post({ subject_id: 'u1' });
      expect(res.statusCode, res.body).toBe(201);
      expect(inserts[0]).toMatchObject({ subject_type: 'user', subject_id: 'u1', plan_id: 'free', status: 'active', provider: 'manual' });
      expect(String(inserts[0].period_start)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(new Date(String(inserts[0].period_end)).getTime()).toBeGreaterThan(new Date(String(inserts[0].period_start)).getTime());
    });
  });

  it('refuses dates that are not dates, and an end that is not after the start', async () => {
    await withDb(async (inserts) => {
      const bad = await post({ subject_id: 'u1', period_start: 'soon' });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().detail).toContain('period_start needs a date and time');
      const order = await post({ subject_id: 'u1', period_start: '2026-11-01T00:00:00Z', period_end: '2026-10-01T00:00:00Z' });
      expect(order.statusCode).toBe(400);
      expect(order.json().detail).toBe('period_end must be after period_start.');
      expect(inserts).toHaveLength(0);
    });
  });

  it('says in plain words when the person already has an active subscription', async () => {
    await withDb(async () => {
      const res = await post({ subject_id: 'u1' });
      expect(res.statusCode).toBe(409);
      expect(res.json().detail).toBe('This person already has an active subscription.');
    }, true);
  });

  it('the delete note says the person goes back to the Free plan', async () => {
    const original = q().getMockImplementation();
    q().mockImplementation(async (sql: string, params?: unknown[]) => (String(sql).startsWith('SELECT subject_type FROM subscriptions') ? { rows: [{ subject_type: 'user' }] } : original(sql, params)));
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/subscriptions/s1/delete-impact', headers: adminHeaders });
      expect(res.json().note).toBe('This person goes back to the Free plan.');
    } finally {
      q().mockImplementation(original);
    }
  });
});

describe('Invoices: subject is locked, period dates are checked', () => {
  it('subject_type and subject_id cannot be edited; the rest is unchanged', async () => {
    const tables = (await app.inject({ method: 'GET', url: '/admin/tables', headers: adminHeaders })).json().tables as Array<{ name: string; editableColumns: string[] }>;
    const inv = tables.find((t) => t.name === 'desk.invoices')!;
    expect(inv.editableColumns).not.toContain('subject_type');
    expect(inv.editableColumns).not.toContain('subject_id');
    expect(inv.editableColumns).toEqual(expect.arrayContaining(['number', 'plan_id', 'period_start', 'period_end', 'currency', 'lines', 'status']));
    expect(inv.editableColumns).not.toContain('subtotal_cents'); // worked out from the lines
    expect(inv.editableColumns).not.toContain('created_at');
  });

  it('refuses period dates that are not dates, when adding and when editing', async () => {
    const add = await app.inject({ method: 'POST', url: '/admin/tables/desk.invoices/rows', headers: adminHeaders, payload: { values: { subject_type: 'user', subject_id: 'u1', plan_id: 'free', period_start: 'whenever', period_end: '2026-11-01T00:00:00Z' } } });
    expect(add.statusCode).toBe(400);
    expect(add.json().detail).toContain('period_start needs a date and time');
    const edit = await app.inject({ method: 'PATCH', url: '/admin/tables/desk.invoices/rows/i1', headers: adminHeaders, payload: { values: { period_end: 'tomorrow-ish' } } });
    expect(edit.statusCode).toBe(400);
    expect(edit.json().detail).toContain('period_end needs a date and time');
  });
});

describe('Column review: names to navigate by, locks, hidden hashes, checked inputs', () => {
  type Q = { getMockImplementation: () => (sql: string, params?: unknown[]) => Promise<unknown>; mockImplementation: (fn: unknown) => void };
  const q = () => fakeDb.query as unknown as Q;
  type T = { name: string; primaryKey: string; columns: string[]; editableColumns: string[]; columnOptions: Record<string, string[]>; hasDeleteNote?: boolean; createDefaults?: Record<string, unknown> };
  const tables = async () => (await app.inject({ method: 'GET', url: '/admin/tables', headers: adminHeaders })).json().tables as T[];
  const get = async (name: string) => (await tables()).find((t) => t.name === `desk.${name}`)!;

  it('every table that points at a person, business, key, client, endpoint or incident also shows its name', async () => {
    const want: Record<string, string[]> = {
      business_email_invites: ['business_name', 'inviter_name'], business_memberships: ['person_name', 'business_name', 'inviter_name'],
      gateway_api_key_grants: ['key_label'], gateway_key_shares: ['key_label', 'shared_with_name', 'inviter_name'], gateway_key_usage: ['key_label'],
      key_suspensions: ['key_label', 'owner_name'], mfa_pending_logins: ['person_name'], oauth_codes: ['client_name', 'person_name'],
      oauth_tokens: ['client_name', 'person_name'], payment_methods: ['person_name'], totp_backup_codes: ['person_name'],
      account_suspensions: ['person_name'], platform_admins: ['person_name'], sessions: ['person_name'], email_tokens: ['person_name'],
      business_setup_drafts: ['person_name'], subscriptions: ['subscriber_name'], invoices: ['subscriber_name'], usage_meter: ['subscriber_name'],
      api_usage: ['person_name'], incident_updates: ['incident_title'], webhook_endpoints: ['owner_name'], webhook_deliveries: ['endpoint_url'],
      oauth_clients: ['owner_name'], gateway_api_keys: ['owner_name'], security_events: ['person_name'],
    };
    const all = await tables();
    for (const [name, cols] of Object.entries(want)) {
      const t = all.find((x) => x.name === `desk.${name}`)!;
      for (const c of cols) {
        expect(t.columns, `${name}.${c}`).toContain(c);
        expect(t.editableColumns, `${name}.${c} is read-only`).not.toContain(c);
      }
    }
  });

  it('a hash is never shown: the OAuth code table shows a short reference instead of code_hash', async () => {
    const t = await get('oauth_codes');
    expect(t.columns).not.toContain('code_hash');
    expect(t.columns).toContain('code_ref');
    expect(t.primaryKey).toBe('code_ref');
    for (const x of await tables()) for (const c of x.columns) expect(c, `${x.name}.${c}`).not.toMatch(/(^|_)(hash|secret_enc|token_hash)$/);
  });

  it('only what can sensibly change is editable (counts yes, keys and history no)', async () => {
    const ed = async (n: string) => (await get(n)).editableColumns;
    expect(await ed('gateway_key_usage')).toEqual(['calls', 'errors']);
    expect(await ed('api_usage')).toEqual(['calls']);
    expect(await ed('webhook_deliveries')).toEqual([]);
    expect(await ed('incident_updates')).toEqual(['status', 'message']);
    expect(await ed('incidents')).toEqual(['title', 'severity', 'status', 'resolved_at']);
    expect(await ed('oauth_clients')).toEqual(['name', 'revoked_at']);
    expect(await ed('gateway_api_keys')).toEqual(['label', 'rate_limit_per_minute', 'expires_at']);
    expect(await ed('webhook_endpoints')).toEqual(['url', 'active', 'consecutive_failures', 'disabled_reason']);
    expect(await ed('oauth_tokens')).toEqual(['revoked_at']);
  });

  it('plan ids are a choice (a list) where a plan is picked', async () => {
    expect(Array.isArray((await get('subscriptions')).columnOptions.plan_id)).toBe(true);
    expect(Array.isArray((await get('invoices')).columnOptions.plan_id)).toBe(true);
    expect((await get('email_suppressions')).columnOptions.reason).toEqual(['bounced', 'complained']);
    expect((await get('usage_meter')).columnOptions.metric).toEqual(['market_analyses']);
  });

  async function patch(table: string, id: string, before: Record<string, unknown>, values: Record<string, unknown>) {
    const original = q().getMockImplementation();
    const updates: Array<{ text: string; params: unknown[] }> = [];
    q().mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text.startsWith(`UPDATE "${table}"`)) { updates.push({ text, params: params ?? [] }); return { rows: [{ ...before }], rowCount: 1 }; }
      if (text.includes(`FROM "${table}" WHERE`)) return { rows: [{ ...before }] };
      return original(sql, params);
    });
    try {
      const res = await app.inject({ method: 'PATCH', url: `/admin/tables/desk.${table}/rows/${id}`, headers: adminHeaders, payload: { values } });
      return { res, updates };
    } finally {
      q().mockImplementation(original);
    }
  }

  it('dates are checked on every date column that can be edited', async () => {
    const cases: Array<[string, string, string, Record<string, unknown>]> = [
      ['sessions', 's1', 'expires_at', { id: 's1' }], ['email_tokens', 't1', 'used_at', { id: 't1' }], ['incidents', 'i1', 'resolved_at', { id: 'i1', started_at: '2026-01-01T00:00:00Z' }],
      ['subscriptions', 'b1', 'canceled_at', { id: 'b1' }], ['subscriptions', 'b1', 'scheduled_for', { id: 'b1' }], ['oauth_clients', 'c1', 'revoked_at', { id: 'c1' }],
      ['oauth_tokens', 'o1', 'revoked_at', { id: 'o1' }], ['gateway_api_keys', 'k1', 'expires_at', { id: 'k1', owner_user_id: 'u1' }], ['email_outbox', 'e1', 'next_attempt_at', { id: 'e1' }],
    ];
    for (const [table, id, column, before] of cases) {
      const { res, updates } = await patch(table, id, before, { [column]: 'next-ish week' });
      expect(res.statusCode, `${table}.${column}`).toBe(400);
      expect(res.json().detail, `${table}.${column}`).toContain(`${column} needs a date and time`);
      expect(updates, `${table}.${column}`).toHaveLength(0);
    }
    const ok = await patch('sessions', 's1', { id: 's1' }, { expires_at: '2030-01-02 03:04:05' });
    expect(ok.res.statusCode, ok.res.body).toBe(200);
    expect(ok.updates[0].params[0]).toBe('2030-01-02T03:04:05Z');
  });

  it('numbers and text are checked, in plain words', async () => {
    const key = { id: 'k1', owner_user_id: 'u1' };
    const say = async (table: string, before: Record<string, unknown>, values: Record<string, unknown>) => (await patch(table, String(before.id), before, values)).res.json().detail as string;
    expect(await say('gateway_api_keys', key, { rate_limit_per_minute: 0 })).toBe('rate_limit_per_minute must be a whole number from 1 to 6000.');
    expect(await say('gateway_api_keys', key, { rate_limit_per_minute: 9000 })).toBe('rate_limit_per_minute must be a whole number from 1 to 6000.');
    expect(await say('gateway_api_keys', key, { label: ' ' })).toBe('label is required.');
    expect(await say('gateway_api_keys', key, { label: 'x'.repeat(65) })).toBe('label must be at most 64 characters.');
    expect(await say('plans', { id: 'p1' }, { max_keys: 0 })).toBe('max_keys must be a whole number from 1 up.');
    expect(await say('plans', { id: 'p1' }, { name: '' })).toBe('name is required.');
    expect(await say('invoices', { id: 'i1' }, { currency: 'dollars' })).toBe('currency needs a three-letter code such as usd.');
    expect(await say('email_outbox', { id: 'e1' }, { attempts: -1 })).toBe('attempts must be a whole number from 0 up.');
    expect(await say('incident_updates', { id: 'u1' }, { message: '' })).toBe('message is required.');
    expect(await say('oauth_clients', { id: 'c1' }, { name: '' })).toBe('name is required.');
    const user = { id: 'member-1', email: 'a@b.co' };
    expect(await say('users', user, { first_name: '' })).toBe('firstName is required');
    expect(await say('users', user, { last_name: 'x'.repeat(200) })).toContain('lastName must be at most');
    expect(await say('users', user, { email: 'nope' })).toContain('email must be a valid email address');
  });

  it('a user email is saved trimmed and lower case, as sign-up saves it', async () => {
    const { res, updates } = await patch('users', 'member-1', { id: 'member-1', email: 'old@example.com' }, { email: '  New.Person@Example.COM ' });
    expect(res.statusCode, res.body).toBe(200);
    expect(updates[0].params[0]).toBe('new.person@example.com');
  });

  it('usage month and window keys have to be in their forms', async () => {
    const post = (table: string, values: Record<string, unknown>) => app.inject({ method: 'POST', url: `/admin/tables/desk.${table}/rows`, headers: adminHeaders, payload: { values } });
    const bad = await post('usage_meter', { subject_id: 'u1', month: '2026-13' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().detail).toBe('month needs a year and month such as 2026-10.');
    const badKey = await post('api_usage', { user_id: 'u1', service: 'desk_api', window_key: 'today' });
    expect(badKey.statusCode).toBe(400);
    expect(badKey.json().detail).toContain('window_key needs a minute');
  });

  it('invoice lines must be a list of items; the subtotal follows them', async () => {
    const bad = await patch('invoices', 'i1', { id: 'i1' }, { lines: '{}' });
    expect(bad.res.statusCode).toBe(400);
    expect(bad.res.json().detail).toContain('lines must be a list of items');
    const lines = JSON.stringify([{ description: 'A', quantity: 1, unitCents: 500, totalCents: 500 }, { description: 'B', quantity: 2, unitCents: 250, totalCents: 500 }]);
    const good = await patch('invoices', 'i1', { id: 'i1' }, { lines });
    expect(good.res.statusCode, good.res.body).toBe(200);
    expect(good.updates[0].text).toContain('"subtotal_cents" =');
    expect(good.updates[0].params).toContain(1000);
  });

  it('resolving an incident stamps when; it cannot end before it began', async () => {
    const resolve = await patch('incidents', 'i1', { id: 'i1', started_at: '2026-01-01T00:00:00Z', resolved_at: null }, { status: 'resolved' });
    expect(resolve.res.statusCode, resolve.res.body).toBe(200);
    expect(resolve.updates[0].text).toContain('"resolved_at" =');
    const early = await patch('incidents', 'i1', { id: 'i1', started_at: '2026-06-01T00:00:00Z', resolved_at: null }, { resolved_at: '2026-01-01T00:00:00Z' });
    expect(early.res.statusCode).toBe(400);
    expect(early.res.json().detail).toBe('resolved_at cannot be before the incident started.');
  });

  it('switching a webhook endpoint on starts it clean; an unusable address is refused', async () => {
    const on = await patch('webhook_endpoints', 'w1', { id: 'w1' }, { active: true });
    expect(on.res.statusCode, on.res.body).toBe(200);
    expect(on.updates[0].text).toContain('"consecutive_failures" =');
    expect(on.updates[0].text).toContain('"disabled_reason" =');
    const off = await patch('webhook_endpoints', 'w1', { id: 'w1' }, { active: false });
    expect(off.updates[0].params).toContain('Switched off by an administrator.');
    const bad = await patch('webhook_endpoints', 'w1', { id: 'w1' }, { url: 'ftp://example.com/hook' });
    expect(bad.res.statusCode).toBe(400);
    expect(bad.updates).toHaveLength(0);
  });

  it('deleting an API key ends it (and its backend keys) first', async () => {
    const { gatewayApiKeys } = await import('../../domain/gateway/keys');
    const revoke = vi.spyOn(gatewayApiKeys, 'revoke').mockResolvedValue({ upstreamFailures: [] });
    const original = q().getMockImplementation();
    q().mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text.startsWith('DELETE FROM "gateway_api_keys"')) return { rows: [], rowCount: 1 };
      if (text.includes('FROM "gateway_api_keys" WHERE')) return { rows: [{ id: 'k1', owner_user_id: 'u9' }] };
      return original(sql, params);
    });
    try {
      const res = await app.inject({ method: 'DELETE', url: '/admin/tables/desk.gateway_api_keys/rows/k1', headers: adminHeaders });
      expect(res.statusCode, res.body).toBe(200);
      expect(revoke).toHaveBeenCalledWith('u9', 'k1');
    } finally {
      q().mockImplementation(original);
      revoke.mockRestore();
    }
  });

  it('says what a delete does where it matters, and which tables have such a note', async () => {
    const all = await tables();
    for (const n of ['gateway_api_keys', 'oauth_clients', 'webhook_endpoints', 'incidents', 'usage_meter', 'account_suspensions', 'email_suppressions']) {
      expect(all.find((t) => t.name === `desk.${n}`)!.hasDeleteNote, n).toBe(true);
    }
    const res = await app.inject({ method: 'GET', url: '/admin/delete-impact/usage_meter/x', headers: adminHeaders });
    expect(res.json().note).toContain('resets that month');
    expect((await app.inject({ method: 'GET', url: '/admin/delete-impact/sessions/x', headers: adminHeaders })).statusCode).toBe(404);
  });

  it('Add row starts incidents as minor and investigating, and usage and invoices with the safest values', async () => {
    expect((await get('incidents')).createDefaults).toMatchObject({ severity: 'minor', status: 'investigating' });
    expect((await get('incident_updates')).createDefaults).toMatchObject({ status: 'investigating' });
    expect((await get('usage_meter')).createDefaults).toMatchObject({ subject_type: 'user', month: '@month', metric: 'market_analyses', quantity: 0 });
    expect((await get('api_usage')).createDefaults).toMatchObject({ window_key: '@monthkey', calls: 0 });
    expect((await get('invoices')).createDefaults).toMatchObject({ subject_type: 'user', period_start: '@now', period_end: '@now+1month', currency: 'usd', status: 'draft' });
  });
});

describe('Invoices are never deleted here', () => {
  it('not even by an owner: mark one void instead', async () => {
    const tables = (await app.inject({ method: 'GET', url: '/admin/tables', headers: adminHeaders })).json().tables as Array<{ name: string; deletable: boolean }>;
    expect(tables.find((x) => x.name === 'desk.invoices')!.deletable).toBe(false);
    expect((await app.inject({ method: 'DELETE', url: '/admin/tables/desk.invoices/rows/i1', headers: adminHeaders })).statusCode).toBe(403);
  });
});

describe('Delete notes for Registry and Market tables come from those services', () => {
  it('asks the service what its delete does, with the signed-in person as the owner signal', async () => {
    const { config } = await import('../../config');
    const saved = { a: config.registryApiUrl, b: config.registryApiAdminKey, c: config.marketApiUrl, d: config.marketApiAdminKey };
    const seen: Array<{ url: string; owner: string | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url, owner: init?.headers?.['x-desk-admin-owner'] });
      return new Response(JSON.stringify({ goes: [], stays: [], note: 'Only the history row is removed.' }), { status: 200 });
    }));
    Object.assign(config, { registryApiUrl: 'http://registry.test', registryApiAdminKey: 'k', marketApiUrl: 'http://market.test', marketApiAdminKey: 'k' });
    try {
      const market = await app.inject({ method: 'GET', url: '/admin/delete-impact/market.import_runs/r1', headers: adminHeaders });
      expect(market.statusCode, market.body).toBe(200);
      expect(market.json().note).toBe('Only the history row is removed.');
      expect(seen[0]).toEqual({ url: 'http://market.test/admin/delete-impact/import_runs/r1', owner: 'admin@example.com' });
      await app.inject({ method: 'GET', url: '/admin/delete-impact/registry.business_structures/llc', headers: adminHeaders });
      expect(seen[1].url).toBe('http://registry.test/admin/delete-impact/business_structures/llc');
      // a desk table is still answered here, by its prefixed key
      const own = await app.inject({ method: 'GET', url: '/admin/delete-impact/desk.usage_meter/x', headers: adminHeaders });
      expect(own.json().note).toContain('resets that month');
    } finally {
      vi.unstubAllGlobals();
      Object.assign(config, { registryApiUrl: saved.a, registryApiAdminKey: saved.b, marketApiUrl: saved.c, marketApiAdminKey: saved.d });
    }
  });
});

describe('Billing tables do not look up the dropped teams table', () => {
  it('listing Subscriptions, Invoices, Usage meter and Plans never mentions teams (migration 0037 dropped the table)', async () => {
    const q = fakeDb.query as unknown as { getMockImplementation: () => (sql: string, params?: unknown[]) => Promise<unknown>; mockImplementation: (fn: unknown) => void };
    const original = q.getMockImplementation();
    const seen: string[] = [];
    q.mockImplementation(async (sql: string, params?: unknown[]) => {
      seen.push(String(sql));
      return original(sql, params);
    });
    try {
      for (const table of ['subscriptions', 'invoices', 'usage_meter', 'plans']) {
        await app.inject({ method: 'GET', url: `/admin/tables/desk.${table}/rows`, headers: adminHeaders }); // the fake database may not answer every query; what matters is the SQL that was sent
      }
    } finally {
      q.mockImplementation(original);
    }
    const selects = seen.filter((s) => /FROM "(subscriptions|invoices|usage_meter|plans)"/.test(s) && s.includes('SELECT'));
    expect(selects.length).toBeGreaterThanOrEqual(4);
    for (const s of selects) expect(s, s).not.toMatch(/\bteams\b/);
  });
});
