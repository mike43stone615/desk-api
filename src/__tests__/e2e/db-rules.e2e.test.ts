import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { pool } from '../../db';
import { buildApp } from '../../app';
import type { FastifyInstance } from 'fastify';

// Rules that live IN the database (triggers, constraints, hashed columns) can only be tested against a real Postgres.
// Skipped automatically when E2E_DATABASE_URL is not set.
const hasDb = !!process.env.E2E_DATABASE_URL;

const rid = () => randomBytes(10).toString('hex');
const ts = () => new Date().toISOString();

describe.skipIf(!hasDb)('E2E: rules enforced by the database itself', () => {
  const users: string[] = [];
  const businesses: string[] = [];
  let app: FastifyInstance;

  async function mkUser(): Promise<string> {
    const id = rid();
    await pool.query(
      `INSERT INTO users (id, email, password_hash, first_name, last_name, email_confirmed_at, created_at, updated_at)
       VALUES ($1, $2, 'x', 'T', 'U', $3, $3, $3)`,
      [id, `e2e-${id}@example.com`, ts()],
    );
    users.push(id);
    return id;
  }
  async function mkBusiness(creator: string, members: Array<{ user: string; role: string; pending?: boolean; at?: string }>): Promise<string> {
    const id = rid();
    businesses.push(id);
    await pool.query(`INSERT INTO businesses (id, user_id, name, business_json) VALUES ($1, $2, 'E2E', '{}')`, [id, creator]);
    for (const m of members) {
      await pool.query(
        `INSERT INTO business_memberships (id, business_id, user_id, role, accepted_at) VALUES ($1, $2, $3, $4, $5)`,
        [rid(), id, m.user, m.role, m.pending ? null : (m.at ?? ts())],
      );
    }
    return id;
  }
  const creatorOf = async (bid: string) => (await pool.query('SELECT user_id FROM businesses WHERE id = $1', [bid])).rows[0]?.user_id as string | undefined;
  const roleOf = async (bid: string, uid: string) => (await pool.query('SELECT role FROM business_memberships WHERE business_id = $1 AND user_id = $2', [bid, uid])).rows[0]?.role as string | undefined;

  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await pool.query('DELETE FROM businesses WHERE id = ANY($1)', [businesses]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [users]);
    await pool.query('DELETE FROM gateway_backend_key_revocations');
    await app.close();
  });

  it('a fresh database has every table the service needs', async () => {
    const { rows } = await pool.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    const names = new Set(rows.map((r) => r.table_name));
    for (const t of [
      'users', 'sessions', 'password_reset_tokens', 'email_confirmation_tokens', 'business_setup_drafts', 'businesses',
      'business_memberships', 'mutation_audit_log', 'idempotency_keys', 'gateway_api_keys', 'gateway_api_key_grants',
      'gateway_backend_key_revocations', 'schema_migrations',
    ]) expect(names.has(t), t).toBe(true);
  });

  describe('deleting a user (any path, including raw SQL)', () => {
    it('hands a shared business to the best remaining member and keeps an owner', async () => {
      const [creator, plain, admin, pending, coOwner] = [await mkUser(), await mkUser(), await mkUser(), await mkUser(), await mkUser()];
      const early = new Date(Date.now() - 3_600_000).toISOString();
      const a = await mkBusiness(creator, [
        { user: creator, role: 'owner' }, { user: plain, role: 'member', at: early }, { user: admin, role: 'admin' }, { user: pending, role: 'member', pending: true },
      ]);
      const b = await mkBusiness(creator, [{ user: creator, role: 'owner' }, { user: coOwner, role: 'owner' }, { user: plain, role: 'member' }]);
      const alone = await mkBusiness(creator, [{ user: creator, role: 'owner' }]);
      const onlyPending = await mkBusiness(creator, [{ user: creator, role: 'owner' }, { user: pending, role: 'member', pending: true }]);

      await pool.query('DELETE FROM users WHERE id = $1', [creator]);

      expect(await creatorOf(a)).toBe(admin); // an admin outranks an earlier plain member
      expect(await roleOf(a, admin)).toBe('owner'); // nobody else owned it, so the new creator becomes an owner
      expect(await roleOf(a, plain)).toBe('member');
      expect(await creatorOf(b)).toBe(coOwner);
      expect(await roleOf(b, plain)).toBe('member'); // an owner remained: nobody is promoted
      expect(await creatorOf(alone)).toBeUndefined(); // nobody else: goes with its creator
      expect(await creatorOf(onlyPending)).toBeUndefined(); // a pending invitation is not membership
    });

    it('queues every backend key of the user\'s gateway keys for revocation', async () => {
      const owner = await mkUser();
      const keyId = rid();
      await pool.query(`INSERT INTO gateway_api_keys (id, owner_user_id, label, key_hash, key_prefix) VALUES ($1, $2, 'k', $3, 'deskgw_x')`, [keyId, owner, rid()]);
      const grants: Array<[string, string | null]> = [['desk_api', null], ['registry_api', 'reg-1'], ['market_validation_api', 'mkt-1']];
      for (const [service, backend] of grants) {
        await pool.query(`INSERT INTO gateway_api_key_grants (id, api_key_id, service, backend_key_id) VALUES ($1, $2, $3, $4)`, [rid(), keyId, service, backend]);
      }
      await pool.query('DELETE FROM gateway_backend_key_revocations');

      await pool.query('DELETE FROM users WHERE id = $1', [owner]);

      const { rows } = await pool.query<{ service: string; backend_key_id: string }>('SELECT service, backend_key_id FROM gateway_backend_key_revocations ORDER BY service');
      expect(rows).toEqual([
        { service: 'market_validation_api', backend_key_id: 'mkt-1' },
        { service: 'registry_api', backend_key_id: 'reg-1' },
      ]);
      expect((await pool.query('SELECT 1 FROM gateway_api_keys WHERE id = $1', [keyId])).rowCount).toBe(0);
    });
  });

  it('sessions are stored as a hash of the token, never the token', async () => {
    const id = await mkUser();
    const { authService, authDb } = await import('../../infrastructure/auth');
    const created = { token: randomBytes(32).toString('hex') };
    await authDb.createSession(rid(), id, created.token, new Date(Date.now() + 3_600_000).toISOString());
    const stored = (await pool.query('SELECT token FROM sessions WHERE user_id = $1', [id])).rows.map((r) => r.token as string);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(stored[0]).not.toContain(created.token);
    expect((await authService.verifySession(created.token))?.id).toBe(id);
    expect(await authService.verifySession(stored[0])).toBeNull(); // the stored value is not itself a credential
  });
});
