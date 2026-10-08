// What an app (or key) can read through GraphQL about webhooks and usage: each field needs its own scope, usage is monthly
// totals only, and a webhook's signing secret is never part of the answer.
import { describe, expect, it, vi } from 'vitest';
import { graphql } from 'graphql';

vi.mock('../domain/webhooks/webhooks', async (orig) => ({
  ...(await orig<typeof import('../domain/webhooks/webhooks')>()),
  webhooks: {
    list: vi.fn(async () => [{ id: 'w1', url: 'https://example.com/hook', events: ['key.created'], active: true, disabledReason: null, createdAt: '2026-09-01T00:00:00Z', consecutiveFailures: 0 }]),
    deliveries: vi.fn(async () => [
      { id: 'd1', eventId: 'e1', eventType: 'key.created', status: 'delivered', attempts: 1, maxAttempts: 6, lastStatus: 200, lastError: null, createdAt: '2026-10-01T00:00:00Z', deliveredAt: null, nextAttemptAt: null, retryWaitSeconds: null },
      { id: 'd2', eventId: 'e2', eventType: 'plan.changed', status: 'pending', attempts: 0, maxAttempts: 6, lastStatus: null, lastError: null, createdAt: '2026-10-02T00:00:00Z', deliveredAt: null, nextAttemptAt: null, retryWaitSeconds: null },
      { id: 'd3', eventId: 'e3', eventType: 'plan.changed', status: 'failed', attempts: 6, maxAttempts: 6, lastStatus: 500, lastError: null, createdAt: '2026-10-03T00:00:00Z', deliveredAt: null, nextAttemptAt: null, retryWaitSeconds: null },
    ]),
  },
}));
vi.mock('../domain/gateway/usage', () => ({ keyUsageMonthly: vi.fn(async () => [{ month: '2026-10', calls: 12, errors: 1 }]) }));
vi.mock('../domain/gateway/sharing', () => ({ keyShares: { viewerOwnerOf: vi.fn(async (_u: string, key: string) => (key === 'mine' ? 'u1' : null)) } }));

import { getSchema, ROOT_VALUE, type GraphQLContext } from '../domain/graphql/schema';

const ctx = (scopes: string[] | null): GraphQLContext => ({ user: { id: 'u1', email: 'a@b.c', firstName: 'A', lastName: 'B', emailConfirmedAt: null }, scopes: scopes === null ? null : new Set(scopes) });
const run = (source: string, scopes: string[] | null) => graphql({ schema: getSchema(), source, rootValue: ROOT_VALUE, contextValue: ctx(scopes) });
const ALL = ['webhooks:list', 'webhooks:events', 'webhooks:dates', 'webhooks:active', 'webhooks:deliveries'];

describe('GraphQL webhooks', () => {
  it('needs webhooks:list for the list at all', async () => {
    const res = await run('{ webhooks { id } }', ['webhooks:events']);
    expect(res.errors?.[0].message).toContain('webhooks:list');
  });
  it('gives only the id and address with the list scope alone; each detail has its own scope', async () => {
    const res = await run('{ webhooks { id url events createdAt active } }', ['webhooks:list']);
    expect((res.data as { webhooks: Array<{ id: string; url: string }> }).webhooks[0]).toMatchObject({ id: 'w1', url: 'https://example.com/hook' });
    const failed = (res.errors ?? []).map((e) => e.message).join(' ');
    for (const s of ['webhooks:events', 'webhooks:dates', 'webhooks:active']) expect(failed).toContain(s);
  });
  it('gives events, created date, active and the delivery history with the scopes for them', async () => {
    const res = await run('{ webhooks { events createdAt active deliveries { id event progress result tries maxTries } } }', ALL);
    expect(res.errors).toBeUndefined();
    const w = (res.data as { webhooks: Array<Record<string, unknown>> }).webhooks[0];
    expect(w).toMatchObject({ events: ['key.created'], createdAt: '2026-09-01T00:00:00Z', active: true });
    expect(w.deliveries).toEqual([
      { id: 'd1', event: 'key.created', progress: 'delivered', result: 'Sent', tries: 1, maxTries: 6 },
      { id: 'd2', event: 'plan.changed', progress: 'pending', result: 'Queued', tries: 0, maxTries: 6 },
      { id: 'd3', event: 'plan.changed', progress: 'failed', result: 'Failed 500', tries: 6, maxTries: 6 },
    ]);
  });
  it('has no field for the signing secret', async () => {
    const res = await run('{ webhooks { secret } }', ALL);
    expect(res.errors?.[0].message).toMatch(/Cannot query field "secret"/);
  });
});

describe('GraphQL usage', () => {
  it('is monthly totals only, for a key the person can see', async () => {
    const res = await run('{ usage(keyId: "mine", months: 2) { month calls errors } }', ['usage:read']);
    expect(res.data).toEqual({ usage: [{ month: '2026-10', calls: 12, errors: 1 }] });
  });
  it('has no per-day answer any more', async () => {
    const res = await run('{ usage(keyId: "mine") { day } }', ['usage:read']);
    expect(res.errors?.[0].message).toMatch(/Cannot query field "day"/);
  });
  it('needs usage:read, and refuses a key that is not theirs', async () => {
    expect((await run('{ usage(keyId: "mine") { month } }', ['keys:name'])).errors?.[0].message).toContain('usage:read');
    expect((await run('{ usage(keyId: "theirs") { month } }', ['usage:read'])).errors?.[0].message).toContain('No such key');
  });
});
