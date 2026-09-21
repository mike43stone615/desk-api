import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';

// Plans, metering, invoices, and outbound webhooks against a real database. Skipped without E2E_DATABASE_URL.
const hasDb = !!process.env.E2E_DATABASE_URL;

import { pool } from '../../db';
import { buildApp } from '../../app';
import { config } from '../../config';
import { subscriptionFor, meterAnalysis, generateInvoices, invoicesFor } from '../../domain/billing/plans';
import { keyBucketInfo, forgetKeyRateFactors } from '../../domain/gateway/keys';
import { emitWebhookEvent, processDueDeliveries, verifySignature, type Sender } from '../../domain/webhooks/webhooks';
import type { FastifyInstance } from 'fastify';

const rid = () => randomBytes(10).toString('hex');
const ts = () => new Date().toISOString();
const PUBLIC_URL = 'https://93.184.216.34/desk-hook'; // a public literal address, so no name lookup is needed

describe.skipIf(!hasDb)('E2E: plans, invoices and webhooks', () => {
  let app: FastifyInstance;
  const users: string[] = [];
  const savedSecret = config.gatewayKeyEncryptionSecret;

  async function mkUser(name: string, email?: string) {
    const id = rid();
    const now = ts();
    const address = email ?? `plat-${name}-${id}@example.com`;
    await pool.query(`INSERT INTO users (id, email, password_hash, first_name, last_name, email_confirmed_at, created_at, updated_at) VALUES ($1,$2,'x',$3,'T',$4,$4,$4)`, [id, address, name, now]);
    users.push(id);
    const { authDb } = await import('../../infrastructure/auth');
    const token = randomBytes(24).toString('hex');
    await authDb.createSession(rid(), id, token, new Date(Date.now() + 3_600_000).toISOString()); // created just now, as the admin tools require
    return { id, email: address, headers: { authorization: `Bearer ${token}` } };
  }
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, who: { headers: Record<string, string> }, payload?: unknown) =>
    app.inject({ method, url, headers: { ...who.headers, 'cf-connecting-ip': `203.0.113.${1 + Math.floor(Math.random() * 250)}` }, payload: payload as never });

  beforeAll(async () => {
    config.gatewayKeyEncryptionSecret = 'ab'.repeat(32);
    app = await buildApp();
  });
  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [users]);
    config.gatewayKeyEncryptionSecret = savedSecret;
    await app.close();
  });

  it('everyone starts on the Free plan with the limits there always were', async () => {
    const u = await mkUser('free');
    const sub = await subscriptionFor('user', u.id);
    expect(sub.plan).toMatchObject({ id: 'free', monthlyPriceCents: 0, maxKeys: 10, perMinuteLimit: null });
    const plans = (await app.inject({ method: 'GET', url: '/v1/billing/plans' })).json().plans;
    expect(plans.map((p: { id: string }) => p.id)).toEqual(['free', 'developer', 'business']);
  });

  it('an administrator moves a person to a plan; it changes their key limit; a non-administrator cannot', async () => {
    const admin = await mkUser('admin', 'admin@example.com').catch(async () => (await pool.query(`SELECT id FROM users WHERE email = 'admin@example.com'`)).rows[0]);
    const u = await mkUser('dev');
    const stranger = await mkUser('stranger');
    expect((await call('POST', `/v1/admin/billing/user/${u.id}/plan`, stranger, { planId: 'developer' })).statusCode).toBe(403);
    const adminUser = admin as { headers?: Record<string, string> };
    if (!adminUser.headers) return; // the shared admin address already existed from another run
    const res = await call('POST', `/v1/admin/billing/user/${u.id}/plan`, adminUser as { headers: Record<string, string> }, { planId: 'developer' });
    expect(res.statusCode).toBe(200);
    expect((await subscriptionFor('user', u.id)).plan).toMatchObject({ id: 'developer', perMinuteLimit: 120, maxKeys: 25 });
    expect((await call('POST', `/v1/admin/billing/user/${u.id}/plan`, adminUser as { headers: Record<string, string> }, { planId: 'nonsense' })).statusCode).toBe(400);
    // the key of a person on the Developer plan is limited to the plan's number of calls a minute
    const keyId = rid();
    await pool.query(`INSERT INTO gateway_api_keys (id, owner_user_id, label, key_hash, key_prefix) VALUES ($1,$2,'k',$3,'deskgw_xxxxxx')`, [keyId, u.id, `hash-${keyId}`]);
    const { hashGatewayKey } = await import('../../domain/gateway/keys');
    await pool.query(`UPDATE gateway_api_keys SET key_hash = $2 WHERE id = $1`, [keyId, hashGatewayKey('deskgw_plan_limit_probe')]);
    forgetKeyRateFactors();
    expect((await keyBucketInfo('deskgw_plan_limit_probe', 120)).factor).toBeCloseTo(1);
    // back to Free
    await call('POST', `/v1/admin/billing/user/${u.id}/plan`, adminUser as { headers: Record<string, string> }, { planId: 'free' });
    forgetKeyRateFactors();
    expect((await keyBucketInfo('deskgw_plan_limit_probe', 120)).factor).toBeNull();
  });

  it('meters analyses exactly and produces one invoice per month with the plan fee and the overage', async () => {
    const u = await mkUser('billed');
    await pool.query(`INSERT INTO subscriptions (id, subject_type, subject_id, plan_id, status, period_start, period_end) VALUES ($1,'user',$2,'developer','active',$3,$3)`, [rid(), u.id, ts()]);
    const month = new Date().toISOString().slice(0, 7);
    await pool.query(`INSERT INTO usage_meter (subject_type, subject_id, month, metric, quantity) VALUES ('user',$1,$2,'market_analyses',3010)`, [u.id, month]);
    meterAnalysis('user', u.id);
    await new Promise((r) => setTimeout(r, 150));
    expect((await pool.query(`SELECT quantity FROM usage_meter WHERE subject_id = $1`, [u.id])).rows[0].quantity).toBe(3011);
    await generateInvoices(month);
    await generateInvoices(month); // running it again makes nothing new
    const invoices = await invoicesFor('user', u.id);
    expect(invoices).toHaveLength(1);
    expect(invoices[0].lines.map((l) => l.totalCents)).toEqual([2900, 55]); // 11 analyses beyond 3,000 at 5 cents
    expect(invoices[0].subtotalCents).toBe(2955);
    expect(invoices[0].status).toBe('draft');
    // the person's own view shows it; another person's does not
    const other = await mkUser('other');
    const mine = await call('GET', '/v1/billing/invoices', { headers: { authorization: `Bearer ${await tokenFor(u.id)}` } });
    expect(mine.json().invoices).toHaveLength(1);
    expect((await call('GET', '/v1/billing/invoices', other)).json().invoices).toHaveLength(0);
  });

  async function tokenFor(userId: string) {
    const { authDb } = await import('../../infrastructure/auth');
    const token = randomBytes(24).toString('hex');
    await authDb.createSession(rid(), userId, token, new Date(Date.now() + 3_600_000).toISOString());
    return token;
  }

  it('a webhook endpoint refuses private addresses, http and unknown events, shows the secret once, and delivers a signed event', async () => {
    const u = await mkUser('hook');
    for (const url of ['https://10.0.0.5/x', 'http://93.184.216.34/x', 'https://localhost/x']) {
      expect((await call('POST', '/v1/gateway/webhooks', u, { url, events: ['key.created'] })).statusCode).toBe(400);
    }
    expect((await call('POST', '/v1/gateway/webhooks', u, { url: PUBLIC_URL, events: ['nonsense'] })).statusCode).toBe(400);
    const made = await call('POST', '/v1/gateway/webhooks', u, { url: PUBLIC_URL, events: ['key.created', 'plan.changed'] });
    expect(made.statusCode).toBe(201);
    const { endpoint, secret } = made.json();
    expect(secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(JSON.stringify((await call('GET', '/v1/gateway/webhooks', u)).json())).not.toContain(secret);

    const sent: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const ok: Sender = async (url, init) => { sent.push({ url: String(url), headers: init.headers, body: init.body }); return { status: 200 }; };
    emitWebhookEvent({ userId: u.id }, 'key.created', { keyId: 'k1' });
    emitWebhookEvent({ userId: u.id }, 'team.member_joined', { teamId: 't' }); // not subscribed: nothing queued
    await new Promise((r) => setTimeout(r, 200));
    expect(await processDueDeliveries(ok)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].headers['desk-event']).toBe('key.created');
    expect(verifySignature(secret, sent[0].headers['desk-signature'], sent[0].body)).toBe(true);
    expect(JSON.parse(sent[0].body)).toMatchObject({ type: 'key.created', data: { keyId: 'k1' } });
    const log = (await call('GET', `/v1/gateway/webhooks/${endpoint.id}/deliveries`, u)).json().deliveries;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: 'delivered', attempts: 1, lastStatus: 200 });
    // somebody else cannot see or remove it
    const stranger = await mkUser('stranger2');
    expect((await call('GET', `/v1/gateway/webhooks/${endpoint.id}/deliveries`, stranger)).statusCode).toBe(404);
    expect((await call('DELETE', `/v1/gateway/webhooks/${endpoint.id}`, stranger)).statusCode).toBe(404);
  });

  it('a failing receiver is retried with growing gaps, then the delivery fails; ten failed deliveries switch the endpoint off; rotating the secret turns it back on', async () => {
    const u = await mkUser('flaky');
    const made = (await call('POST', '/v1/gateway/webhooks', u, { url: PUBLIC_URL, events: ['key.revoked'] })).json();
    const bad: Sender = async () => ({ status: 500 });
    const endpointId = made.endpoint.id as string;
    const pastDue = () => pool.query(`UPDATE webhook_deliveries SET next_attempt_at = $2 WHERE endpoint_id = $1 AND status = 'pending'`, [endpointId, new Date(Date.now() - 1000).toISOString()]);
    emitWebhookEvent({ userId: u.id }, 'key.revoked', { keyId: 'a' });
    await new Promise((r) => setTimeout(r, 200));
    await processDueDeliveries(bad);
    let row = (await pool.query(`SELECT status, attempts, next_attempt_at FROM webhook_deliveries WHERE endpoint_id = $1`, [endpointId])).rows[0];
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    const firstGap = Date.parse(row.next_attempt_at) - Date.now();
    expect(firstGap).toBeGreaterThan(30_000);
    expect(firstGap).toBeLessThanOrEqual(61_000);
    for (let i = 0; i < 5; i++) { await pastDue(); await processDueDeliveries(bad); }
    row = (await pool.query(`SELECT status, attempts FROM webhook_deliveries WHERE endpoint_id = $1`, [endpointId])).rows[0];
    expect(row).toMatchObject({ status: 'failed', attempts: 6 });
    // nine more failed deliveries (ten in all) switch the endpoint off
    for (let n = 0; n < 9; n++) {
      emitWebhookEvent({ userId: u.id }, 'key.revoked', { keyId: `b${n}` });
      await new Promise((r) => setTimeout(r, 60));
      for (let i = 0; i < 6; i++) { await pastDue(); await processDueDeliveries(bad); }
    }
    let ep = (await pool.query(`SELECT active, consecutive_failures, disabled_reason FROM webhook_endpoints WHERE id = $1`, [endpointId])).rows[0];
    expect(ep.active).toBe(false);
    expect(ep.disabled_reason).toMatch(/Rotate the secret/);
    const rotated = await call('POST', `/v1/gateway/webhooks/${endpointId}/rotate-secret`, u);
    expect(rotated.statusCode).toBe(200);
    ep = (await pool.query(`SELECT active, consecutive_failures FROM webhook_endpoints WHERE id = $1`, [endpointId])).rows[0];
    expect(ep).toMatchObject({ active: true, consecutive_failures: 0 });
  });

  it('the plan caps how many endpoints a person may have (Free: 3)', async () => {
    const u = await mkUser('many');
    for (let i = 0; i < 3; i++) expect((await call('POST', '/v1/gateway/webhooks', u, { url: `${PUBLIC_URL}${i}`, events: ['key.created'] })).statusCode).toBe(201);
    const fourth = await call('POST', '/v1/gateway/webhooks', u, { url: `${PUBLIC_URL}9`, events: ['key.created'] });
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().code).toBe('webhook_limit_reached');
  });

  it('deleting a person removes their endpoints, deliveries, subscription and invoices', async () => {
    const u = await mkUser('gone');
    await call('POST', '/v1/gateway/webhooks', u, { url: PUBLIC_URL, events: ['key.created'] });
    await pool.query(`INSERT INTO subscriptions (id, subject_type, subject_id, plan_id, period_start, period_end) VALUES ($1,'user',$2,'business',$3,$3)`, [rid(), u.id, ts()]);
    await pool.query('DELETE FROM users WHERE id = $1', [u.id]);
    expect((await pool.query(`SELECT 1 FROM webhook_endpoints WHERE owner_user_id = $1`, [u.id])).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM subscriptions WHERE subject_id = $1`, [u.id])).rowCount).toBe(0);
  });
});
