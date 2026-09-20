// Nothing that grants access, and no email address, may reach the logs or an error report.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import pino from 'pino';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));
vi.mock('../../infrastructure/email/resend', async () => (await import('../helpers/email-capture')).emailModuleMock());

import { buildApp } from '../../app';
import { config } from '../../config';
import { emailFingerprint, loggerOptions, scrubSentryEvent, scrubUrl } from '../../middleware/log-redaction';
import type { FastifyInstance } from 'fastify';

const lines: string[] = [];
let app: FastifyInstance;
beforeAll(async () => {
  config.logLevel = 'info'; // the suite runs quiet; this test needs to see what would be logged
  app = await buildApp({ logStream: { write: (l: string) => lines.push(l) } });
});

const SECRETS = ['S3ssion-Cookie-Value-abc', 'Bearer-Token-Value-xyz', 'deskgw_' + 'f'.repeat(48), 'Sup3r!Secret-Pass', 'one-time-token-123456', 'victim.person@example.com'];

describe('scrubUrl', () => {
  it('hides the value of sensitive query parameters and keeps the rest', () => {
    expect(scrubUrl('/x?token=abc&state=FL')).toBe('/x?token=[redacted]&state=FL');
    expect(scrubUrl('/x?API_KEY=abc&a=1&Password=p')).toBe('/x?API_KEY=[redacted]&a=1&Password=[redacted]');
    expect(scrubUrl('/plain')).toBe('/plain');
    expect(scrubUrl('/x?q=hello world')).toBe('/x?q=hello+world');
    expect(scrubUrl(undefined)).toBe('');
  });
});

describe('emailFingerprint', () => {
  it('is stable across case and spaces, differs per address, and does not contain the address', () => {
    expect(emailFingerprint(' A@B.com ')).toBe(emailFingerprint('a@b.com'));
    expect(emailFingerprint('a@b.com')).not.toBe(emailFingerprint('c@b.com'));
    expect(emailFingerprint('a@b.com')).toMatch(/^email:[0-9a-f]{12}$/);
  });
});

describe('the logger', () => {
  it('redacts credentials and bodies wherever they appear in a logged object', () => {
    const out: string[] = [];
    const log = pino(loggerOptions('info'), { write: (l: string) => out.push(l) });
    log.info({
      req: { headers: { authorization: 'Bearer ' + SECRETS[1], cookie: 'desk_session=' + SECRETS[0], 'x-api-key': SECRETS[2] } },
      res: { headers: { 'set-cookie': 'desk_session=' + SECRETS[0] } },
      user: { password: SECRETS[3], token: SECRETS[4] },
      body: { password: SECRETS[3], email: SECRETS[5] },
      err: { message: 'boom', detail: 'Key (email)=(' + SECRETS[5] + ') already exists.' },
    }, 'something happened');
    const text = out.join('');
    for (const s of SECRETS) expect(text, s).not.toContain(s);
    expect(text).toContain('something happened');
    expect(text).toContain('[redacted]');
  });
});

describe('what the running service logs', () => {
  it('never contains the credentials or addresses a request carried', async () => {
    lines.length = 0;
    await app.inject({ method: 'GET', url: `/auth/session?token=${SECRETS[4]}&x=1`, headers: { authorization: 'Bearer ' + SECRETS[1], cookie: 'desk_session=' + SECRETS[0], 'x-api-key': SECRETS[2] } });
    await app.inject({ method: 'POST', url: '/auth/signin', payload: { email: SECRETS[5], password: SECRETS[3] } });
    await app.inject({ method: 'POST', url: '/auth/password-reset/request', payload: { email: SECRETS[5] } });
    await app.inject({ method: 'POST', url: '/auth/email-confirmation/request', payload: { email: SECRETS[5] } });
    await app.inject({ method: 'POST', url: '/auth/email-confirmation/confirm', payload: { token: SECRETS[4] } });
    await app.inject({ method: 'GET', url: '/gateway/registry/business-structures?key=' + SECRETS[2], headers: { 'x-api-key': SECRETS[2] } });
    expect(lines.length).toBeGreaterThan(5);
    const text = lines.join('');
    for (const s of SECRETS) expect(text, `log contained ${s}`).not.toContain(s);
  });

  it('still says useful things: the request, the outcome, and the audit event with a fingerprint', async () => {
    lines.length = 0;
    await app.inject({ method: 'POST', url: '/auth/signin', headers: { 'cf-connecting-ip': '203.0.113.9' }, payload: { email: 'someone@example.com', password: 'Wrong!Pass1' } });
    const parsed = lines.map((l) => JSON.parse(l));
    const audit = parsed.find((l) => l.event === 'signin_failed');
    expect(audit).toBeTruthy();
    expect(audit.account).toMatch(/^email:[0-9a-f]{12}$/);
    expect(JSON.stringify(parsed)).not.toContain('someone@example.com');
    const incoming = parsed.find((l) => l.req && l.msg === 'incoming request');
    expect(incoming.req).toMatchObject({ method: 'POST', url: '/auth/signin', clientIp: '203.0.113.9' });
    expect(parsed.some((l) => l.res?.statusCode === 401)).toBe(true);
  });
});

describe('error reports (Sentry)', () => {
  it('strip credentials, cookies, bodies and sensitive query values before sending', () => {
    const event = scrubSentryEvent({
      message: 'boom',
      request: {
        url: `https://api.deskbusiness.co/auth/x?token=${SECRETS[4]}&y=2`,
        query_string: `token=${SECRETS[4]}&y=2`,
        headers: { Authorization: 'Bearer ' + SECRETS[1], Cookie: 'desk_session=' + SECRETS[0], 'X-Api-Key': SECRETS[2], 'user-agent': 'curl/8' },
        cookies: { desk_session: SECRETS[0] },
        data: { password: SECRETS[3] },
      },
    });
    const text = JSON.stringify(event);
    for (const s of SECRETS.slice(0, 5)) expect(text, s).not.toContain(s);
    expect(text).toContain('curl/8');
    expect(text).toContain('y=2');
    expect(JSON.stringify(event)).not.toContain('desk_session');
  });

  it('leaves an event with no request part alone', () => {
    expect(scrubSentryEvent({ message: 'x' })).toEqual({ message: 'x' });
  });
});
