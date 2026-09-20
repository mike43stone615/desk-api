// Draft versions (ETag / If-Match), draft shape limits, and idempotent invitations.
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
import { emailed } from '../helpers/email-capture';
import { DRAFT_LIMITS, draftShapeProblem } from '../../validators/setup';
import type { FastifyInstance } from 'fastify';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
});
beforeEach(() => {
  fakeDb.drafts.clear();
  fakeDb.emailInvites.clear();
  emailed.invite.clear();
});

let n = 0;
const now = () => new Date().toISOString();
function seedUser() {
  n += 1;
  const id = `di-${n}`;
  fakeDb.users.set(id, { id, email: `${id}@example.com`, password_hash: 'x', first_name: 'D', last_name: 'I', email_confirmed_at: now(), created_at: now(), updated_at: now() });
  fakeDb.seedSession(`t-${id}`, { id: `s-${id}`, user_id: id, token: `t-${id}`, expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now() });
  return { id, email: `${id}@example.com`, headers: { authorization: `Bearer t-${id}` } };
}

describe('draft versions', () => {
  it('a new draft is version 1 and says so as an ETag; every save raises it', async () => {
    const u = seedUser();
    const created = await app.inject({ method: 'POST', url: '/setup/drafts', headers: u.headers, payload: {} });
    expect(created.headers.etag).toBe('"1"');
    const id = JSON.parse(created.body).id;
    const first = await app.inject({ method: 'PATCH', url: `/setup/drafts/${id}`, headers: u.headers, payload: { draft: { businessName: 'A' } } });
    expect(first.headers.etag).toBe('"2"');
    expect(JSON.parse(first.body)).toMatchObject({ ok: true, version: 2 });
    const read = await app.inject({ method: 'GET', url: `/setup/drafts/${id}`, headers: u.headers });
    expect(read.headers.etag).toBe('"2"');
    expect(JSON.parse(read.body).version).toBe(2);
  });

  it('saving with the version you read succeeds; saving with a stale one is refused (412) and says what is current', async () => {
    const u = seedUser();
    const id = JSON.parse((await app.inject({ method: 'POST', url: '/setup/drafts', headers: u.headers, payload: {} })).body).id;
    const save = (ifMatch: string | undefined, name: string) =>
      app.inject({ method: 'PATCH', url: `/setup/drafts/${id}`, headers: { ...u.headers, ...(ifMatch ? { 'if-match': ifMatch } : {}) }, payload: { draft: { businessName: name } } });

    expect((await save('"1"', 'from tab one')).statusCode).toBe(200); // now version 2
    const stale = await save('"1"', 'from tab two, which loaded before tab one saved');
    expect(stale.statusCode).toBe(412);
    expect(JSON.parse(stale.body)).toMatchObject({ code: 'draft_version_conflict', status: 412 });
    expect(stale.headers.etag).toBe('"2"');
    const stored = JSON.parse(fakeDb.drafts.get(id)!.draft_json as string);
    expect(stored.businessName).toBe('from tab one'); // the newer save was not overwritten

    expect((await save('"2"', 'tab two after reloading')).statusCode).toBe(200);
  });

  it('accepts weak validators, bare numbers and *; refuses nonsense', async () => {
    const u = seedUser();
    const id = JSON.parse((await app.inject({ method: 'POST', url: '/setup/drafts', headers: u.headers, payload: {} })).body).id;
    const save = (ifMatch: string) => app.inject({ method: 'PATCH', url: `/setup/drafts/${id}`, headers: { ...u.headers, 'if-match': ifMatch }, payload: { draft: {} } });
    expect((await save('W/"1"')).statusCode).toBe(200);
    expect((await save('2')).statusCode).toBe(200);
    expect((await save('*')).statusCode).toBe(200);
    const bad = await save('banana');
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).code).toBe('validation_error');
  });

  it('without If-Match it behaves as before (last save wins), so existing clients are unaffected', async () => {
    const u = seedUser();
    const id = JSON.parse((await app.inject({ method: 'POST', url: '/setup/drafts', headers: u.headers, payload: {} })).body).id;
    for (const name of ['one', 'two', 'three']) {
      expect((await app.inject({ method: 'PATCH', url: `/setup/drafts/${id}`, headers: u.headers, payload: { draft: { businessName: name } } })).statusCode).toBe(200);
    }
    expect(JSON.parse(fakeDb.drafts.get(id)!.draft_json as string).businessName).toBe('three');
  });

  it('a missing draft is a 404 even with If-Match, and another person\'s draft is invisible', async () => {
    const a = seedUser();
    const b = seedUser();
    const id = JSON.parse((await app.inject({ method: 'POST', url: '/setup/drafts', headers: a.headers, payload: {} })).body).id;
    expect((await app.inject({ method: 'PATCH', url: '/setup/drafts/nope', headers: { ...a.headers, 'if-match': '"1"' }, payload: { draft: {} } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/setup/drafts/${id}`, headers: { ...b.headers, 'if-match': '"1"' }, payload: { draft: {} } })).statusCode).toBe(404);
  });
});

describe('draft shape limits', () => {
  it('normal drafts pass, including realistic nesting', () => {
    expect(draftShapeProblem({ businessName: 'Acme', industry: 'Coffee', owners: [{ name: 'A', shares: 50 }, { name: 'B', shares: 50 }], nested: { a: { b: { c: [1, 2, 3] } } } })).toBeNull();
  });

  it('too deep, too many values, or an over-long field name is refused with the reason', () => {
    let deep: unknown = 'x';
    for (let i = 0; i < DRAFT_LIMITS.maxDepth + 1; i++) deep = { a: deep };
    expect(draftShapeProblem(deep)).toMatch(/nested too deeply/);
    expect(draftShapeProblem({ list: Array.from({ length: DRAFT_LIMITS.maxNodes + 1 }, (_, i) => i) })).toMatch(/too many values/);
    expect(draftShapeProblem({ ['k'.repeat(DRAFT_LIMITS.maxKeyLength + 1)]: 1 })).toMatch(/field name is too long/);
  });

  it('is enforced on save, as a normal validation error', async () => {
    const u = seedUser();
    const id = JSON.parse((await app.inject({ method: 'POST', url: '/setup/drafts', headers: u.headers, payload: {} })).body).id;
    let deep: unknown = 1;
    for (let i = 0; i < 20; i++) deep = { a: deep };
    const res = await app.inject({ method: 'PATCH', url: `/setup/drafts/${id}`, headers: u.headers, payload: { draft: { deep } } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'validation_error', detail: expect.stringMatching(/nested too deeply/) });
  });
});

describe('invitations are idempotent', () => {
  function business(owner: { id: string }) {
    n += 1;
    const id = `dib-${n}`;
    fakeDb.businesses.set(id, { id, user_id: owner.id, name: 'Acme', industry: null, business_json: '{}', created_at: now(), updated_at: now() });
    fakeDb.memberships.set(`m-${id}`, { id: `m-${id}`, business_id: id, user_id: owner.id, role: 'owner', accepted_at: now(), created_at: now(), updated_at: now() });
    return id;
  }
  const invite = (biz: string, from: { headers: Record<string, string> }, email: string, role?: string) =>
    app.inject({ method: 'POST', url: `/setup/businesses/${biz}/members`, headers: from.headers, payload: { email, ...(role ? { role } : {}) } });

  it('inviting the same registered person again does not send a second email or change anything', async () => {
    const owner = seedUser();
    const guest = seedUser();
    const biz = business(owner);
    expect((await invite(biz, owner, guest.email)).statusCode).toBe(200);
    expect(emailed.invite.get(guest.email)).toBe('existing-account');
    emailed.invite.clear();
    const memberships = fakeDb.memberships.size;
    expect((await invite(biz, owner, guest.email)).statusCode).toBe(200);
    expect(emailed.invite.size).toBe(0);
    expect(fakeDb.memberships.size).toBe(memberships);
  });

  it('...but changing the role is a real change and is sent again', async () => {
    const owner = seedUser();
    const guest = seedUser();
    const biz = business(owner);
    await invite(biz, owner, guest.email, 'member');
    emailed.invite.clear();
    await invite(biz, owner, guest.email, 'accountant');
    expect(emailed.invite.get(guest.email)).toBe('existing-account');
    expect([...fakeDb.memberships.values()].find((m) => m.user_id === guest.id)!.role).toBe('accountant');
  });

  it('the same goes for an address with no account yet', async () => {
    const owner = seedUser();
    const biz = business(owner);
    await invite(biz, owner, 'nobody@example.com');
    expect(emailed.invite.get('nobody@example.com')).toBe('sign-up');
    emailed.invite.clear();
    await invite(biz, owner, 'NOBODY@example.com');
    await invite(biz, owner, 'nobody@example.com');
    expect(emailed.invite.size).toBe(0);
    expect(fakeDb.emailInvites.size).toBe(1);
  });

  it('an invitation older than a day is sent again (a genuine reminder)', async () => {
    const owner = seedUser();
    const guest = seedUser();
    const biz = business(owner);
    await invite(biz, owner, guest.email);
    for (const m of fakeDb.memberships.values()) if (m.user_id === guest.id) m.invited_at = new Date(Date.now() - 2 * 86_400_000).toISOString();
    emailed.invite.clear();
    await invite(biz, owner, guest.email);
    expect(emailed.invite.get(guest.email)).toBe('existing-account');
  });

  it('inviting someone who already accepted still says they are a member', async () => {
    const owner = seedUser();
    const guest = seedUser();
    const biz = business(owner);
    fakeDb.memberships.set('acc', { id: 'acc', business_id: biz, user_id: guest.id, role: 'member', accepted_at: now(), invited_at: now(), created_at: now(), updated_at: now() });
    expect((await invite(biz, owner, guest.email)).statusCode).toBe(409);
  });
});
