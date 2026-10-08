import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

// The routes around the platform features that the other end-to-end files only touch in passing: the status page's incidents,
// the changelog feed, plans and invoices, GraphQL beyond the happy path, and the ways an
// outbound webhook can be refused. Real database; skipped without E2E_DATABASE_URL.
const hasDb = !!process.env.E2E_DATABASE_URL;

// The two backends that issue keys are not part of this test.
vi.mock('../../domain/gateway/broker', async (orig) => {
  const real = await orig<typeof import('../../domain/gateway/broker')>();
  return {
    ...real,
    provisionBrokerKey: vi.fn(async () => ({ backendKeyId: `bk-${randomBytes(6).toString('hex')}`, plaintext: `backend-${randomBytes(12).toString('hex')}` })),
    revokeBrokerKey: vi.fn(async () => undefined),
  };
});

import { pool } from '../../db';
import { buildApp } from '../../app';
import { config } from '../../config';
import { assignPlan, BillingError, setInvoiceStatus } from '../../domain/billing/plans';
import { deleteOldDeliveries, processDueDeliveries, type Sender } from '../../domain/webhooks/webhooks';
import type { FastifyInstance } from 'fastify';

const rid = () => randomBytes(10).toString('hex');
const PUBLIC_URL = 'https://93.184.216.34/desk-hook';

describe.skipIf(!hasDb)('E2E: status, changelog, billing, GraphQL and webhook refusals', () => {
  let app: FastifyInstance;
  const users: string[] = [];
  const incidents: string[] = [];
  const saved = { a: config.registryApiUrl, b: config.registryApiAdminKey, c: config.marketApiUrl, d: config.marketApiAdminKey, e: config.gatewayKeyEncryptionSecret };
  const adminEmail = `plat-admin-${rid()}@example.com`;
  let ownerUser: Awaited<ReturnType<typeof mkUser>> | null = null;
  /** The one account whose address is on the owner list for this file (made on first use). */
  const mkOwner = async () => (ownerUser ??= await mkUser('owner', adminEmail));

  async function mkUser(name: string, email?: string, confirmed = true) {
    const id = rid();
    const now = new Date().toISOString();
    const address = email ?? `pr-${name}-${id}@example.com`;
    await pool.query(`INSERT INTO users (id, email, password_hash, first_name, last_name, email_confirmed_at, created_at, updated_at) VALUES ($1,$2,'x',$3,'T',$4,$5,$5)`, [id, address, name, confirmed ? now : null, now]);
    users.push(id);
    const { authDb } = await import('../../infrastructure/auth');
    const token = randomBytes(24).toString('hex');
    await authDb.createSession(rid(), id, token, new Date(Date.now() + 3_600_000).toISOString());
    return { id, email: address, headers: { authorization: `Bearer ${token}` } as Record<string, string> };
  }
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, who: { headers: Record<string, string> } | null, payload?: unknown) =>
    app.inject({ method, url, headers: { ...(who?.headers ?? {}), 'cf-connecting-ip': `203.0.113.${1 + Math.floor(Math.random() * 250)}` }, payload: payload as never });
  const gql = (who: { headers: Record<string, string> }, query: string) => call('POST', '/v1/graphql', who, { query });

  beforeAll(async () => {
    // The two backends are not really called (key provisioning is mocked above); they only have to look configured.
    config.registryApiUrl = 'http://127.0.0.1:1';
    config.registryApiAdminKey = 'k';
    config.marketApiUrl = 'http://127.0.0.1:1';
    config.marketApiAdminKey = 'k';
    config.gatewayKeyEncryptionSecret = 'ab'.repeat(32);
    config.adminEmails.push(adminEmail.toLowerCase());
    app = await buildApp();
  });
  afterAll(async () => {
    if (incidents.length) await pool.query('DELETE FROM incidents WHERE id = ANY($1)', [incidents]);
    await pool.query('DELETE FROM subscriptions WHERE subject_id = ANY($1)', [users]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [users]);
    config.adminEmails.splice(config.adminEmails.indexOf(adminEmail.toLowerCase()), 1);
    config.registryApiUrl = saved.a;
    config.registryApiAdminKey = saved.b;
    config.marketApiUrl = saved.c;
    config.marketApiAdminKey = saved.d;
    config.gatewayKeyEncryptionSecret = saved.e;
    await app.close();
  });

  it('incidents: an administrator opens one and posts updates, everyone can read them, and bad input is refused', async () => {
    const admin = await mkOwner();
    const person = await mkUser('reader');
    expect((await call('POST', '/v1/admin/incidents', person, { title: 'Slow', severity: 'minor', message: 'We are looking.' })).statusCode).toBe(403);
    expect((await call('POST', '/v1/admin/incidents', admin, { title: 'x', severity: 'minor', message: 'y' })).statusCode).toBe(400);
    expect((await call('POST', '/v1/admin/incidents', admin, { title: 'Slow answers', severity: 'nonsense', message: 'We are looking.' })).statusCode).toBe(400);

    const opened = await call('POST', '/v1/admin/incidents', admin, { title: 'Slow answers', severity: 'minor', message: 'We are looking into it.' });
    expect(opened.statusCode).toBe(201);
    const incident = opened.json().incident;
    incidents.push(incident.id);
    expect(incident).toMatchObject({ title: 'Slow answers', status: 'investigating', resolvedAt: null });
    expect(incident.updates).toHaveLength(1);

    const publicView = await call('GET', '/v1/status/incidents', null);
    expect(publicView.statusCode).toBe(200);
    expect(publicView.headers['cache-control']).toBe('public, max-age=30');
    expect(publicView.json().active.map((i: { id: string }) => i.id)).toContain(incident.id);

    const bad = await call('POST', `/v1/admin/incidents/${incident.id}/updates`, admin, { status: 'nonsense', message: 'x' });
    expect(bad.statusCode).toBe(400);
    expect((await call('POST', `/v1/admin/incidents/${rid()}/updates`, admin, { status: 'monitoring', message: 'A fix is out.' })).statusCode).toBe(404);
    expect((await call('POST', `/v1/admin/incidents/${incident.id}/updates`, person, { status: 'monitoring', message: 'A fix is out.' })).statusCode).toBe(403);

    const monitoring = await call('POST', `/v1/admin/incidents/${incident.id}/updates`, admin, { status: 'monitoring', message: 'A fix is out, watching.' });
    expect(monitoring.statusCode).toBe(200);
    expect(monitoring.json().incident.status).toBe('monitoring');
    const resolved = await call('POST', `/v1/admin/incidents/${incident.id}/updates`, admin, { status: 'resolved', message: 'All clear.' });
    expect(resolved.json().incident.status).toBe('resolved');
    expect(resolved.json().incident.resolvedAt).not.toBeNull();
    expect(resolved.json().incident.updates.map((u: { status: string }) => u.status)).toEqual(['investigating', 'monitoring', 'resolved']);

    const after = (await call('GET', '/v1/status/incidents', null)).json();
    expect(after.active.map((i: { id: string }) => i.id)).not.toContain(incident.id);
    expect(after.recent.map((i: { id: string }) => i.id)).toContain(incident.id);
  });

  it('changelog: JSON with a limit, and an Atom feed', async () => {
    const all = await call('GET', '/v1/changelog', null);
    expect(all.statusCode).toBe(200);
    expect(Array.isArray(all.json().entries)).toBe(true);
    const one = (await call('GET', '/v1/changelog?limit=1', null)).json();
    expect(one.entries.length).toBeLessThanOrEqual(1);
    const junk = await call('GET', '/v1/changelog?limit=abc', null);
    expect(junk.statusCode).toBe(200);
    const atom = await call('GET', '/v1/changelog.atom', null);
    expect(atom.statusCode).toBe(200);
    expect(atom.headers['content-type']).toMatch(/atom\+xml/);
    expect(atom.body).toContain('<feed');
  });

  it('billing: a person sees their own plan, usage and invoices; a signed-out request is refused', async () => {
    const owner = await mkUser('boss');
    expect((await call('GET', '/v1/billing/subscription', null)).statusCode).toBe(401);

    const mine = await call('GET', '/v1/billing/subscription', owner);
    expect(mine.statusCode).toBe(200);
    expect(mine.json().subscription).toMatchObject({ subjectType: 'user', subjectId: owner.id, status: 'active' });
    expect(mine.json().usage).toMatchObject({ marketAnalyses: 0 });
    expect((await call('GET', '/v1/billing/invoices', owner)).json()).toMatchObject({ hasMore: false, invoices: [], accountName: expect.any(String) });
  });

  it('GraphQL: keys and plan for their owner, refusals for outsiders, key usage, drafts and business members', async () => {
    const owner = await mkUser('gq-owner');
    const outsider = await mkUser('gq-outsider');
    const keyRes = await call('POST', '/v1/gateway/api-keys', owner, { label: 'my key', services: ['registry_api'] });
    expect(keyRes.statusCode, keyRes.body).toBe(201);
    const keyId = keyRes.json().apiKey.id as string;

    const ok = await gql(owner, `{ apiKeys { id label } plan { id } usage(keyId: "${keyId}", months: 1) { month calls } }`);
    const body = ok.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.apiKeys.map((k: { id: string }) => k.id)).toContain(keyId);
    expect(body.data.plan.id).toBe('free');
    expect(Array.isArray(body.data.usage)).toBe(true);

    const outsiderView = (await gql(outsider, '{ apiKeys { id } }')).json();
    expect(outsiderView.data.apiKeys.map((k: { id: string }) => k.id)).not.toContain(keyId);

    const denied = (await gql(outsider, `{ usage(keyId: "${keyId}") { month } }`)).json();
    expect(denied.errors[0].extensions.code).toBe('NOT_FOUND');

    await pool.query(`INSERT INTO business_setup_drafts (id, user_id, draft_json) VALUES ($1,$2,$3)`, [rid(), owner.id, JSON.stringify({ businessName: 'Draft Co', currentStep: 3 })]);
    await pool.query(`INSERT INTO business_setup_drafts (id, user_id, draft_json) VALUES ($1,$2,$3)`, [rid(), owner.id, 'not json']);
    const drafts = (await gql(owner, '{ drafts(first: 5) { businessName currentStep } }')).json().data.drafts;
    expect(drafts).toEqual(expect.arrayContaining([{ businessName: 'Draft Co', currentStep: 3 }, { businessName: null, currentStep: null }]));

    const biz = rid();
    await pool.query(`INSERT INTO businesses (id, user_id, name, business_json) VALUES ($1,$2,'Members Co','{}')`, [biz, owner.id]);
    await pool.query(`INSERT INTO business_memberships (id, business_id, user_id, role, accepted_at) VALUES ($1,$2,$3,'owner',now())`, [rid(), biz, owner.id]);
    const withMembers = (await gql(owner, '{ businesses { name members(first: 5) { email role } } }')).json().data.businesses;
    expect(withMembers.find((b: { name: string }) => b.name === 'Members Co').members[0]).toMatchObject({ email: owner.email, role: 'owner' });
    await pool.query('DELETE FROM businesses WHERE id = $1', [biz]);
  });

  it('webhooks: unconfirmed e-mail, bad addresses, unknown events, unknown endpoints and other people\'s endpoints are all refused', async () => {
    const u = await mkUser('hook');
    const other = await mkUser('hook-other');
    const unconfirmed = await mkUser('hook-unconfirmed', undefined, false);
    expect((await call('POST', '/v1/gateway/webhooks', unconfirmed, { url: PUBLIC_URL, events: ['key.created'] })).statusCode).toBe(403);
    expect((await call('POST', '/v1/gateway/webhooks', u, { url: PUBLIC_URL, events: [] })).statusCode).toBe(400);
    expect((await call('POST', '/v1/gateway/webhooks', u, { url: PUBLIC_URL, events: ['nonsense'] })).statusCode).toBe(400);
    expect((await call('POST', '/v1/gateway/webhooks', u, { url: 'ftp://93.184.216.34/x', events: ['key.created'] })).statusCode).toBe(400);
    expect((await call('POST', '/v1/gateway/webhooks', u, { url: 'https://127.0.0.1/x', events: ['key.created'] })).statusCode).toBe(400);

    const made = await call('POST', '/v1/gateway/webhooks', u, { url: PUBLIC_URL, events: ['key.created'] });
    expect(made.statusCode).toBe(201);
    const id = made.json().endpoint.id as string;
    expect(made.json().secret).toMatch(/^whsec_/);

    for (const [method, path] of [['DELETE', `/v1/gateway/webhooks/${id}`], ['POST', `/v1/gateway/webhooks/${id}/test`], ['POST', `/v1/gateway/webhooks/${id}/rotate-secret`], ['GET', `/v1/gateway/webhooks/${id}/deliveries`]] as const) {
      expect((await call(method, path, other)).statusCode, `${method} ${path} by someone else`).toBe(404);
      const missing = path.replace(id, rid());
      expect((await call(method, missing, u)).statusCode, `${method} ${missing}`).toBe(404);
    }
    expect((await call('DELETE', `/v1/gateway/webhooks/${id}`, u)).statusCode).toBe(204);
  });

  it('a receiver that cannot be reached is recorded as a failed try, and old finished deliveries are cleared out', async () => {
    const u = await mkUser('tw-fail');
    const made = await call('POST', '/v1/gateway/webhooks', u, { url: PUBLIC_URL, events: ['key.created'] });
    const id = made.json().endpoint.id as string;
    expect((await call('POST', `/v1/gateway/webhooks/${id}/test`, u)).statusCode).toBeLessThan(300);
    const broken: Sender = async () => { throw new Error('connect ECONNREFUSED'); };
    await pool.query(`UPDATE webhook_deliveries SET next_attempt_at = '2000-01-01T00:00:00Z' WHERE endpoint_id = $1`, [id]);
    expect(await processDueDeliveries(broken)).toBeGreaterThanOrEqual(1);
    // Other test files share this database and may pick the delivery up first with their own sender, so only the shape is checked.
    const [delivery] = (await call('GET', `/v1/gateway/webhooks/${id}/deliveries`, u)).json().deliveries;
    expect(delivery.attempts).toBeGreaterThanOrEqual(1);
    expect(delivery.lastError).toBeTruthy();
    expect(delivery.status).toBe('pending'); // retried later, not delivered
    await pool.query(`UPDATE webhook_deliveries SET status = 'delivered', created_at = '2000-01-01T00:00:00Z' WHERE endpoint_id = $1`, [id]);
    expect(await deleteOldDeliveries()).toBeGreaterThanOrEqual(1);
  });

  it('plans: assigning to someone who does not exist or a plan that does not exist is refused, and an invoice can change status', async () => {
    const u = await mkUser('plan-target');
    await expect(assignPlan('user', u.id, 'nonsense')).rejects.toBeInstanceOf(BillingError);
    await expect(assignPlan('user', rid(), 'developer')).rejects.toMatchObject({ code: 'not_found' });
    await expect(assignPlan('team', rid(), 'developer')).rejects.toMatchObject({ code: 'not_found' });
    expect(await setInvoiceStatus(rid(), 'paid')).toBe(false);
    const invoiceId = rid();
    await pool.query(`INSERT INTO invoices (id, subject_type, subject_id, plan_id, period_start, period_end, lines, subtotal_cents) VALUES ($1,'user',$2,'developer','2026-01-01T00:00:00Z','2026-02-01T00:00:00Z','[]',0)`, [invoiceId, u.id]);
    expect(await setInvoiceStatus(invoiceId, 'paid')).toBe(true);
    expect((await pool.query('SELECT status FROM invoices WHERE id = $1', [invoiceId])).rows[0].status).toBe('paid');
    await pool.query('DELETE FROM invoices WHERE subject_id = $1', [u.id]);
  });

  it('administrator access: the owner manages a list; listed people get the data tables, not the list; removal takes effect at once', async () => {
    const owner = await mkOwner(); // the address put on the owner list in beforeAll
    const helper = await mkUser('acc-helper');
    const stranger = await mkUser('acc-stranger');
    const unconfirmed = await mkUser('acc-unconfirmed', undefined, false);

    // before: nobody but the owner
    expect((await call('GET', '/v1/admin/me', helper)).json()).toEqual({ isAdmin: false, isOwner: false });
    expect((await call('GET', '/v1/admin/me', owner)).json()).toEqual({ isAdmin: true, isOwner: true });
    expect((await call('GET', '/v1/admin/tables', helper)).statusCode).toBe(403);
    expect((await call('GET', '/v1/admin/me', null)).statusCode).toBe(401);

    // only an owner may change the list; refusals are specific
    expect((await call('POST', '/v1/admin/access', helper, { email: helper.email })).statusCode).toBe(403);
    expect((await call('POST', '/v1/admin/access', owner, { email: `nobody-${rid()}@example.com` })).statusCode).toBe(404);
    expect((await call('POST', '/v1/admin/access', owner, { email: unconfirmed.email })).statusCode).toBe(409);
    expect((await call('POST', '/v1/admin/access', owner, { email: adminEmail })).statusCode).toBe(409);
    expect((await call('POST', '/v1/admin/access', owner, { email: 'not an address' })).statusCode).toBe(400);
    const added = await call('POST', '/v1/admin/access', owner, { email: helper.email.toUpperCase(), note: 'support' });
    expect(added.statusCode, added.body).toBe(201);
    expect((await call('POST', '/v1/admin/access', owner, { email: helper.email })).statusCode).toBe(409);

    // the listed person: is an administrator, sees the list and the tables, edits data, but cannot change the list
    expect((await call('GET', '/v1/admin/me', helper)).json()).toEqual({ isAdmin: true, isOwner: false });
    const list = (await call('GET', '/v1/admin/access', helper)).json();
    expect(list.owners).toContain(adminEmail.toLowerCase());
    expect(list.admins.map((a: { email: string }) => a.email)).toContain(helper.email);
    expect((await call('POST', '/v1/admin/access', helper, { email: stranger.email })).statusCode).toBe(403);
    expect((await call('DELETE', `/v1/admin/access/${owner.id}`, helper)).statusCode).toBe(403);
    const tables = (await call('GET', '/v1/admin/tables', helper)).json().tables as Array<{ name: string; editableColumns: string[] }>;
    const plans = tables.find((t) => t.name === 'desk.plans');
    expect(plans?.editableColumns).toContain('monthly_price_cents');
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['desk.users', 'desk.teams', 'desk.subscriptions', 'desk.webhook_endpoints']));

    // editing a plan: a good value is saved (and audited), bad ones are refused in plain words
    const patch = (values: Record<string, unknown>) => app.inject({ method: 'PATCH', url: '/v1/admin/tables/desk.plans/rows/developer', headers: { ...helper.headers, 'cf-connecting-ip': '203.0.113.9' }, payload: { values } });
    const before = (await pool.query(`SELECT monthly_price_cents, max_keys, per_minute_limit FROM plans WHERE id = 'developer'`)).rows[0];
    try {
      const ok = await patch({ monthly_price_cents: '3100', per_minute_limit: '' });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().row).toMatchObject({ monthly_price_cents: 3100, per_minute_limit: null });
      expect((await patch({ monthly_price_cents: 'lots' })).statusCode).toBe(400);
      expect((await patch({ monthly_price_cents: -5 })).statusCode).toBe(400);
      expect((await patch({ active: 'maybe' })).statusCode).toBe(400);
      expect((await patch({ max_keys: '0' })).statusCode).toBe(400); // the database's own rule (must be above zero)
      expect((await patch({ id: 'other' })).statusCode).toBe(400); // not an editable column
    } finally {
      await pool.query(`UPDATE plans SET monthly_price_cents = $1, max_keys = $2, per_minute_limit = $3 WHERE id = 'developer'`, [before.monthly_price_cents, before.max_keys, before.per_minute_limit]);
    }
    expect((await pool.query(`SELECT COUNT(*)::int n FROM mutation_audit_log WHERE user_email = $1 AND action = 'admin_table.update' AND entity_id = 'developer'`, [helper.email])).rows[0].n).toBeGreaterThanOrEqual(1);
    // some tables cannot be deleted from here
    const del = await app.inject({ method: 'DELETE', url: '/v1/admin/tables/desk.plans/rows/free', headers: { ...helper.headers, 'cf-connecting-ip': '203.0.113.9' } });
    expect(del.statusCode).toBe(403);

    // removal is immediate
    expect((await call('DELETE', `/v1/admin/access/${helper.id}`, owner)).statusCode).toBe(204);
    expect((await call('DELETE', `/v1/admin/access/${helper.id}`, owner)).statusCode).toBe(404);
    expect((await call('GET', '/v1/admin/me', helper)).json()).toEqual({ isAdmin: false, isOwner: false });
    expect((await call('GET', '/v1/admin/tables', helper)).statusCode).toBe(403);

    // a listed person whose address is (somehow) not confirmed gets no access
    await call('POST', '/v1/admin/access', owner, { email: stranger.email });
    await pool.query('UPDATE users SET email_confirmed_at = NULL WHERE id = $1', [stranger.id]);
    expect((await call('GET', '/v1/admin/me', stranger)).json().isAdmin).toBe(false);
    await pool.query('DELETE FROM platform_admins WHERE user_id = $1', [stranger.id]);
  });
});
