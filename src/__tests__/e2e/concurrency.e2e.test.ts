import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { pool } from '../../db';
import { buildApp } from '../../app';
import type { FastifyInstance } from 'fastify';

// Simultaneous requests can only be tested against a real database (locks, isolation). Skipped without E2E_DATABASE_URL.
const hasDb = !!process.env.E2E_DATABASE_URL;
const rid = () => randomBytes(10).toString('hex');
const ts = () => new Date().toISOString();

describe.skipIf(!hasDb)('E2E: simultaneous requests cannot break a rule', () => {
  let app: FastifyInstance;
  const users: string[] = [];
  const businesses: string[] = [];

  async function mkUser(): Promise<{ id: string; headers: Record<string, string> }> {
    const id = rid();
    const now = ts();
    await pool.query(`INSERT INTO users (id, email, password_hash, first_name, last_name, email_confirmed_at, created_at, updated_at) VALUES ($1,$2,'x','C','C',$3,$3,$3)`, [id, `cc-${id}@example.com`, now]);
    users.push(id);
    const { authDb } = await import('../../infrastructure/auth');
    const token = randomBytes(24).toString('hex');
    await authDb.createSession(rid(), id, token, new Date(Date.now() + 3_600_000).toISOString());
    return { id, headers: { authorization: `Bearer ${token}` } };
  }

  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await pool.query('DELETE FROM businesses WHERE id = ANY($1)', [businesses]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [users]);
    await app.close();
  });

  it('twelve draft creations at once give exactly five drafts', async () => {
    const u = await mkUser();
    const results = await Promise.all(Array.from({ length: 12 }, () => app.inject({ method: 'POST', url: '/setup/drafts', headers: u.headers, payload: {} })));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(5);
    expect(codes.filter((c) => c === 409)).toHaveLength(7);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM business_setup_drafts WHERE user_id = $1', [u.id]);
    expect(rows[0].n).toBe(5);
  });

  it('two owners removing each other at the same moment never leave a business with no owner (20 tries)', async () => {
    for (let i = 0; i < 20; i++) {
      const a = await mkUser();
      const b = await mkUser();
      const biz = rid();
      businesses.push(biz);
      await pool.query(`INSERT INTO businesses (id, user_id, name, business_json) VALUES ($1,$2,'Race','{}')`, [biz, a.id]);
      const ma = rid();
      const mb = rid();
      for (const [mid, uid] of [[ma, a.id], [mb, b.id]]) {
        await pool.query(`INSERT INTO business_memberships (id, business_id, user_id, role, accepted_at) VALUES ($1,$2,$3,'owner',$4)`, [mid, biz, uid, ts()]);
      }
      const [r1, r2] = await Promise.all([
        app.inject({ method: 'DELETE', url: `/setup/businesses/${biz}/members/${mb}`, headers: a.headers }), // A removes B
        app.inject({ method: 'DELETE', url: `/setup/businesses/${biz}/members/${ma}`, headers: b.headers }), // B removes A
      ]);
      const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM business_memberships WHERE business_id = $1 AND role = 'owner'", [biz]);
      expect(rows[0].n, `try ${i}: statuses ${r1.statusCode}/${r2.statusCode}`).toBeGreaterThanOrEqual(1);
      // Exactly one removal goes through. The other is refused either by the last-owner rule (409) or, when the first removal
      // landed before it was looked at, because the person asking is no longer a member at all (404): both leave one owner.
      const codes = [r1.statusCode, r2.statusCode].sort();
      expect(rows[0].n, `try ${i}: statuses ${codes}`).toBe(1);
      expect(codes[0], `try ${i}`).toBe(200);
      expect([404, 409], `try ${i}`).toContain(codes[1]);
    }
  });

  it('two saves with the same version at the same moment: one wins, the other gets 412', async () => {
    for (let i = 0; i < 10; i++) {
      const u = await mkUser();
      const id = JSON.parse((await app.inject({ method: 'POST', url: '/setup/drafts', headers: u.headers, payload: {} })).body).id;
      const save = (name: string) => app.inject({ method: 'PATCH', url: `/setup/drafts/${id}`, headers: { ...u.headers, 'if-match': '"1"' }, payload: { draft: { businessName: name } } });
      const [a, b] = await Promise.all([save('tab one'), save('tab two')]);
      expect([a.statusCode, b.statusCode].sort(), `try ${i}`).toEqual([200, 412]);
      const { rows } = await pool.query('SELECT version FROM business_setup_drafts WHERE id = $1', [id]);
      expect(rows[0].version).toBe(2);
    }
  });
});
