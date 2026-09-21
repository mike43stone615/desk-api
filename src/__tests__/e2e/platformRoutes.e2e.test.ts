import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

// The routes around the platform features that the other end-to-end files only touch in passing: the status page's incidents,
// the changelog feed, plans and invoices as seen by a person and by a team, GraphQL beyond the happy path, and the ways an
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
  const savedSecret = config.gatewayKeyEncryptionSecret;
  const adminEmail = `plat-admin-${rid()}@example.com`;

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
    config.gatewayKeyEncryptionSecret = 'ab'.repeat(32);
    config.adminEmails.push(adminEmail.toLowerCase());
    app = await buildApp();
  });
  afterAll(async () => {
    if (incidents.length) await pool.query('DELETE FROM incidents WHERE id = ANY($1)', [incidents]);
    await pool.query('DELETE FROM teams WHERE id IN (SELECT team_id FROM team_members WHERE user_id = ANY($1))', [users]);
    await pool.query('DELETE FROM subscriptions WHERE subject_id = ANY($1)', [users]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [users]);
    config.adminEmails.splice(config.adminEmails.indexOf(adminEmail.toLowerCase()), 1);
    config.gatewayKeyEncryptionSecret = savedSecret;
    await app.close();
  });

  it('incidents: an administrator opens one and posts updates, everyone can read them, and bad input is refused', async () => {
    const admin = await mkUser('admin', adminEmail);
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

  it('billing: a person and a team see their own plan, usage and invoices; outsiders and non-admins are kept out', async () => {
    const owner = await mkUser('boss');
    const dev = await mkUser('dev');
    const outsider = await mkUser('outsider');
    expect((await call('GET', '/v1/billing/subscription', null)).statusCode).toBe(401);

    const mine = await call('GET', '/v1/billing/subscription', owner);
    expect(mine.statusCode).toBe(200);
    expect(mine.json().subscription).toMatchObject({ subjectType: 'user', subjectId: owner.id, status: 'active' });
    expect(mine.json().usage).toMatchObject({ marketAnalyses: 0 });
    expect((await call('GET', '/v1/billing/invoices', owner)).json()).toEqual({ hasMore: false, invoices: [] });

    const team = (await call('POST', '/v1/teams', owner, { name: 'Billing team' })).json().team;
    expect((await call('POST', `/v1/teams/${team.id}/members`, owner, { email: dev.email, role: 'developer' })).statusCode).toBeLessThan(300);
    await pool.query(`UPDATE team_members SET accepted_at = now() WHERE team_id = $1 AND user_id = $2`, [team.id, dev.id]).catch(() => {});

    const teamSub = await call('GET', `/v1/billing/subscription?teamId=${team.id}`, owner);
    expect(teamSub.statusCode).toBe(200);
    expect(teamSub.json().subscription).toMatchObject({ subjectType: 'team', subjectId: team.id });
    expect((await call('GET', `/v1/billing/invoices?teamId=${team.id}`, owner)).statusCode).toBe(200);
    expect((await call('GET', `/v1/billing/subscription?teamId=${team.id}`, outsider)).statusCode).toBe(404);
    expect((await call('GET', `/v1/billing/invoices?teamId=${team.id}`, outsider)).statusCode).toBe(404);
    // a developer on the team may see the plan but invoices need an admin
    const devInvoices = await call('GET', `/v1/billing/invoices?teamId=${team.id}`, dev);
    expect([403, 404]).toContain(devInvoices.statusCode);
  });

  it('GraphQL: a team\'s keys and plan for members, refusals for outsiders, key usage, drafts and business members', async () => {
    const owner = await mkUser('gq-owner');
    const outsider = await mkUser('gq-outsider');
    const team = (await call('POST', '/v1/teams', owner, { name: 'Graph team' })).json().team;
    const keyRes = await call('POST', '/v1/gateway/api-keys', owner, { label: 'team key', services: ['registry_api'], teamId: team.id });
    expect(keyRes.statusCode, keyRes.body).toBe(201);
    const keyId = keyRes.json().apiKey.id as string;

    const ok = await gql(owner, `{ apiKeys(teamId: "${team.id}") { id label } plan(teamId: "${team.id}") { id } usage(keyId: "${keyId}", days: 7) { day calls } }`);
    const body = ok.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.apiKeys.map((k: { id: string }) => k.id)).toContain(keyId);
    expect(body.data.plan.id).toBe('free');
    expect(Array.isArray(body.data.usage)).toBe(true);

    const mineOnly = (await gql(owner, '{ apiKeys { id } plan { id } }')).json();
    expect(mineOnly.data.plan.id).toBe('free');
    expect(mineOnly.data.apiKeys.map((k: { id: string }) => k.id)).not.toContain(keyId);

    for (const q of [`{ apiKeys(teamId: "${team.id}") { id } }`, `{ plan(teamId: "${team.id}") { id } }`, `{ usage(keyId: "${keyId}") { day } }`]) {
      const denied = (await gql(outsider, q)).json();
      expect(denied.errors[0].extensions.code, q).toBe('NOT_FOUND');
    }

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
    expect((await call('POST', '/v1/gateway/webhooks', u, { url: 'http://93.184.216.34/x', events: ['key.created'] })).statusCode).toBe(400);
    expect((await call('POST', '/v1/gateway/webhooks', u, { url: 'https://127.0.0.1/x', events: ['key.created'] })).statusCode).toBe(400);
    expect((await call('POST', '/v1/gateway/webhooks', u, { url: PUBLIC_URL, events: ['key.created'], teamId: rid() })).statusCode).toBeGreaterThanOrEqual(403);

    const made = await call('POST', '/v1/gateway/webhooks', u, { url: PUBLIC_URL, events: ['key.created'] });
    expect(made.statusCode).toBe(201);
    const id = made.json().endpoint.id as string;
    expect(made.json().secret).toMatch(/^whsec_/);

    for (const [method, path] of [['DELETE', `/v1/gateway/webhooks/${id}`], ['POST', `/v1/gateway/webhooks/${id}/test`], ['POST', `/v1/gateway/webhooks/${id}/rotate-secret`], ['GET', `/v1/gateway/webhooks/${id}/deliveries`]] as const) {
      expect((await call(method, path, other)).statusCode, `${method} ${path} by someone else`).toBe(404);
      const missing = path.replace(id, rid());
      expect((await call(method, missing, u)).statusCode, `${method} ${missing}`).toBe(404);
    }
    expect((await call('GET', '/v1/gateway/webhooks?teamId=' + rid(), u)).statusCode).toBeGreaterThanOrEqual(403);
    expect((await call('DELETE', `/v1/gateway/webhooks/${id}`, u)).statusCode).toBe(204);
  });

  it('team webhooks: an admin manages them, a developer or viewer may not, and members can list them', async () => {
    const owner = await mkUser('tw-owner');
    const dev = await mkUser('tw-dev');
    const outsider = await mkUser('tw-outsider');
    const team = (await call('POST', '/v1/teams', owner, { name: 'Hook team' })).json().team;
    await call('POST', `/v1/teams/${team.id}/members`, owner, { email: dev.email, role: 'developer' });
    await pool.query(`UPDATE team_members SET accepted_at = now() WHERE team_id = $1 AND user_id = $2`, [team.id, dev.id]);

    const made = await call('POST', '/v1/gateway/webhooks', owner, { url: PUBLIC_URL, events: ['key.created'], teamId: team.id });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json().endpoint.id as string;
    expect((await call('POST', '/v1/gateway/webhooks', dev, { url: PUBLIC_URL, events: ['key.created'], teamId: team.id })).statusCode).toBe(403);
    expect((await call('POST', '/v1/gateway/webhooks', outsider, { url: PUBLIC_URL, events: ['key.created'], teamId: team.id })).statusCode).toBe(404);
    expect((await call('GET', `/v1/gateway/webhooks?teamId=${team.id}`, dev)).json().endpoints.map((e: { id: string }) => e.id)).toContain(id);
    expect((await call('GET', `/v1/gateway/webhooks?teamId=${team.id}`, outsider)).statusCode).toBe(404);
    expect((await call('POST', `/v1/gateway/webhooks/${id}/test`, dev)).statusCode).toBe(404);
    expect((await call('DELETE', `/v1/gateway/webhooks/${id}`, dev)).statusCode).toBe(404);
    expect((await call('POST', `/v1/gateway/webhooks/${id}/test`, owner)).statusCode).toBeLessThan(300);
    expect((await call('DELETE', `/v1/gateway/webhooks/${id}`, owner)).statusCode).toBe(204);
  });

  it('a receiver that cannot be reached is recorded as a failed try, and old finished deliveries are cleared out', async () => {
    const u = await mkUser('tw-fail');
    const made = await call('POST', '/v1/gateway/webhooks', u, { url: PUBLIC_URL, events: ['key.created'] });
    const id = made.json().endpoint.id as string;
    expect((await call('POST', `/v1/gateway/webhooks/${id}/test`, u)).statusCode).toBeLessThan(300);
    const broken: Sender = async () => { throw new Error('connect ECONNREFUSED'); };
    await pool.query(`UPDATE webhook_deliveries SET next_attempt_at = '2000-01-01T00:00:00Z' WHERE endpoint_id = $1`, [id]);
    expect(await processDueDeliveries(broken)).toBeGreaterThanOrEqual(1);
    const list = (await call('GET', `/v1/gateway/webhooks/${id}/deliveries`, u)).json();
    expect(JSON.stringify(list)).toContain('ECONNREFUSED');
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
});
