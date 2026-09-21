// The JavaScript client in sdk/typescript: it must send what the API expects, retry what may be retried, and turn every
// failure into one error class that carries the stable code.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DeskClient, DeskApiError, pages, verifyWebhook, SDK_VERSION } from '../../sdk/typescript/src/index';
import { signPayload } from '../domain/webhooks/webhooks';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
afterEach(() => vi.useRealTimers());

describe('DeskClient', () => {
  it('sends the key, a JSON body and a User-Agent with the SDK version to /v1', async () => {
    const f = vi.fn(async () => json({ status: 'likely_available', available: true, message: 'ok', matches: [] }));
    const desk = new DeskClient({ apiKey: 'deskgw_test_abc', fetch: f as unknown as typeof fetch });
    const res = await desk.registry.checkName({ businessName: 'Acme LLC', stateOfFormation: 'FL' });
    expect(res.available).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deskbusiness.co/v1/gateway/registry/name-availability');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('deskgw_test_abc');
    expect((init.headers as Record<string, string>)['user-agent']).toBe(`desk-api-library-js/${SDK_VERSION}`);
    expect(JSON.parse(String(init.body))).toEqual({ businessName: 'Acme LLC', stateOfFormation: 'FL' });
    expect(desk.isSandbox).toBe(true);
    expect(new DeskClient({ apiKey: 'deskgw_live' }).isSandbox).toBe(false);
  });

  it('turns a problem answer into a DeskApiError with the status, code, request id and field errors', async () => {
    const f = vi.fn(async () => json({ title: 'Bad Request', detail: 'businessName is required', code: 'validation_error', errors: [{ field: 'businessName', message: 'required', code: 'required' }] }, 400, { 'x-request-id': 'req-1' }));
    const desk = new DeskClient({ apiKey: 'k', fetch: f as unknown as typeof fetch });
    const err = await desk.registry.checkName({ businessName: '', stateOfFormation: 'FL' }).catch((e) => e);
    expect(err).toBeInstanceOf(DeskApiError);
    expect(err).toMatchObject({ status: 400, code: 'validation_error', requestId: 'req-1', message: 'businessName is required' });
    expect(err.errors[0].field).toBe('businessName');
    expect(f).toHaveBeenCalledTimes(1); // a 400 is never retried
  });

  it('retries a 429 after the Retry-After delay, then succeeds', async () => {
    vi.useFakeTimers();
    const f = vi.fn().mockResolvedValueOnce(json({ code: 'rate_limited' }, 429, { 'retry-after': '3' })).mockResolvedValueOnce(json({ ok: true }));
    const desk = new DeskClient({ apiKey: 'k', fetch: f as unknown as typeof fetch });
    const p = desk.request('GET', '/auth/session');
    await vi.advanceTimersByTimeAsync(2900);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries and throws the last answer', async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => json({ code: 'upstream_unavailable' }, 503, { 'retry-after': '1' }));
    const desk = new DeskClient({ apiKey: 'k', maxRetries: 2, fetch: f as unknown as typeof fetch });
    const p = desk.request('GET', '/x').catch((e) => e);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toMatchObject({ status: 503, code: 'upstream_unavailable' });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('a client with no key is refused at once', () => {
    expect(() => new DeskClient({ apiKey: '' })).toThrow(/apiKey/);
  });

  it('graphql posts the query and variables', async () => {
    const f = vi.fn(async () => json({ data: { viewer: { id: '1' } } }));
    const desk = new DeskClient({ apiKey: 'k', fetch: f as unknown as typeof fetch });
    expect((await desk.graphql('{ viewer { id } }', { a: 1 })).data).toEqual({ viewer: { id: '1' } });
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ query: '{ viewer { id } }', variables: { a: 1 } });
  });
});

describe('pages()', () => {
  it('follows hasMore until the list ends', async () => {
    const data = [[1, 2], [3, 4], [5]];
    const seen: number[] = [];
    for await (const n of pages(async (offset) => { const i = offset / 2; return { items: data[i], hasMore: i < data.length - 1 }; })) seen.push(n);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('verifyWebhook (the same rules as the server signs with)', () => {
  const body = '{"id":"evt_1","type":"key.created"}';
  it('accepts what the server signs, and rejects tampering, the wrong secret and a stale timestamp', () => {
    const t = Math.floor(Date.now() / 1000);
    const header = signPayload('whsec_x', t, body);
    expect(verifyWebhook('whsec_x', header, body)).toBe(true);
    expect(verifyWebhook('whsec_x', header, body + 'x')).toBe(false);
    expect(verifyWebhook('whsec_y', header, body)).toBe(false);
    expect(verifyWebhook('whsec_x', signPayload('whsec_x', t - 600, body), body)).toBe(false);
    expect(verifyWebhook('whsec_x', 'garbage', body)).toBe(false);
  });
});
