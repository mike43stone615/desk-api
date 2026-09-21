// The parts of outbound webhooks that need no database: signing, the replay window, and which addresses are refused.
import { describe, it, expect } from 'vitest';
import { assertSafeWebhookUrl, isPrivateAddress, signPayload, verifySignature } from '../domain/webhooks/webhooks';
import { invoiceLines, FALLBACK_FREE_PLAN } from '../domain/billing/plans';

describe('webhook signatures', () => {
  const secret = 'whsec_test';
  const body = '{"id":"evt_1","type":"key.created"}';
  it('verify when untouched and fresh', () => {
    const header = signPayload(secret, 1_800_000_000, body);
    expect(header).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
    expect(verifySignature(secret, header, body, 1_800_000_000_000)).toBe(true);
  });
  it('fail for a changed body, a wrong secret, or a garbled header', () => {
    const header = signPayload(secret, 1_800_000_000, body);
    expect(verifySignature(secret, header, body + ' ', 1_800_000_000_000)).toBe(false);
    expect(verifySignature('other', header, body, 1_800_000_000_000)).toBe(false);
    expect(verifySignature(secret, 'nonsense', body, 1_800_000_000_000)).toBe(false);
    expect(verifySignature(secret, 't=1800000000,v1=zz', body, 1_800_000_000_000)).toBe(false);
  });
  it('fail outside the five-minute replay window (either side) and pass just inside it', () => {
    const header = signPayload(secret, 1_800_000_000, body);
    expect(verifySignature(secret, header, body, (1_800_000_000 + 299) * 1000)).toBe(true);
    expect(verifySignature(secret, header, body, (1_800_000_000 + 301) * 1000)).toBe(false);
    expect(verifySignature(secret, header, body, (1_800_000_000 - 301) * 1000)).toBe(false);
  });
});

describe('addresses a webhook may not reach', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'])('%s is private', (a) => {
    expect(isPrivateAddress(a)).toBe(true);
  });
  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '172.15.0.1', '2606:4700:4700::1111'])('%s is public', (a) => {
    expect(isPrivateAddress(a)).toBe(false);
  });
  const publicResolver = async () => ['93.184.216.34'];
  it('an https URL to a public address is fine', async () => {
    await expect(assertSafeWebhookUrl('https://hooks.example.com/desk', publicResolver)).resolves.toBeInstanceOf(URL);
    await expect(assertSafeWebhookUrl('https://hooks.example.com:8443/desk', publicResolver)).resolves.toBeInstanceOf(URL);
  });
  it('is refused for http, credentials, odd ports, private names and literals, and hosts that do not resolve', async () => {
    await expect(assertSafeWebhookUrl('http://hooks.example.com/', publicResolver)).rejects.toThrow(/https/);
    await expect(assertSafeWebhookUrl('https://user:pw@hooks.example.com/', publicResolver)).rejects.toThrow(/user name/);
    await expect(assertSafeWebhookUrl('https://hooks.example.com:6379/', publicResolver)).rejects.toThrow(/port/);
    await expect(assertSafeWebhookUrl('https://10.0.0.5/', publicResolver)).rejects.toThrow(/private/);
    await expect(assertSafeWebhookUrl('https://[::1]/', publicResolver)).rejects.toThrow(/private/);
    await expect(assertSafeWebhookUrl('https://internal.example.com/', async () => ['10.0.0.9'])).rejects.toThrow(/private/);
    await expect(assertSafeWebhookUrl('https://mixed.example.com/', async () => ['93.184.216.34', '127.0.0.1'])).rejects.toThrow(/private/);
    await expect(assertSafeWebhookUrl('https://nope.example.com/', async () => { throw new Error('ENOTFOUND'); })).rejects.toThrow(/resolve/);
    await expect(assertSafeWebhookUrl('not a url', publicResolver)).rejects.toThrow(/valid URL/);
  });
});

describe('invoice lines', () => {
  const developer = { ...FALLBACK_FREE_PLAN, id: 'developer', name: 'Developer', monthlyPriceCents: 2900, includedAnalyses: 3000, overageCentsPerAnalysis: 5 };
  it('a paid plan within its included analyses is just the monthly fee', () => {
    expect(invoiceLines(developer, 3000)).toEqual([{ description: 'Developer plan, one month', quantity: 1, unitCents: 2900, totalCents: 2900 }]);
  });
  it('analyses beyond the included number are billed at the overage price, exactly', () => {
    const lines = invoiceLines(developer, 3007);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ quantity: 7, unitCents: 5, totalCents: 35 });
    expect(lines.reduce((n, l) => n + l.totalCents, 0)).toBe(2935);
  });
  it('the free plan and a plan with no overage price produce no lines however much is used', () => {
    expect(invoiceLines(FALLBACK_FREE_PLAN, 100_000)).toEqual([]);
    expect(invoiceLines({ ...developer, overageCentsPerAnalysis: null }, 9000)).toHaveLength(1);
  });
});
