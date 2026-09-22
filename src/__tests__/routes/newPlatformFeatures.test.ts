// Two-factor authentication, per-key IP/business restrictions, manual webhook redelivery, and status-page subscriptions —
// all against the fake in-memory database (see helpers/fake-db.ts), the same style as gateway.test.ts and securityEvents.test.ts.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { createFakeDb } from '../helpers/fake-db';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));
vi.mock('../../infrastructure/email/resend', async () => (await import('../helpers/email-capture')).emailModuleMock());

import { pool } from '../../db';
import { buildApp } from '../../app';
import { config } from '../../config';
import { hashPassword } from '../../domain/auth/password';
import { base32Decode } from '../../domain/auth/totp';
import { emailed } from '../helpers/email-capture';
import type { FastifyInstance } from 'fastify';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;
let app: FastifyInstance;
const PASSWORD = 'Str0ng!Pass1';
let hash: string;

function totpAt(secretB32: string, timeMs: number): string {
  const counter = Math.floor(timeMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const hmac = createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 1e6).padStart(6, '0');
}

let n = 0;
function seedUser() {
  n += 1;
  const id = `npf-${n}`;
  const now = new Date().toISOString();
  fakeDb.users.set(id, { id, email: `${id}@example.com`, password_hash: hash, first_name: 'N', last_name: 'P', email_confirmed_at: now, created_at: now, updated_at: now });
  return { id, email: `${id}@example.com` };
}
const signIn = (email: string, password = PASSWORD) => app.inject({ method: 'POST', url: '/auth/signin', headers: { 'cf-connecting-ip': '203.0.113.44' }, payload: { email, password } });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  config.gatewayKeyEncryptionSecret = 'ab'.repeat(32);
  hash = await hashPassword(PASSWORD);
  app = await buildApp();
});

beforeEach(() => {
  emailed.security.clear();
});

describe('two-factor authentication', () => {
  it('the whole lifecycle: off, setup, a wrong code, a right code enables it with backup codes, sign-in now needs a second step, wrong then right code, backup code, disable', async () => {
    const u = seedUser();
    const s0 = await signIn(u.email);
    const t0 = JSON.parse(s0.body).token as string;

    const st0 = await app.inject({ method: 'GET', url: '/auth/2fa', headers: bearer(t0) });
    expect(JSON.parse(st0.body)).toEqual({ enabled: false, unusedBackupCodes: 0 });

    const setup = await app.inject({ method: 'POST', url: '/auth/2fa/setup', headers: bearer(t0) });
    expect(setup.statusCode).toBe(200);
    const { secret, otpauthUri } = JSON.parse(setup.body);
    expect(otpauthUri).toContain(secret);

    const badEnable = await app.inject({ method: 'POST', url: '/auth/2fa/enable', headers: bearer(t0), payload: { code: '000000' } });
    expect(badEnable.statusCode).toBe(400);

    const enable = await app.inject({ method: 'POST', url: '/auth/2fa/enable', headers: bearer(t0), payload: { code: totpAt(secret, Date.now()) } });
    expect(enable.statusCode).toBe(201);
    const backupCodes = JSON.parse(enable.body).backupCodes as string[];
    expect(backupCodes).toHaveLength(10);
    expect(emailed.security.get(u.email)?.some((title) => title.includes('turned on'))).toBe(true);

    const st1 = await app.inject({ method: 'GET', url: '/auth/2fa', headers: bearer(t0) });
    expect(JSON.parse(st1.body)).toEqual({ enabled: true, unusedBackupCodes: 10 });

    // signing in now stops short of a session
    const s1 = await signIn(u.email);
    const step1 = JSON.parse(s1.body);
    expect(step1).toMatchObject({ mfaRequired: true });
    expect(step1.token).toBeUndefined();
    expect(s1.headers['set-cookie']).toBeUndefined();

    const wrong = await app.inject({ method: 'POST', url: '/auth/2fa/verify', payload: { mfaToken: step1.mfaToken, code: '111111' } });
    expect(wrong.statusCode).toBe(401);
    // the pending token was consumed by that failed attempt (single use either way): trying again is also refused
    const reuse = await app.inject({ method: 'POST', url: '/auth/2fa/verify', payload: { mfaToken: step1.mfaToken, code: totpAt(secret, Date.now()) } });
    expect(reuse.statusCode).toBe(401);

    const s2 = await signIn(u.email);
    const step2 = JSON.parse(s2.body);
    const verify = await app.inject({ method: 'POST', url: '/auth/2fa/verify', headers: { 'user-agent': 'ok' }, payload: { mfaToken: step2.mfaToken, code: totpAt(secret, Date.now()) } });
    expect(verify.statusCode).toBe(200);
    const t1 = JSON.parse(verify.body).token as string;
    expect(t1).toBeTruthy();
    expect((await app.inject({ method: 'GET', url: '/auth/session', headers: bearer(t1) })).statusCode).toBe(200);

    // a backup code also completes sign-in, and only once
    const s3 = await signIn(u.email);
    const step3 = JSON.parse(s3.body);
    const viaBackup = await app.inject({ method: 'POST', url: '/auth/2fa/verify', payload: { mfaToken: step3.mfaToken, code: backupCodes[0] } });
    expect(viaBackup.statusCode).toBe(200);
    const s4 = await signIn(u.email);
    const step4 = JSON.parse(s4.body);
    expect((await app.inject({ method: 'POST', url: '/auth/2fa/verify', payload: { mfaToken: step4.mfaToken, code: backupCodes[0] } })).statusCode).toBe(401);

    const regen = await app.inject({ method: 'POST', url: '/auth/2fa/backup-codes', headers: bearer(t0), payload: { code: totpAt(secret, Date.now()) } });
    expect(regen.statusCode).toBe(200);
    expect(JSON.parse(regen.body).backupCodes).toHaveLength(10);
    // the old backup code (already used) and any of the un-regenerated ones no longer verify a sign-in either
    const s5 = await signIn(u.email);
    const step5 = JSON.parse(s5.body);
    expect((await app.inject({ method: 'POST', url: '/auth/2fa/verify', payload: { mfaToken: step5.mfaToken, code: backupCodes[1] } })).statusCode).toBe(401);

    const badDisable = await app.inject({ method: 'POST', url: '/auth/2fa/disable', headers: bearer(t1), payload: { password: 'wrong', code: totpAt(secret, Date.now()) } });
    expect(badDisable.statusCode).toBe(403); // wrong current password, same as every other requireCurrentPassword-gated route
    const disable = await app.inject({ method: 'POST', url: '/auth/2fa/disable', headers: bearer(t1), payload: { password: PASSWORD, code: totpAt(secret, Date.now()) } });
    expect(disable.statusCode).toBe(200);
    expect(JSON.parse(disable.body)).toEqual({ enabled: false });
    expect(emailed.security.get(u.email)?.some((title) => title.includes('turned off'))).toBe(true);

    // sign-in is back to normal (one step)
    const back = await signIn(u.email);
    expect(JSON.parse(back.body).token).toBeTruthy();
  });

  it('cannot be enabled twice, or confirmed/disabled without ever starting setup', async () => {
    const u = seedUser();
    const t = JSON.parse((await signIn(u.email)).body).token as string;
    expect((await app.inject({ method: 'POST', url: '/auth/2fa/enable', headers: bearer(t), payload: { code: '123456' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/auth/2fa/disable', headers: bearer(t), payload: { password: PASSWORD, code: '123456' } })).statusCode).toBe(409);
    const setup = await app.inject({ method: 'POST', url: '/auth/2fa/setup', headers: bearer(t) });
    const { secret } = JSON.parse(setup.body);
    await app.inject({ method: 'POST', url: '/auth/2fa/enable', headers: bearer(t), payload: { code: totpAt(secret, Date.now()) } });
    expect((await app.inject({ method: 'POST', url: '/auth/2fa/setup', headers: bearer(t) })).statusCode).toBe(409);
  });

  it('every 2FA route needs a session', async () => {
    for (const req of [
      { method: 'GET' as const, url: '/auth/2fa' },
      { method: 'POST' as const, url: '/auth/2fa/setup' },
      { method: 'POST' as const, url: '/auth/2fa/enable' },
      { method: 'POST' as const, url: '/auth/2fa/disable' },
      { method: 'POST' as const, url: '/auth/2fa/backup-codes' },
    ]) {
      expect((await app.inject(req)).statusCode, req.url).toBe(401);
    }
  });
});

describe('gateway key restrictions', () => {
  it('an IP allowlist refuses every other address, and clearing it restores access', async () => {
    const u = seedUser();
    const t = JSON.parse((await signIn(u.email)).body).token as string;
    const created = await app.inject({ method: 'POST', url: '/gateway/api-keys', headers: bearer(t), payload: { label: 'k', services: ['desk_api'] } });
    const { id, key } = JSON.parse(created.body).apiKey;
    expect((await app.inject({ method: 'GET', url: '/auth/session', headers: { 'x-api-key': key } })).statusCode).toBe(200);

    const restrict = await app.inject({ method: 'PATCH', url: `/gateway/api-keys/${id}/restrictions`, headers: bearer(t), payload: { allowedIps: ['198.51.100.9'] } });
    expect(restrict.statusCode).toBe(200);
    expect(JSON.parse(restrict.body).apiKey.allowedIps).toEqual(['198.51.100.9']);

    const refused = await app.inject({ method: 'GET', url: '/auth/session', headers: { 'x-api-key': key, 'cf-connecting-ip': '203.0.113.9' } });
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body).code).toBe('api_key_ip_not_allowed');
    const allowed = await app.inject({ method: 'GET', url: '/auth/session', headers: { 'x-api-key': key, 'cf-connecting-ip': '198.51.100.9' } });
    expect(allowed.statusCode).toBe(200);

    const cleared = await app.inject({ method: 'PATCH', url: `/gateway/api-keys/${id}/restrictions`, headers: bearer(t), payload: { allowedIps: null } });
    expect(JSON.parse(cleared.body).apiKey.allowedIps).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/auth/session', headers: { 'x-api-key': key, 'cf-connecting-ip': '203.0.113.9' } })).statusCode).toBe(200);
  });

  it('restricting to a business needs the businesses scope, membership, and refuses a team key', async () => {
    const u = seedUser();
    const t = JSON.parse((await signIn(u.email)).body).token as string;
    const noBizScope = await app.inject({ method: 'POST', url: '/gateway/api-keys', headers: bearer(t), payload: { label: 'k', services: ['desk_api'], deskScopes: ['profile'] } });
    const { id: noBizId } = JSON.parse(noBizScope.body).apiKey;
    expect((await app.inject({ method: 'PATCH', url: `/gateway/api-keys/${noBizId}/restrictions`, headers: bearer(t), payload: { businessId: 'nope' } })).statusCode).toBe(400);

    const withBizScope = await app.inject({ method: 'POST', url: '/gateway/api-keys', headers: bearer(t), payload: { label: 'k2', services: ['desk_api'], deskScopes: ['profile', 'businesses'] } });
    const { id } = JSON.parse(withBizScope.body).apiKey;
    expect((await app.inject({ method: 'PATCH', url: `/gateway/api-keys/${id}/restrictions`, headers: bearer(t), payload: { businessId: 'not-mine' } })).statusCode).toBe(404);

    const bizId = 'biz-1';
    fakeDb.businesses.set(bizId, { id: bizId, user_id: u.id, name: 'Restricted Co', industry: null, business_json: '{}', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    fakeDb.memberships.set('mem-1', { id: 'mem-1', business_id: bizId, user_id: u.id, role: 'owner', accepted_at: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const ok = await app.inject({ method: 'PATCH', url: `/gateway/api-keys/${id}/restrictions`, headers: bearer(t), payload: { businessId: bizId } });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).apiKey.restrictedBusinessId).toBe(bizId);
  });

  it("cannot restrict a key that is not the caller's own", async () => {
    const a = seedUser();
    const b = seedUser();
    const ta = JSON.parse((await signIn(a.email)).body).token as string;
    const tb = JSON.parse((await signIn(b.email)).body).token as string;
    const created = await app.inject({ method: 'POST', url: '/gateway/api-keys', headers: bearer(ta), payload: { label: 'k', services: ['desk_api'] } });
    const { id } = JSON.parse(created.body).apiKey;
    expect((await app.inject({ method: 'PATCH', url: `/gateway/api-keys/${id}/restrictions`, headers: bearer(tb), payload: { allowedIps: ['198.51.100.1'] } })).statusCode).toBe(404);
  });
});

describe('manual webhook redelivery', () => {
  it('only a failed delivery on your own endpoint can be retried, and it goes back to pending', async () => {
    const owner = seedUser();
    const stranger = seedUser();
    const to = JSON.parse((await signIn(owner.email)).body).token as string;
    const ts = JSON.parse((await signIn(stranger.email)).body).token as string;
    const created = await app.inject({ method: 'POST', url: '/gateway/webhooks', headers: bearer(to), payload: { url: 'https://93.184.216.34/hook', events: ['key.created'] } });
    const { id: endpointId } = JSON.parse(created.body).endpoint;

    fakeDb.webhookDeliveries.push({
      id: 'd1', endpoint_id: endpointId, event_id: 'evt_1', event_type: 'key.created', payload: '{}', status: 'failed',
      attempts: 5, next_attempt_at: null, last_status: 500, last_error: 'boom', created_at: new Date().toISOString(), delivered_at: null,
    });

    expect((await app.inject({ method: 'POST', url: `/gateway/webhooks/${endpointId}/deliveries/d1/retry`, headers: bearer(ts) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/gateway/webhooks/${endpointId}/deliveries/does-not-exist/retry`, headers: bearer(to) })).statusCode).toBe(404);

    const retry = await app.inject({ method: 'POST', url: `/gateway/webhooks/${endpointId}/deliveries/d1/retry`, headers: bearer(to) });
    expect(retry.statusCode).toBe(202);
    const row = fakeDb.webhookDeliveries.find((d) => d.id === 'd1')!;
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);

    // it is pending now, not failed, so retrying again right away finds nothing to retry
    expect((await app.inject({ method: 'POST', url: `/gateway/webhooks/${endpointId}/deliveries/d1/retry`, headers: bearer(to) })).statusCode).toBe(404);
  });
});

describe('status-page e-mail subscriptions', () => {
  it('subscribing, confirming and unsubscribing, each redirecting back to /status with a banner', async () => {
    const email = 'subscriber@example.com';
    const sub = await app.inject({ method: 'POST', url: '/status/subscribe', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `email=${encodeURIComponent(email)}` });
    expect(sub.statusCode).toBe(302);
    expect(sub.headers.location).toBe('/status?banner=subscribed');
    const row = [...fakeDb.statusSubscribers.values()].find((r) => r.email === email);
    expect(row).toBeTruthy();
    expect(row!.confirmed_at).toBeNull();

    const badEmail = await app.inject({ method: 'POST', url: '/status/subscribe', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'email=not-an-address' });
    expect(badEmail.headers.location).toBe('/status?banner=subscribe_error');

    const badConfirm = await app.inject({ method: 'GET', url: '/status/subscribe/confirm?token=garbage' });
    expect(badConfirm.headers.location).toBe('/status?banner=subscribe_error');

    // The confirmation e-mail's link carries "<confirmToken>.<unsubscribeToken>" as a single query param (see
    // subscribers.subscribe / app.ts's confirm route) — captured here exactly as it was handed to the mail sender,
    // same pattern as every other email-link test in this codebase (see email-capture.ts).
    const mailedToken = emailed.statusSubscribe.get(email);
    expect(mailedToken).toBeTruthy();
    const [, unsubscribeToken] = mailedToken!.split('.');
    const confirm = await app.inject({ method: 'GET', url: `/status/subscribe/confirm?token=${encodeURIComponent(mailedToken!)}` });
    expect(confirm.headers.location).toBe('/status?banner=confirmed');
    expect([...fakeDb.statusSubscribers.values()].find((r) => r.email === email)!.confirmed_at).toBeTruthy();
    // a second confirm attempt with the same (now-spent) token fails
    expect((await app.inject({ method: 'GET', url: `/status/subscribe/confirm?token=${encodeURIComponent(mailedToken!)}` })).headers.location).toBe('/status?banner=subscribe_error');

    const unsub = await app.inject({ method: 'GET', url: `/status/subscribe/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}` });
    expect(unsub.headers.location).toBe('/status?banner=unsubscribed');
    expect([...fakeDb.statusSubscribers.values()].find((r) => r.email === email)).toBeUndefined();
  });

  it('the status page itself shows the subscribe form and a banner when redirected back to it', async () => {
    const page = await app.inject({ method: 'GET', url: '/status', headers: { accept: 'text/html' } });
    expect(page.body).toContain('action="/status/subscribe"');
    const banner = await app.inject({ method: 'GET', url: '/status?banner=confirmed', headers: { accept: 'text/html' } });
    expect(banner.body).toContain('You&#39;re subscribed'); // HTML-escaped apostrophe, same as every other rendered string on this page
  });
});
