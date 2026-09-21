// Round 3 (September 2026): the mail queue, the mail-key check, e-mail link hosts, sign-up throttles, Unicode
// normalization, and the per-key limit lookup.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('../db', () => ({ pool: { query: queryMock } }));
vi.mock('../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { deliverViaProvider, processOutbox, queueForRetry } from '../domain/email/outbox';
import { checkMailKeyIfChanged, keyFingerprint } from '../domain/email/key-check';
import { emailLinkBase } from '../domain/email/link-base';
import { checkSignupDomainLimit, checkSignupRateLimit, emailDomain } from '../middleware/signup-limiter';
import { setRouteLimitsEnabledForTests } from '../middleware/route-limits';
import { nfc, nfcDeep } from '../utils/strings';
import { forgetKeyRateFactors, keyRateFactor } from '../domain/gateway/keys';
import { config } from '../config';

const mail = { resendApiKey: 're_test', emailFrom: 'noreply@example.com' };
const okResponse = () => new Response('{"id":"x"}', { status: 200 });

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
});
afterEach(() => vi.unstubAllGlobals());

describe('sending through the provider', () => {
  it('a busy or broken provider and an unreachable network are worth trying again; a refusal is not', async () => {
    for (const [status, transient] of [[429, true], [500, true], [503, true], [422, false], [400, false], [403, false]] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status })));
      expect(await deliverViaProvider(mail, { to: 'a@example.com', subject: 's', html: '<p>x</p>' })).toMatchObject({ ok: false, transient });
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ETIMEDOUT'); }));
    expect(await deliverViaProvider(mail, { to: 'a@example.com', subject: 's', html: '<p>x</p>' })).toMatchObject({ ok: false, status: 0, transient: true });
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
    expect(await deliverViaProvider(mail, { to: 'a@example.com', subject: 's', html: '<p>x</p>' })).toMatchObject({ ok: true });
  });
});

describe('the mail queue', () => {
  it('a failed transient send is queued', async () => {
    await queueForRetry({ to: 'a@example.com', subject: 's', html: '<p>x</p>', kind: 'k', error: '503 down' });
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(String(queryMock.mock.calls[0][0])).toContain('INSERT INTO email_outbox');
  });

  it('a queued e-mail that now goes through is deleted; one that fails again is delayed; one that keeps failing is given up on', async () => {
    const due = [
      { id: 'sent', to_email: 'a@example.com', subject: 's', html: '<p>x</p>', attempts: 0 },
      { id: 'again', to_email: 'b@example.com', subject: 's', html: '<p>x</p>', attempts: 0 },
      { id: 'last', to_email: 'c@example.com', subject: 's', html: '<p>x</p>', attempts: 3 },
      { id: 'refused', to_email: 'd@example.com', subject: 's', html: '<p>x</p>', attempts: 0 },
    ];
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM email_outbox WHERE next_attempt_at')) return { rows: due, rowCount: due.length };
      if (sql.includes('COUNT(*)')) return { rows: [{ n: '1' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      if (n === 1) return okResponse(); // 'sent'
      if (n === 4) return new Response('bad address', { status: 422 }); // 'refused'
      return new Response('down', { status: 503 }); // 'again', 'last'
    }));
    const result = await processOutbox(mail);
    expect(result).toMatchObject({ sent: 1, gaveUp: 2, waiting: 1 });
    const sqls = queryMock.mock.calls.map((c) => String(c[0]));
    expect(sqls.filter((s) => s.startsWith('DELETE FROM email_outbox')).length).toBe(3); // sent, last, refused
    expect(sqls.filter((s) => s.startsWith('UPDATE email_outbox')).length).toBe(1); // again
  });

  it('does nothing without a mail key', async () => {
    expect(await processOutbox({ resendApiKey: undefined as unknown as string, emailFrom: 'x@example.com' })).toEqual({ sent: 0, gaveUp: 0, waiting: 0 });
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('the mail-key check', () => {
  it('asks the provider only when the key differs from the last one proven, and remembers a good answer', async () => {
    const key = 're_first_key';
    queryMock.mockResolvedValueOnce({ rows: [] }); // nothing remembered yet
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"data":[]}', { status: 200 })));
    expect(await checkMailKeyIfChanged({ resendApiKey: key })).toBe('ok');
    expect(String(queryMock.mock.calls.at(-1)?.[0])).toContain('INSERT INTO system_state');
    queryMock.mockReset();
    queryMock.mockResolvedValueOnce({ rows: [{ value: keyFingerprint(key) }] });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await checkMailKeyIfChanged({ resendApiKey: key })).toBe('unchanged');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a refused key is reported and is not remembered', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"API key is invalid"}', { status: 401 })));
    expect(await checkMailKeyIfChanged({ resendApiKey: 're_bad' })).toBe('refused');
    expect(queryMock.mock.calls.some((c) => String(c[0]).includes('INSERT INTO system_state'))).toBe(false);
    expect(await checkMailKeyIfChanged({ resendApiKey: undefined })).toBe('not_configured');
  });
});

describe('where an e-mail link leads', () => {
  it('library pages finish on the library host; everything else, and any other origin, goes to the app', () => {
    const app = config.appBaseUrl;
    expect(emailLinkBase({ headers: { origin: 'https://api.deskbusiness.co' } })).toBe('https://api.deskbusiness.co');
    expect(emailLinkBase({ headers: { origin: 'https://api.deskbusiness.co/' } })).toBe('https://api.deskbusiness.co');
    expect(emailLinkBase({ headers: {} })).toBe(app);
    expect(emailLinkBase({ headers: { origin: 'https://evil.example' } })).toBe(app);
  });
});

describe('sign-up throttles', () => {
  beforeEach(() => { process.env.NODE_ENV = 'production'; setRouteLimitsEnabledForTests(true); });
  afterEach(() => { process.env.NODE_ENV = 'test'; setRouteLimitsEnabledForTests(false); });

  it('5 an hour from one address; the sixth is refused', async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200)}`;
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await checkSignupRateLimit(ip));
    expect(results).toEqual([true, true, true, true, true, false]);
  });

  it('10 an hour from one ordinary e-mail domain; big public providers get a far higher ceiling', async () => {
    const domain = `small-${Math.random().toString(36).slice(2)}.example`;
    const results = [];
    for (let i = 0; i < 11; i++) results.push(await checkSignupDomainLimit(`p${i}@${domain}`));
    expect(results.slice(0, 10).every(Boolean)).toBe(true);
    expect(results[10]).toBe(false);
    for (let i = 0; i < 50; i++) expect(await checkSignupDomainLimit(`p${i}@gmail.com`)).toBe(true);
    expect(emailDomain('a@B.Example')).toBe('b.example');
    expect(emailDomain('nonsense')).toBeNull();
  });
});

describe('Unicode normalization', () => {
  it('turns a letter plus an accent into the single accented letter, everywhere inside a value', () => {
    const decomposed = 'Café';
    expect(nfc(decomposed)).toBe('Café');
    expect(nfcDeep({ name: decomposed, list: [decomposed, 3, null], nested: { [decomposed]: decomposed } })).toEqual({ name: 'Café', list: ['Café', 3, null], nested: { 'Café': 'Café' } });
  });
});

describe('a limit set for one key', () => {
  it('becomes a share of an address allowance, is remembered for a minute, and is absent when not set', async () => {
    forgetKeyRateFactors();
    queryMock.mockResolvedValueOnce({ rows: [{ rate_limit_per_minute: 240 }] });
    expect(await keyRateFactor('deskgw_aaa', 120)).toBe(2);
    expect(await keyRateFactor('deskgw_aaa', 120)).toBe(2);
    expect(queryMock).toHaveBeenCalledTimes(1);
    queryMock.mockResolvedValueOnce({ rows: [{ rate_limit_per_minute: null }] });
    expect(await keyRateFactor('deskgw_bbb', 120)).toBeNull();
    queryMock.mockRejectedValueOnce(new Error('db down'));
    expect(await keyRateFactor('deskgw_ccc', 120)).toBeNull();
    forgetKeyRateFactors();
  });
});
