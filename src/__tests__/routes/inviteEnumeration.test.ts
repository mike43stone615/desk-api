// Inviting someone must not reveal whether an address has a Desk account, and an invitation to an address with no
// account must not be lost: it waits, and becomes a pending membership once that address is confirmed.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
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
import { setRouteLimitsEnabledForTests } from '../../middleware/route-limits';
import { deleteExpiredEmailInvites, INVITE_TTL_DAYS, MAX_EMAIL_INVITES_PER_BUSINESS } from '../../domain/setup/email-invites';
import type { FastifyInstance } from 'fastify';

const fakeDb = pool as unknown as ReturnType<typeof createFakeDb>;
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
});
afterAll(() => setRouteLimitsEnabledForTests(false));
beforeEach(() => fakeDb.emailInvites.clear());

let n = 0;
const now = () => new Date().toISOString();
function seedUser(prefix: string) {
  n += 1;
  const id = `${prefix}-${n}`;
  const email = `${id}@example.com`;
  fakeDb.users.set(id, { id, email, password_hash: 'x', first_name: 'F', last_name: 'L', email_confirmed_at: now(), created_at: now(), updated_at: now() });
  const token = `tok-${id}`;
  fakeDb.seedSession(token, { id: `s-${id}`, user_id: id, token, expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now() });
  return { id, email, headers: { authorization: `Bearer ${token}` } };
}
function seedBusiness(owner: { id: string }, name = 'Acme') {
  n += 1;
  const id = `biz-${n}`;
  fakeDb.businesses.set(id, { id, user_id: owner.id, name, industry: null, business_json: '{}', created_at: now(), updated_at: now() });
  fakeDb.memberships.set(`m-${id}`, { id: `m-${id}`, business_id: id, user_id: owner.id, role: 'owner', accepted_at: now(), created_at: now(), updated_at: now() });
  return id;
}
const invite = (biz: string, from: { headers: Record<string, string> }, email: string, role?: string) =>
  app.inject({ method: 'POST', url: `/setup/businesses/${biz}/members`, headers: from.headers, payload: { email, ...(role ? { role } : {}) } });

describe('the answer is the same whether or not the address has an account', () => {
  it('status and body are identical, for a registered and an unregistered address', async () => {
    const owner = seedUser('owner');
    const biz = seedBusiness(owner);
    const registered = seedUser('registered');
    const known = await invite(biz, owner, registered.email);
    const unknown = await invite(biz, owner, 'nobody-here@example.com');
    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.body).toBe(known.body);
    expect(unknown.headers['content-type']).toBe(known.headers['content-type']);
  });

  it('it never says "User not found" and never answers 404 for an address', async () => {
    const owner = seedUser('owner');
    const biz = seedBusiness(owner);
    for (const email of ['a@example.com', 'B@Example.COM', 'c+tag@example.com']) {
      const res = await invite(biz, owner, email);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toMatch(/not found/i);
    }
  });

  it('each address gets an email that suits it: sign up, or sign in', async () => {
    const owner = seedUser('owner');
    const biz = seedBusiness(owner);
    const registered = seedUser('registered');
    await invite(biz, owner, registered.email);
    await invite(biz, owner, 'stranger@example.com');
    expect(emailed.invite.get(registered.email)).toBe('existing-account');
    expect(emailed.invite.get('stranger@example.com')).toBe('sign-up');
  });

  it('only the invite for an existing account creates a membership now; the other waits', async () => {
    const owner = seedUser('owner');
    const biz = seedBusiness(owner);
    const registered = seedUser('registered');
    await invite(biz, owner, registered.email);
    await invite(biz, owner, 'waiting@example.com');
    expect([...fakeDb.memberships.values()].filter((m) => m.business_id === biz && m.accepted_at === null)).toHaveLength(1);
    expect([...fakeDb.emailInvites.values()].filter((i) => i.business_id === biz).map((i) => i.email)).toEqual(['waiting@example.com']);
  });

  it('an existing member is still told they are a member (the inviter can already see that)', async () => {
    const owner = seedUser('owner');
    const biz = seedBusiness(owner);
    expect((await invite(biz, owner, owner.email)).statusCode).toBe(409);
  });
});

describe('an invitation to a not-yet-registered address is kept and claimed', () => {
  async function signUpAndConfirm(email: string) {
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: { email, password: 'Str0ng!Pass1', firstName: 'New', lastName: 'Person' } });
    expect(res.statusCode).toBe(201);
    return async () => {
      const token = emailed.confirm.get(email) as string;
      expect((await app.inject({ method: 'POST', url: '/auth/email-confirmation/confirm', payload: { token } })).statusCode).toBe(200);
    };
  }
  const signIn = async (email: string) =>
    ({ headers: { authorization: `Bearer ${JSON.parse((await app.inject({ method: 'POST', url: '/auth/signin', payload: { email, password: 'Str0ng!Pass1' } })).body).token}` } });

  it('after signing up and confirming that address, the invitation is waiting; before, nothing is', async () => {
    const owner = seedUser('owner');
    const biz = seedBusiness(owner, 'Waiting Co');
    const email = 'later@example.com';
    await invite(biz, owner, email, 'admin');

    const confirm = await signUpAndConfirm(email);
    const memberOf = () => [...fakeDb.memberships.values()].filter((m) => fakeDb.users.get(String(m.user_id))?.email === email);
    expect(memberOf(), 'signing up alone attaches nothing: the address is not proven yet').toHaveLength(0);

    await confirm();
    const [m] = memberOf();
    expect(m).toMatchObject({ business_id: biz, role: 'admin', accepted_at: null, invited_by_user_id: owner.id });
    expect(fakeDb.emailInvites.size).toBe(0);

    const session = await signIn(email);
    const pending = JSON.parse((await app.inject({ method: 'GET', url: '/setup/invites', headers: session.headers })).body).invites;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ businessName: 'Waiting Co', role: 'Admin' });
    // Not a member until they accept.
    expect((await app.inject({ method: 'GET', url: `/setup/businesses/${biz}/members`, headers: session.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/setup/invites/${pending[0].id}/accept`, headers: session.headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/setup/businesses/${biz}/members`, headers: session.headers })).statusCode).toBe(200);
  });

  it('the address matches whatever letter case it was typed in', async () => {
    const owner = seedUser('owner');
    const biz = seedBusiness(owner);
    await invite(biz, owner, 'MixedCase@Example.com');
    await (await signUpAndConfirm('mixedcase@example.com'))();
    expect([...fakeDb.memberships.values()].some((m) => m.business_id === biz && fakeDb.users.get(String(m.user_id))?.email === 'mixedcase@example.com')).toBe(true);
  });

  it('several businesses inviting the same address all arrive; inviting again changes the role, not the count', async () => {
    const a = seedUser('owner');
    const b = seedUser('owner');
    const bizA = seedBusiness(a, 'A');
    const bizB = seedBusiness(b, 'B');
    await invite(bizA, a, 'many@example.com', 'member');
    await invite(bizA, a, 'many@example.com', 'accountant');
    await invite(bizB, b, 'many@example.com');
    expect(fakeDb.emailInvites.size).toBeGreaterThanOrEqual(2);
    await (await signUpAndConfirm('many@example.com'))();
    const mine = [...fakeDb.memberships.values()].filter((m) => fakeDb.users.get(String(m.user_id))?.email === 'many@example.com');
    expect(mine).toHaveLength(2);
    expect(mine.find((m) => m.business_id === bizA)?.role).toBe('accountant');
  });

  it('an invitation to an address is not claimed by an account that merely used another address', async () => {
    const owner = seedUser('owner');
    const biz = seedBusiness(owner);
    await invite(biz, owner, 'intended@example.com');
    await (await signUpAndConfirm('someone-else@example.com'))();
    expect([...fakeDb.memberships.values()].some((m) => m.business_id === biz && fakeDb.users.get(String(m.user_id))?.email === 'someone-else@example.com')).toBe(false);
    expect([...fakeDb.emailInvites.values()].some((i) => i.email === 'intended@example.com')).toBe(true);
  });

  it('an expired invitation is not claimed, and the daily cleanup removes it', async () => {
    const owner = seedUser('owner');
    const biz = seedBusiness(owner);
    await invite(biz, owner, 'toolate@example.com');
    for (const i of fakeDb.emailInvites.values()) if (i.email === 'toolate@example.com') i.invited_at = new Date(Date.now() - (INVITE_TTL_DAYS + 1) * 86_400_000).toISOString();
    await (await signUpAndConfirm('toolate@example.com'))();
    expect([...fakeDb.memberships.values()].some((m) => m.business_id === biz && fakeDb.users.get(String(m.user_id))?.email === 'toolate@example.com')).toBe(false);

    fakeDb.emailInvites.set('old-one', { id: 'old-one', business_id: biz, email: 'ancient@example.com', role: 'member', invited_by_user_id: owner.id, invited_at: '2000-01-01T00:00:00.000Z' });
    await deleteExpiredEmailInvites();
    expect(fakeDb.emailInvites.has('old-one')).toBe(false);
  });
});

describe('managing invitations that are waiting', () => {
  it('owners and admins see them and can remove one; plain members do not see them', async () => {
    const owner = seedUser('owner');
    const biz = seedBusiness(owner);
    const member = seedUser('member');
    fakeDb.memberships.set(`m2-${biz}`, { id: `m2-${biz}`, business_id: biz, user_id: member.id, role: 'member', accepted_at: now(), created_at: now(), updated_at: now() });
    await invite(biz, owner, 'typo@exmaple.com');

    const asOwner = JSON.parse((await app.inject({ method: 'GET', url: `/setup/businesses/${biz}/members`, headers: owner.headers })).body);
    expect(asOwner.emailInvites).toHaveLength(1);
    expect(asOwner.emailInvites[0]).toMatchObject({ email: 'typo@exmaple.com', role: 'Member' });
    const asMember = JSON.parse((await app.inject({ method: 'GET', url: `/setup/businesses/${biz}/members`, headers: member.headers })).body);
    expect(asMember.emailInvites).toEqual([]);

    const removed = await app.inject({ method: 'DELETE', url: `/setup/businesses/${biz}/members/${asOwner.emailInvites[0].id}`, headers: owner.headers });
    expect(removed.statusCode).toBe(200);
    expect(fakeDb.emailInvites.size).toBe(0);
    expect((await app.inject({ method: 'DELETE', url: `/setup/businesses/${biz}/members/nope`, headers: owner.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/setup/businesses/${biz}/members/${asOwner.emailInvites[0].id}`, headers: member.headers })).statusCode).toBe(403);
  });

  it('cannot remove another business\'s waiting invitation', async () => {
    const a = seedUser('owner');
    const b = seedUser('owner');
    const bizA = seedBusiness(a);
    const bizB = seedBusiness(b);
    await invite(bizA, a, 'secret@example.com');
    const id = [...fakeDb.emailInvites.values()].find((i) => i.email === 'secret@example.com')!.id as string;
    expect((await app.inject({ method: 'DELETE', url: `/setup/businesses/${bizB}/members/${id}`, headers: b.headers })).statusCode).toBe(404);
    expect(fakeDb.emailInvites.size).toBeGreaterThan(0);
  });

  it('only an owner can invite someone as an owner, registered or not', async () => {
    const owner = seedUser('owner');
    const biz = seedBusiness(owner);
    const admin = seedUser('admin');
    fakeDb.memberships.set(`m3-${biz}`, { id: `m3-${biz}`, business_id: biz, user_id: admin.id, role: 'admin', accepted_at: now(), created_at: now(), updated_at: now() });
    expect((await invite(biz, admin, 'newowner@example.com', 'owner')).statusCode).toBe(403);
    expect((await invite(biz, owner, 'newowner@example.com', 'owner')).statusCode).toBe(200);
  });

  it(`a business can have at most ${MAX_EMAIL_INVITES_PER_BUSINESS} people waiting`, async () => {
    const owner = seedUser('owner');
    const biz = seedBusiness(owner);
    for (let i = 0; i < MAX_EMAIL_INVITES_PER_BUSINESS; i++) fakeDb.emailInvites.set(`w${i}`, { id: `w${i}`, business_id: biz, email: `w${i}@example.com`, role: 'member', invited_by_user_id: owner.id, invited_at: now() });
    const res = await invite(biz, owner, 'one-too-many@example.com');
    expect(res.statusCode).toBe(409);
    expect((await invite(biz, owner, 'w3@example.com', 'admin')).statusCode).toBe(200); // re-inviting one already waiting is fine
  });
});

describe('limits on invitations', () => {
  it('one address cannot be invited more than 5 times an hour, from anywhere', async () => {
    setRouteLimitsEnabledForTests(true);
    try {
      const outcomes: number[] = [];
      for (let i = 0; i < 7; i++) {
        const owner = seedUser('owner');
        const biz = seedBusiness(owner);
        outcomes.push((await invite(biz, owner, 'flooded@example.com')).statusCode);
      }
      expect(outcomes).toEqual([200, 200, 200, 200, 200, 429, 429]);
    } finally {
      setRouteLimitsEnabledForTests(false);
    }
  });
});
