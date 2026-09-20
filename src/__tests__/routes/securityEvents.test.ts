// Security events are stored and shown to the account's owner (items 32), and important ones are emailed (item 33).
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
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
import { emailed } from '../helpers/email-capture';
import { hashPassword } from '../../domain/auth/password';
import { ipNeighbourhood } from '../../domain/auth/security-notices';
import { deleteExpiredSecurityEvents } from '../../modules/audit/security-events';
import type { FastifyInstance } from 'fastify';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;
let app: FastifyInstance;
let hash: string;
const PASSWORD = 'Str0ng!Pass1';
beforeAll(async () => {
  app = await buildApp();
  hash = await hashPassword(PASSWORD);
});
beforeEach(() => {
  fakeDb.securityEvents.length = 0;
  emailed.security.clear();
});

let n = 0;
function seedUser() {
  n += 1;
  const id = `se-${n}`;
  const now = new Date().toISOString();
  fakeDb.users.set(id, { id, email: `${id}@example.com`, password_hash: hash, first_name: 'S', last_name: 'E', email_confirmed_at: now, created_at: now, updated_at: now });
  return { id, email: `${id}@example.com` };
}
const flush = () => new Promise((r) => setTimeout(r, 15)); // events and emails are sent in the background
const signIn = (email: string, ip: string, ua: string, password = PASSWORD) =>
  app.inject({ method: 'POST', url: '/auth/signin', headers: { 'cf-connecting-ip': ip, 'user-agent': ua }, payload: { email, password } });
const tokenOf = (res: { body: string }) => JSON.parse(res.body).token as string;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const activity = async (t: string) => JSON.parse((await app.inject({ method: 'GET', url: '/auth/activity', headers: bearer(t) })).body).events as Array<Record<string, unknown>>;

describe('stored security events', () => {
  it('records sign-ins with address and browser, and shows them to the owner newest first', async () => {
    const u = seedUser();
    await signIn(u.email, '203.0.113.5', 'Chrome/120 Windows');
    const t = tokenOf(await signIn(u.email, '198.51.100.8', 'Safari/17 macOS'));
    await flush();
    const events = await activity(t);
    const ins = events.filter((e) => e.event === 'signin_success');
    expect(ins).toHaveLength(2);
    expect(ins[0]).toMatchObject({ label: 'Signed in', outcome: 'ok', ip: '198.51.100.8', userAgent: 'Safari/17 macOS' });
    expect(ins[1]).toMatchObject({ ip: '203.0.113.5', userAgent: 'Chrome/120 Windows' });
    expect(new Date(String(ins[0].at)).getTime()).toBeGreaterThanOrEqual(new Date(String(ins[1].at)).getTime());
  });

  it('failed attempts against the address are shown too, without the attacker ever holding a session', async () => {
    const u = seedUser();
    await signIn(u.email, '192.0.2.99', 'attacker/1', 'Wrong!Pass1');
    await signIn(u.email, '192.0.2.99', 'attacker/1', 'Wrong!Pass2');
    const t = tokenOf(await signIn(u.email, '203.0.113.5', 'me/1'));
    await flush();
    const failed = (await activity(t)).filter((e) => e.event === 'signin_failed');
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatchObject({ label: 'Failed sign-in attempt', outcome: 'error', ip: '192.0.2.99', userAgent: 'attacker/1' });
  });

  it('password changes, session endings and API keys are recorded', async () => {
    const u = seedUser();
    const t = tokenOf(await signIn(u.email, '203.0.113.5', 'me/1'));
    await app.inject({ method: 'POST', url: '/auth/password', headers: bearer(t), payload: { password: 'An0ther!Pass1' } });
    await app.inject({ method: 'POST', url: '/auth/signout-all', headers: bearer(t), payload: { keepCurrent: true } });
    config.gatewayKeyEncryptionSecret = 'ab'.repeat(32);
    await app.inject({ method: 'POST', url: '/gateway/api-keys', headers: bearer(t), payload: { label: 'ci', services: ['desk_api'] } });
    await flush();
    const kinds = (await activity(t)).map((e) => e.event);
    expect(kinds).toEqual(expect.arrayContaining(['signin_success', 'password_updated', 'signout_everywhere', 'gateway_key_created']));
  });

  it('never shows anyone else\'s events, and stores no email address or secret', async () => {
    const a = seedUser();
    const b = seedUser();
    const ta = tokenOf(await signIn(a.email, '203.0.113.5', 'a/1'));
    await signIn(b.email, '203.0.113.6', 'b/1', 'Wrong!Pass1');
    await flush();
    expect((await activity(ta)).every((e) => e.ip !== '203.0.113.6')).toBe(true);
    const stored = JSON.stringify(fakeDb.securityEvents);
    expect(stored).not.toContain(a.email);
    expect(stored).not.toContain(b.email);
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(ta);
  });

  it('needs a session (401) and an API Library key cannot read it (403)', async () => {
    expect((await app.inject({ method: 'GET', url: '/auth/activity' })).statusCode).toBe(401);
    const u = seedUser();
    const t = tokenOf(await signIn(u.email, '203.0.113.5', 'me/1'));
    config.gatewayKeyEncryptionSecret = 'ab'.repeat(32);
    const key = JSON.parse((await app.inject({ method: 'POST', url: '/gateway/api-keys', headers: bearer(t), payload: { label: 'k', services: ['desk_api'] } })).body).apiKey.key;
    expect((await app.inject({ method: 'GET', url: '/auth/activity', headers: { 'x-api-key': key } })).statusCode).toBe(403);
  });

  it('events older than 180 days are deleted daily, newer ones stay', async () => {
    fakeDb.securityEvents.push({ id: 'old', event: 'signin_success', created_at: new Date(Date.now() - 200 * 86_400_000).toISOString() });
    fakeDb.securityEvents.push({ id: 'new', event: 'signin_success', created_at: new Date().toISOString() });
    await deleteExpiredSecurityEvents();
    expect(fakeDb.securityEvents.map((e) => e.id)).toEqual(['new']);
  });
});

describe('security emails', () => {
  it('a password change emails the owner', async () => {
    const u = seedUser();
    const t = tokenOf(await signIn(u.email, '203.0.113.5', 'me/1'));
    await app.inject({ method: 'POST', url: '/auth/password', headers: bearer(t), payload: { password: 'An0ther!Pass1' } });
    await flush();
    expect(emailed.security.get(u.email)).toContain('Your password was changed');
  });

  it('a completed password reset emails the owner (the reset link alone proves nothing to them)', async () => {
    const u = seedUser();
    await app.inject({ method: 'POST', url: '/auth/password-reset/request', payload: { email: u.email } });
    const token = emailed.reset.get(u.email)!;
    expect((await app.inject({ method: 'POST', url: '/auth/password-reset/confirm', payload: { token, password: 'Reset!Pass123' } })).statusCode).toBe(200);
    await flush();
    expect(emailed.security.get(u.email)).toContain('Your password was reset');
    const t = tokenOf(await signIn(u.email, '203.0.113.5', 'me/1', 'Reset!Pass123'));
    await flush();
    expect((await activity(t)).map((e) => e.event)).toContain('password_reset_confirmed');
  });

  it('a wrong or reused reset link emails nobody', async () => {
    const u = seedUser();
    await app.inject({ method: 'POST', url: '/auth/password-reset/confirm', payload: { token: 'nope', password: 'Reset!Pass123' } });
    await flush();
    expect(emailed.security.get(u.email)).toBeUndefined();
  });

  it('a new API key emails the owner with its name', async () => {
    const u = seedUser();
    const t = tokenOf(await signIn(u.email, '203.0.113.5', 'me/1'));
    config.gatewayKeyEncryptionSecret = 'ab'.repeat(32);
    await app.inject({ method: 'POST', url: '/gateway/api-keys', headers: bearer(t), payload: { label: 'deploy bot', services: ['desk_api'] } });
    await flush();
    expect(emailed.security.get(u.email)).toContain('A new API key was created');
  });

  describe('new sign-in from an unfamiliar browser or network', () => {
    it('the very first sign-in does not email (nothing to compare with)', async () => {
      const u = seedUser();
      await signIn(u.email, '203.0.113.5', 'Chrome/120 Windows');
      await flush();
      expect(emailed.security.get(u.email)).toBeUndefined();
    });

    it('the same browser from the same part of the network does not email, even from a different last part of the address', async () => {
      const u = seedUser();
      await signIn(u.email, '203.0.113.5', 'Chrome/120 Windows');
      await flush();
      await signIn(u.email, '203.0.44.200', 'Chrome/120 Windows');
      await flush();
      expect(emailed.security.get(u.email)).toBeUndefined();
    });

    it('a different browser, or a different network, emails once per sign-in', async () => {
      const u = seedUser();
      await signIn(u.email, '203.0.113.5', 'Chrome/120 Windows');
      await flush();
      await signIn(u.email, '203.0.113.5', 'Firefox/121 Linux');
      await flush();
      await signIn(u.email, '45.67.89.10', 'Chrome/120 Windows');
      await flush();
      expect(emailed.security.get(u.email)).toEqual(['New sign-in to your account', 'New sign-in to your account']);
    });

    it('a failed sign-in never emails', async () => {
      const u = seedUser();
      await signIn(u.email, '203.0.113.5', 'Chrome/120 Windows');
      await flush();
      await signIn(u.email, '45.67.89.10', 'attacker/1', 'Wrong!Pass1');
      await flush();
      expect(emailed.security.get(u.email)).toBeUndefined();
    });
  });

  it('ipNeighbourhood keeps the network part of an address', () => {
    expect(ipNeighbourhood('203.0.113.5')).toBe('203.0');
    expect(ipNeighbourhood('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3:8d3');
    expect(ipNeighbourhood(null)).toBe('');
  });
});
