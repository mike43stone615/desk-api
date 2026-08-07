import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createFakeDb } from '../helpers/fake-db';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { pool } from '../../db';
import { buildApp } from '../../app';
import type { FastifyInstance } from 'fastify';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;

let app: FastifyInstance;
let authHeaders: Record<string, string>;

beforeAll(async () => {
  app = await buildApp();

  // Seed a confirmed user + active session directly (bypassing the full
  // signup/confirm/signin flow, which is covered separately in auth.test.ts)
  // so this file can focus on setup-draft/business/membership behavior.
  const userId = 'user-1';
  fakeDb.users.set(userId, {
    id: userId,
    email: 'owner@example.com',
    password_hash: 'irrelevant',
    first_name: 'Owner',
    last_name: 'One',
    email_confirmed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const token = 'test-session-token';
  fakeDb.sessions.set(token, {
    id: 'session-1',
    user_id: userId,
    token,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    created_at: new Date().toISOString(),
  });
  authHeaders = { authorization: `Bearer ${token}` };
});

describe('POST /setup/drafts', () => {
  it('creates a draft', async () => {
    const res = await app.inject({ method: 'POST', url: '/setup/drafts', headers: authHeaders });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).draft).toEqual({});
  });

  it('enforces the 5-incomplete-draft cap', async () => {
    // One draft already created above — create 4 more to hit the cap.
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({ method: 'POST', url: '/setup/drafts', headers: authHeaders });
      expect(res.statusCode).toBe(201);
    }
    const overCap = await app.inject({ method: 'POST', url: '/setup/drafts', headers: authHeaders });
    expect(overCap.statusCode).toBe(409);
  });

  it('is idempotent: the same Idempotency-Key replays the first response instead of creating a second draft', async () => {
    // Cap already hit above in this file's shared fakeDb — clear it so this
    // test exercises idempotency, not the cap.
    fakeDb.drafts.clear();
    const headers = { ...authHeaders, 'idempotency-key': 'draft-create-key-1' };

    const first = await app.inject({ method: 'POST', url: '/setup/drafts', headers });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/setup/drafts', headers });
    expect(second.statusCode).toBe(201);

    expect(JSON.parse(first.body)).toEqual(JSON.parse(second.body));
    expect(fakeDb.drafts.size).toBe(1); // exactly one draft created, not two
    expect(second.headers['idempotency-replayed']).toBe('true');
  });

  it('a different request body under the same Idempotency-Key returns 409', async () => {
    fakeDb.drafts.clear();
    const headers = { ...authHeaders, 'idempotency-key': 'draft-create-key-2' };
    const first = await app.inject({ method: 'POST', url: '/setup/drafts', headers, payload: { a: 1 } });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/setup/drafts', headers, payload: { a: 2 } });
    expect(second.statusCode).toBe(409);
  });
});

describe('PATCH /setup/drafts/:id and POST /setup/drafts/:id/complete', () => {
  it('updates a draft, then completes it into a business with an owner membership', async () => {
    fakeDb.drafts.clear();
    fakeDb.businesses.clear();
    fakeDb.memberships.clear();
    fakeDb.idempotencyKeys.clear();

    const created = await app.inject({ method: 'POST', url: '/setup/drafts', headers: authHeaders });
    const draftId = JSON.parse(created.body).id as string;

    const patch = await app.inject({
      method: 'PATCH',
      url: `/setup/drafts/${draftId}`,
      headers: authHeaders,
      payload: { draft: { businessName: 'Acme Bakery', industry: 'Bakery', currentStep: 3 } },
    });
    expect(patch.statusCode).toBe(200);

    const complete = await app.inject({
      method: 'POST',
      url: `/setup/drafts/${draftId}/complete`,
      headers: authHeaders,
    });
    expect(complete.statusCode).toBe(200);
    const business = JSON.parse(complete.body).business;
    expect(business.name).toBe('Acme Bakery');
    expect(business.role).toBe('Owner');

    // Draft was deleted after completion.
    expect(fakeDb.drafts.has(draftId)).toBe(false);

    const list = await app.inject({ method: 'GET', url: '/setup/businesses', headers: authHeaders });
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body).businesses).toHaveLength(1);
  });

  it('is idempotent: completing the same draft twice with the same Idempotency-Key creates only one business', async () => {
    fakeDb.drafts.clear();
    fakeDb.businesses.clear();
    fakeDb.memberships.clear();

    const created = await app.inject({ method: 'POST', url: '/setup/drafts', headers: authHeaders });
    const draftId = JSON.parse(created.body).id as string;
    await app.inject({
      method: 'PATCH',
      url: `/setup/drafts/${draftId}`,
      headers: authHeaders,
      payload: { draft: { businessName: 'Acme Cafe' } },
    });

    const headers = { ...authHeaders, 'idempotency-key': `complete-${draftId}` };
    const first = await app.inject({ method: 'POST', url: `/setup/drafts/${draftId}/complete`, headers });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: `/setup/drafts/${draftId}/complete`, headers });
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(first.body)).toEqual(JSON.parse(second.body));
    expect(fakeDb.businesses.size).toBe(1);
  });

  it('rejects completing a draft with no business name', async () => {
    const created = await app.inject({ method: 'POST', url: '/setup/drafts', headers: authHeaders });
    const draftId = JSON.parse(created.body).id as string;
    const complete = await app.inject({ method: 'POST', url: `/setup/drafts/${draftId}/complete`, headers: authHeaders });
    expect(complete.statusCode).toBe(400);
  });
});

describe('auth is required', () => {
  it('returns 401 without a session token', async () => {
    const res = await app.inject({ method: 'GET', url: '/setup/drafts' });
    expect(res.statusCode).toBe(401);
  });
});
