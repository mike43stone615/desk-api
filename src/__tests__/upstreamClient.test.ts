// The shared way of calling backends: retries, circuit breaker, in-flight limits, answer-size ceiling, timeouts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { breakerState, callUpstream, resetUpstreamState, UpstreamError, type UpstreamPolicy } from '../domain/upstream/client';

const policy = (over: Partial<UpstreamPolicy> = {}): UpstreamPolicy => ({
  service: 'svc',
  timeoutMs: 1000,
  maxResponseBytes: 1000,
  retryable: false,
  maxInFlight: 5,
  maxInFlightPerHolder: 2,
  ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;
const reply = (status = 200, body = '{"ok":true}', headers: Record<string, string> = {}) => new Response(body, { status, headers });
const GET = { method: 'GET' } as const;

beforeEach(() => {
  resetUpstreamState();
  fetchMock = vi.fn(async () => reply());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.stubGlobal('fetch', realFetch);
  vi.useRealTimers();
});

describe('a normal call', () => {
  it('returns status, headers and the text', async () => {
    fetchMock.mockResolvedValueOnce(reply(201, '{"a":1}', { 'x-thing': 'y' }));
    const res = await callUpstream('http://x/a', GET, policy());
    expect(res).toMatchObject({ status: 201, text: '{"a":1}' });
    expect(res.headers.get('x-thing')).toBe('y');
  });

  it('a 4xx answer is passed back and does not count against the backend', async () => {
    fetchMock.mockImplementation(async () => reply(404, '{"error":"no"}'));
    for (let i = 0; i < 8; i++) expect((await callUpstream('http://x', GET, policy())).status).toBe(404);
    expect(breakerState('svc')).toBe('closed');
  });
});

describe('answer size ceiling', () => {
  it('refuses an answer whose declared length is over the ceiling, without reading it', async () => {
    const big = reply(200, 'x'.repeat(5000), { 'content-length': '5000' });
    fetchMock.mockResolvedValueOnce(big);
    await expect(callUpstream('http://x', GET, policy())).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/too large/) });
  });

  it('stops reading a streamed answer with no declared length once it passes the ceiling', async () => {
    let pulled = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulled += 400;
        controller.enqueue(new Uint8Array(400));
        if (pulled > 100_000) controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }));
    await expect(callUpstream('http://x', GET, policy())).rejects.toBeInstanceOf(UpstreamError);
    expect(pulled).toBeLessThan(5000); // it did not keep pulling a hundred kilobytes
  });

  it('accepts an answer exactly at the ceiling', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, 'y'.repeat(1000)));
    expect((await callUpstream('http://x', GET, policy())).text).toHaveLength(1000);
  });
});

describe('retries', () => {
  it('a lookup is retried once after a network error, and the second answer is used', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(reply(200, '{"n":2}'));
    const res = await callUpstream('http://x', GET, policy({ retryable: true }));
    expect(res.text).toBe('{"n":2}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('...and after a 503 (but never more than once)', async () => {
    fetchMock.mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(reply(503));
    const res = await callUpstream('http://x', GET, policy({ retryable: true }));
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a 500 is not retried (the request itself may be at fault)', async () => {
    fetchMock.mockResolvedValue(reply(500));
    await callUpstream('http://x', GET, policy({ retryable: true }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('something that is not a lookup is never repeated', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    await expect(callUpstream('http://x', { method: 'POST', body: '{}' }, policy({ retryable: false }))).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 4xx is never retried', async () => {
    fetchMock.mockResolvedValue(reply(429));
    await callUpstream('http://x', GET, policy({ retryable: true }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('timeouts', () => {
  it('a backend that never answers is given up on at the timeout', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted')))));
    const t0 = Date.now();
    await expect(callUpstream('http://x', GET, policy({ timeoutMs: 80 }))).rejects.toMatchObject({ status: 502 });
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('circuit breaker', () => {
  const failing = () => fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

  it('opens after five failures in a row and then refuses instantly, saying when to retry', async () => {
    failing();
    for (let i = 0; i < 5; i++) await expect(callUpstream('http://x', GET, policy())).rejects.toMatchObject({ status: 502 });
    expect(breakerState('svc')).toBe('open');
    fetchMock.mockClear();
    const err = await callUpstream('http://x', GET, policy()).catch((e) => e as UpstreamError);
    expect(err).toMatchObject({ status: 503, retryAfterSeconds: 15 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a success in between resets the count', async () => {
    failing();
    for (let i = 0; i < 4; i++) await callUpstream('http://x', GET, policy()).catch(() => {});
    fetchMock.mockReset().mockResolvedValue(reply());
    await callUpstream('http://x', GET, policy());
    failing();
    for (let i = 0; i < 4; i++) await callUpstream('http://x', GET, policy()).catch(() => {});
    expect(breakerState('svc')).toBe('closed');
  });

  it('after the cool-off one trial call decides: success closes it, failure reopens it', async () => {
    vi.useFakeTimers();
    failing();
    for (let i = 0; i < 5; i++) await callUpstream('http://x', GET, policy()).catch(() => {});
    expect(breakerState('svc')).toBe('open');
    vi.advanceTimersByTime(16_000);
    expect(breakerState('svc')).toBe('half-open');

    fetchMock.mockReset().mockRejectedValue(new Error('still down'));
    await expect(callUpstream('http://x', GET, policy())).rejects.toMatchObject({ status: 502 });
    expect(breakerState('svc')).toBe('open');

    vi.advanceTimersByTime(16_000);
    fetchMock.mockReset().mockResolvedValue(reply());
    await callUpstream('http://x', GET, policy());
    expect(breakerState('svc')).toBe('closed');
  });

  it('while the trial call is running, other calls are still refused', async () => {
    vi.useFakeTimers();
    failing();
    for (let i = 0; i < 5; i++) await callUpstream('http://x', GET, policy()).catch(() => {});
    vi.advanceTimersByTime(16_000);
    let finish!: (r: Response) => void;
    fetchMock.mockReset().mockImplementation(() => new Promise<Response>((r) => (finish = r)));
    const trial = callUpstream('http://x', GET, policy());
    await expect(callUpstream('http://x', GET, policy())).rejects.toMatchObject({ status: 503 });
    finish(reply());
    await trial;
    expect(breakerState('svc')).toBe('closed');
  });

  it('each backend has its own breaker', async () => {
    failing();
    for (let i = 0; i < 5; i++) await callUpstream('http://x', GET, policy({ service: 'a' })).catch(() => {});
    fetchMock.mockReset().mockResolvedValue(reply());
    expect(breakerState('a')).toBe('open');
    expect((await callUpstream('http://x', GET, policy({ service: 'b' }))).status).toBe(200);
  });
});

describe('in-flight limits', () => {
  function hold() {
    const releases: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((r) => releases.push(r)));
    return releases;
  }

  it('one caller cannot have more than its share in flight (429), and others are unaffected', async () => {
    const releases = hold();
    const a1 = callUpstream('http://x', GET, policy(), 'key-a');
    const a2 = callUpstream('http://x', GET, policy(), 'key-a');
    await expect(callUpstream('http://x', GET, policy(), 'key-a')).rejects.toMatchObject({ status: 429, retryAfterSeconds: 1 });
    const b1 = callUpstream('http://x', GET, policy(), 'key-b');
    releases.forEach((r) => r(reply()));
    await Promise.all([a1, a2, b1]);
  });

  it('the backend as a whole has a ceiling (503), and slots free up when calls finish', async () => {
    const releases = hold();
    const p = policy({ maxInFlight: 3, maxInFlightPerHolder: undefined });
    const running = [1, 2, 3].map(() => callUpstream('http://x', GET, p));
    await expect(callUpstream('http://x', GET, p)).rejects.toMatchObject({ status: 503, retryAfterSeconds: 2 });
    releases[0](reply());
    await running[0];
    fetchMock.mockReset().mockResolvedValue(reply());
    expect((await callUpstream('http://x', GET, p)).status).toBe(200);
    releases.slice(1).forEach((r) => r(reply()));
    await Promise.all(running.slice(1));
  });

  it('a failed or timed-out call gives its slot back', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    const p = policy({ maxInFlight: 1, maxInFlightPerHolder: 1 });
    for (let i = 0; i < 3; i++) await expect(callUpstream('http://x', GET, p, 'k')).rejects.toMatchObject({ status: 502 });
  });
});

describe('a caller who leaves', () => {
  it('cancels the backend call, is not a backend failure, and is never retried', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    );
    const call = callUpstream('http://x', { ...GET, signal: controller.signal }, policy({ retryable: true }));
    controller.abort();
    await expect(call).rejects.toMatchObject({ status: 499, code: 'client_closed' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry for a caller who is gone
    expect(breakerState('svc')).toBe('closed'); // and no strike against the backend
  });

  it('frees the trial slot of a half-open breaker so it is not stuck', async () => {
    fetchMock.mockImplementation(async () => reply(500, 'x'));
    for (let i = 0; i < 5; i++) await callUpstream("http://x", GET, policy());
    expect(breakerState('svc')).toBe('open');
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000);
    expect(breakerState('svc')).toBe('half-open');
    const controller = new AbortController();
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    );
    const trial = callUpstream('http://x', { ...GET, signal: controller.signal }, policy());
    controller.abort();
    await expect(trial).rejects.toMatchObject({ code: 'client_closed' });
    fetchMock.mockImplementation(async () => reply());
    expect((await callUpstream('http://x', GET, policy())).status).toBe(200); // the next caller may test the backend
  });
});
