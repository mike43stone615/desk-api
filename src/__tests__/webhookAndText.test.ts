// Bounce handling (signed provider webhook -> stop mailing that address) and the plain-text copy of every email.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

vi.mock('../db', async () => {
  const { createFakeDb } = await import('./helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { buildApp } from '../app';
import { pool } from '../db';
import { config } from '../config';
import { verifySvixSignature, suppressionFrom } from '../routes/webhooks';
import { resetWebhookSecretCache } from '../domain/email/webhook-secret';
import { htmlToText, sendPasswordResetEmail } from '../infrastructure/email/resend';
import type { AppConfig } from '../config';
import type { createFakeDb } from './helpers/fake-db';
import type { FastifyInstance } from 'fastify';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;
const SECRET = 'whsec_' + Buffer.from('a-test-signing-secret-of-some-length').toString('base64');
let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); }, 30_000);
beforeEach(() => { config.resendWebhookSecret = SECRET; fakeDb.suppressions.clear(); });

function signed(body: string, id = 'msg_1', ts = String(Math.floor(Date.now() / 1000)), secret = SECRET) {
  const sig = createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
}
const bounce = (to: string, type = 'Permanent') => JSON.stringify({ type: 'email.bounced', data: { to: [to], bounce: { type } } });
const mailConfig = { resendApiKey: 're_test', emailFrom: 'noreply@example.com', appBaseUrl: 'https://app.example.com' } as unknown as AppConfig;

describe('signature check', () => {
  it('accepts a good signature; refuses a wrong secret, a changed body, a stale timestamp; accepts any of several listed signatures', () => {
    const body = '{"a":1}';
    const h = signed(body);
    const now = Number(h['svix-timestamp']);
    expect(verifySvixSignature(SECRET, 'msg_1', h['svix-timestamp'], body, h['svix-signature'], now)).toBe(true);
    expect(verifySvixSignature(SECRET, 'msg_1', h['svix-timestamp'], '{"a":2}', h['svix-signature'], now)).toBe(false);
    expect(verifySvixSignature('whsec_' + Buffer.from('other').toString('base64'), 'msg_1', h['svix-timestamp'], body, h['svix-signature'], now)).toBe(false);
    expect(verifySvixSignature(SECRET, 'msg_1', h['svix-timestamp'], body, h['svix-signature'], now + 600)).toBe(false);
    expect(verifySvixSignature(SECRET, 'msg_1', h['svix-timestamp'], body, `v1,AAAA ${h['svix-signature']}`, now)).toBe(true);
    expect(verifySvixSignature(SECRET, 'msg_1', h['svix-timestamp'], body, 'v2,whatever', now)).toBe(false);
  });
});

describe('what counts as stop mailing', () => {
  it('permanent bounces and complaints do; temporary bounces, deliveries and junk do not', () => {
    expect(suppressionFrom(JSON.parse(bounce('A@Example.com')))).toEqual({ emails: ['a@example.com'], reason: 'bounced' });
    expect(suppressionFrom({ type: 'email.complained', data: { to: ['b@example.com'] } })).toEqual({ emails: ['b@example.com'], reason: 'complained' });
    expect(suppressionFrom(JSON.parse(bounce('c@example.com', 'Transient')))).toBeNull();
    expect(suppressionFrom({ type: 'email.delivered', data: { to: ['d@example.com'] } })).toBeNull();
    expect(suppressionFrom(null)).toBeNull();
    expect(suppressionFrom({ type: 'email.bounced', data: { to: 'not-a-list', bounce: { type: 'Permanent' } } })).toBeNull();
  });
});

describe('POST /webhooks/resend', () => {
  it('is off (404) until a secret is configured', async () => {
    resetWebhookSecretCache();
    config.resendApiKey = undefined;
    config.resendWebhookSecret = undefined;
    const body = bounce('x@example.com');
    expect((await app.inject({ method: 'POST', url: '/webhooks/resend', headers: signed(body), payload: body })).statusCode).toBe(404);
  });

  it('a badly signed call is 401 and changes nothing', async () => {
    const body = bounce('x@example.com');
    const wrong = signed(body, 'm', undefined, 'whsec_' + Buffer.from('nope').toString('base64'));
    const res = await app.inject({ method: 'POST', url: '/webhooks/resend', headers: wrong, payload: body });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).code).toBe('invalid_signature');
    expect(fakeDb.suppressions.size).toBe(0);
    expect((await app.inject({ method: 'POST', url: '/webhooks/resend', headers: { 'content-type': 'application/json' }, payload: body })).statusCode).toBe(401);
  });

  it('a signed permanent bounce puts the address on the do-not-mail list, and mail to it is then skipped', async () => {
    const body = bounce('Gone@Example.com');
    expect((await app.inject({ method: 'POST', url: '/webhooks/resend', headers: signed(body), payload: body })).statusCode).toBe(200);
    expect(fakeDb.suppressions.get('gone@example.com')).toMatchObject({ reason: 'bounced' });
    const fetchMock = vi.fn(async () => new Response('{"id":"x"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await sendPasswordResetEmail(mailConfig, 'gone@example.com', 'tok', 'r1');
    expect(fetchMock).not.toHaveBeenCalled();
    await sendPasswordResetEmail(mailConfig, 'fine@example.com', 'tok', 'r2');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('a transient bounce or a delivery event changes nothing', async () => {
    for (const body of [bounce('t@example.com', 'Transient'), JSON.stringify({ type: 'email.delivered', data: { to: ['t@example.com'] } })]) {
      expect((await app.inject({ method: 'POST', url: '/webhooks/resend', headers: signed(body), payload: body })).statusCode).toBe(200);
    }
    expect(fakeDb.suppressions.size).toBe(0);
  });
});

describe('the plain-text copy of an email', () => {
  it('turns links into label: address, drops markup and style, and decodes entities', () => {
    const text = htmlToText('<html><head><style>p{color:red}</style></head><body><h1>Reset &amp; go</h1><p>Hello<br>there</p><a href="https://x.example/r#token=abc">Reset password</a><div>Bye</div></body></html>');
    expect(text.split('\n').filter(Boolean)).toEqual(['Reset & go', 'Hello', 'there', 'Reset password: https://x.example/r#token=abc', 'Bye']);
    expect(text).not.toMatch(/[<>]|color:red/);
  });

  it('every email sent carries both html and text, and the text has the link', async () => {
    const fetchMock = vi.fn(async () => new Response('{"id":"x"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await sendPasswordResetEmail(mailConfig, 'p@example.com', 'tok123', 'r3');
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body));
    expect(sent.html).toContain('<html');
    expect(sent.text).toContain('https://app.example.com/reset-password#token=tok123');
    expect(sent.text).not.toContain('<');
    vi.unstubAllGlobals();
  });
});

describe('a secret held by the mail provider (none in the settings)', () => {
  const providerFetch = (secret: string) => vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith('/webhooks')) return new Response(JSON.stringify({ data: [{ id: 'wh_1', endpoint: 'https://api.example.com/webhooks/resend', status: 'enabled' }] }), { status: 200 });
    if (u.endsWith('/webhooks/wh_1')) return new Response(JSON.stringify({ signing_secret: secret }), { status: 200 });
    return new Response('{}', { status: 404 });
  });

  it('is asked from the provider once, kept, and used to check the signature', async () => {
    resetWebhookSecretCache();
    config.resendWebhookSecret = undefined;
    config.resendApiKey = 're_test';
    const mock = providerFetch(SECRET);
    vi.stubGlobal('fetch', mock);
    const body = bounce('held@example.com');
    expect((await app.inject({ method: 'POST', url: '/webhooks/resend', headers: signed(body), payload: body })).statusCode).toBe(200);
    expect(fakeDb.suppressions.get('held@example.com')).toMatchObject({ reason: 'bounced' });
    const callsAfterFirst = mock.mock.calls.length;
    expect((await app.inject({ method: 'POST', url: '/webhooks/resend', headers: signed(body, 'msg_2'), payload: body })).statusCode).toBe(200);
    expect(mock.mock.calls.length).toBe(callsAfterFirst); // kept in memory: no second lookup
    vi.unstubAllGlobals();
  });

  it('a wrong signature is still refused, and a secret changed at the provider is picked up', async () => {
    resetWebhookSecretCache();
    config.resendWebhookSecret = undefined;
    config.resendApiKey = 're_test';
    const OLD = 'whsec_' + Buffer.from('the-old-signing-secret-of-some-length').toString('base64');
    vi.stubGlobal('fetch', providerFetch(OLD));
    const body = bounce('rot@example.com');
    expect((await app.inject({ method: 'POST', url: '/webhooks/resend', headers: signed(body, 'm', undefined, OLD), payload: body })).statusCode).toBe(200);
    vi.stubGlobal('fetch', providerFetch(SECRET)); // rotated at the provider
    expect((await app.inject({ method: 'POST', url: '/webhooks/resend', headers: signed(body, 'm2'), payload: body })).statusCode).toBe(200);
    const wrong = signed(body, 'm3', undefined, 'whsec_' + Buffer.from('nope').toString('base64'));
    expect((await app.inject({ method: 'POST', url: '/webhooks/resend', headers: wrong, payload: body })).statusCode).toBe(401);
    vi.unstubAllGlobals();
  });

  it('answers 404 when the provider knows no such webhook', async () => {
    resetWebhookSecretCache();
    config.resendWebhookSecret = undefined;
    config.resendApiKey = 're_test';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const body = bounce('none@example.com');
    expect((await app.inject({ method: 'POST', url: '/webhooks/resend', headers: signed(body), payload: body })).statusCode).toBe(404);
    vi.unstubAllGlobals();
  });
});
