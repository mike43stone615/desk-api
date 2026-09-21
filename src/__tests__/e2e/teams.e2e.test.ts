import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

// Teams against a real database: roles, shared keys, the "last owner" rule, and what happens when a person is deleted
// (their team keys are handed on; a team with nobody left goes). Skipped without E2E_DATABASE_URL.
const hasDb = !!process.env.E2E_DATABASE_URL;

// The two backends that issue keys are not part of this test.
vi.mock('../../domain/gateway/broker', async (orig) => {
  const real = await orig<typeof import('../../domain/gateway/broker')>();
  return {
    ...real,
    provisionBrokerKey: vi.fn(async () => ({ backendKeyId: `bk-${randomBytes(6).toString('hex')}`, plaintext: `backend-${randomBytes(12).toString('hex')}` })),
    revokeBrokerKey: vi.fn(async () => undefined),
  };
});

import { pool } from '../../db';
import { buildApp } from '../../app';
import { config } from '../../config';
import { keyBucketInfo, gatewayApiKeys } from '../../domain/gateway/keys';
import type { FastifyInstance } from 'fastify';

const rid = () => randomBytes(10).toString('hex');
const ts = () => new Date().toISOString();

describe.skipIf(!hasDb)('E2E: teams', () => {
  let app: FastifyInstance;
  const users: string[] = [];
  const saved = { a: config.registryApiUrl, b: config.registryApiAdminKey, c: config.marketApiUrl, d: config.marketApiAdminKey, e: config.gatewayKeyEncryptionSecret };

  async function mkUser(name: string): Promise<{ id: string; email: string; headers: Record<string, string> }> {
    const id = rid();
    const email = `team-${name}-${id}@example.com`;
    const now = ts();
    await pool.query(`INSERT INTO users (id, email, password_hash, first_name, last_name, email_confirmed_at, created_at, updated_at) VALUES ($1,$2,'x',$3,'T',$4,$4,$4)`, [id, email, name, now]);
    users.push(id);
    const { authDb } = await import('../../infrastructure/auth');
    const token = randomBytes(24).toString('hex');
    await authDb.createSession(rid(), id, token, new Date(Date.now() + 3_600_000).toISOString());
    return { id, email, headers: { authorization: `Bearer ${token}` } };
  }
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, who: { headers: Record<string, string> }, payload?: unknown) =>
    app.inject({ method, url, headers: { ...who.headers, 'cf-connecting-ip': `203.0.113.${1 + Math.floor(Math.random() * 250)}` }, payload: payload as never });

  beforeAll(async () => {
    config.registryApiUrl = 'http://127.0.0.1:1';
    config.registryApiAdminKey = 'k';
    config.marketApiUrl = 'http://127.0.0.1:1';
    config.marketApiAdminKey = 'k';
    config.gatewayKeyEncryptionSecret = 'ab'.repeat(32);
    app = await buildApp();
  });
  afterAll(async () => {
    // people first would fire the hand-over trigger; delete teams first so the clean-up is exact
    await pool.query(`DELETE FROM teams WHERE created_by_user_id = ANY($1) OR id IN (SELECT team_id FROM team_members WHERE user_id = ANY($1))`, [users]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [users]);
    Object.assign(config, { registryApiUrl: saved.a, registryApiAdminKey: saved.b, marketApiUrl: saved.c, marketApiAdminKey: saved.d, gatewayKeyEncryptionSecret: saved.e });
    await app.close();
  });

  async function setupTeam() {
    const owner = await mkUser('owner');
    const created = await call('POST', '/v1/teams', owner, { name: 'Payments group' });
    expect(created.statusCode).toBe(201);
    const team = created.json().team;
    return { owner, teamId: team.id as string };
  }
  async function join(teamId: string, inviter: { headers: Record<string, string> }, name: string, role: string) {
    const u = await mkUser(name);
    const inv = await call('POST', `/v1/teams/${teamId}/members`, inviter, { email: u.email, role });
    expect(inv.statusCode).toBe(202);
    const pending = (await call('GET', '/v1/teams/invites', u)).json().invites;
    expect(pending).toHaveLength(1);
    expect((await call('POST', `/v1/teams/invites/${pending[0].membershipId}/accept`, u)).statusCode).toBe(200);
    return u;
  }

  it('the creator is the owner; a stranger cannot see the team (404, same as one that does not exist)', async () => {
    const { owner, teamId } = await setupTeam();
    const list = (await call('GET', '/v1/teams', owner)).json().teams;
    expect(list).toEqual([expect.objectContaining({ id: teamId, role: 'owner', memberCount: 1, keyCount: 0 })]);
    const stranger = await mkUser('stranger');
    const real = await call('GET', `/v1/teams/${teamId}`, stranger);
    const fake = await call('GET', '/v1/teams/does-not-exist', stranger);
    expect(real.statusCode).toBe(404);
    expect(fake.statusCode).toBe(404);
    expect(real.json().detail).toBe(fake.json().detail);
  });

  it('an invitation gives nothing until it is accepted, and a made-up address gets the same answer as a real one', async () => {
    const { owner, teamId } = await setupTeam();
    const dev = await mkUser('dev');
    const real = await call('POST', `/v1/teams/${teamId}/members`, owner, { email: dev.email, role: 'developer' });
    const fake = await call('POST', `/v1/teams/${teamId}/members`, owner, { email: `nobody-${rid()}@example.com`, role: 'developer' });
    expect(real.statusCode).toBe(202);
    expect(fake.statusCode).toBe(202);
    expect(real.json()).toEqual(fake.json());
    expect((await call('GET', `/v1/teams/${teamId}`, dev)).statusCode).toBe(404); // pending: not a member yet
    const pending = (await call('GET', '/v1/teams/invites', dev)).json().invites[0];
    await call('POST', `/v1/teams/invites/${pending.membershipId}/accept`, dev);
    expect((await call('GET', `/v1/teams/${teamId}`, dev)).statusCode).toBe(200);
  });

  it('team keys: a developer makes one, a viewer cannot, the Desk API is refused, and personal lists do not show it', async () => {
    const { owner, teamId } = await setupTeam();
    const dev = await join(teamId, owner, 'dev', 'developer');
    const viewer = await join(teamId, owner, 'viewer', 'viewer');
    const made = await call('POST', '/v1/gateway/api-keys', dev, { label: 'ci', services: ['registry_api'], teamId });
    expect(made.statusCode).toBe(201);
    expect(made.json().apiKey.teamId).toBe(teamId);
    expect((await call('POST', '/v1/gateway/api-keys', viewer, { label: 'no', services: ['registry_api'], teamId })).statusCode).toBe(403);
    const deskKey = await call('POST', '/v1/gateway/api-keys', dev, { label: 'desk', services: ['desk_api'], teamId });
    expect(deskKey.statusCode).toBe(400);
    expect(deskKey.json().code).toBe('api_key_team_desk_api');
    // the viewer sees the team's keys (never a secret) and their usage; the developer's personal list is unaffected
    const seen = (await call('GET', `/v1/gateway/api-keys?teamId=${teamId}`, viewer)).json().apiKeys;
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toMatch(/deskgw_[0-9a-f]{48}/);
    expect((await call('GET', `/v1/gateway/api-keys/${made.json().apiKey.id}/usage`, viewer)).statusCode).toBe(200);
    expect((await call('GET', '/v1/gateway/api-keys', dev)).json().apiKeys).toHaveLength(0);
    expect((await call('GET', `/v1/gateway/api-keys?teamId=${teamId}`, await mkUser('outsider'))).statusCode).toBe(404);
  });

  it('who may revoke: the developer who made it and any admin or owner; not another developer or a viewer', async () => {
    const { owner, teamId } = await setupTeam();
    const dev1 = await join(teamId, owner, 'dev1', 'developer');
    const dev2 = await join(teamId, owner, 'dev2', 'developer');
    const viewer = await join(teamId, owner, 'viewer', 'viewer');
    const k1 = (await call('POST', '/v1/gateway/api-keys', dev1, { label: 'k1', services: ['market_validation_api'], teamId })).json().apiKey.id;
    const k2 = (await call('POST', '/v1/gateway/api-keys', dev1, { label: 'k2', services: ['market_validation_api'], teamId })).json().apiKey.id;
    expect((await call('DELETE', `/v1/gateway/api-keys/${k1}`, dev2)).statusCode).toBe(404);
    expect((await call('DELETE', `/v1/gateway/api-keys/${k1}`, viewer)).statusCode).toBe(404);
    expect((await call('DELETE', `/v1/gateway/api-keys/${k1}`, dev1)).statusCode).toBe(204);
    expect((await call('DELETE', `/v1/gateway/api-keys/${k2}`, owner)).statusCode).toBe(204);
  });

  it('every key of a team draws on ONE allowance', async () => {
    const { owner, teamId } = await setupTeam();
    const a = (await call('POST', '/v1/gateway/api-keys', owner, { label: 'a', services: ['registry_api'], teamId })).json().apiKey;
    const b = (await call('POST', '/v1/gateway/api-keys', owner, { label: 'b', services: ['registry_api'], teamId })).json().apiKey;
    const infoA = await keyBucketInfo(a.key, 100);
    const infoB = await keyBucketInfo(b.key, 100);
    expect(infoA.teamId).toBe(teamId);
    expect(infoB.teamId).toBe(teamId);
    // an administrator can give the whole team a limit, and both keys follow it
    await pool.query(`UPDATE teams SET rate_limit_per_minute = 30 WHERE id = $1`, [teamId]);
    const { forgetKeyRateFactors } = await import('../../domain/gateway/keys');
    forgetKeyRateFactors();
    expect((await keyBucketInfo(a.key, 100)).factor).toBeCloseTo(0.3);
    expect((await keyBucketInfo(b.key, 100)).factor).toBeCloseTo(0.3);
    // a personal key is unaffected: its own bucket, no team
    const personal = (await call('POST', '/v1/gateway/api-keys', owner, { label: 'mine', services: ['registry_api'] })).json().apiKey;
    expect((await keyBucketInfo(personal.key, 100)).teamId).toBeNull();
  });

  it('roles: admins cannot touch owners or hand out admin; the last owner cannot leave or be demoted', async () => {
    const { owner, teamId } = await setupTeam();
    const admin = await join(teamId, owner, 'admin', 'admin');
    const dev = await join(teamId, owner, 'dev', 'developer');
    const members = (await call('GET', `/v1/teams/${teamId}`, owner)).json().members as Array<{ id: string; userId: string; role: string }>;
    const ownerM = members.find((m) => m.userId === owner.id)!;
    const devM = members.find((m) => m.userId === dev.id)!;
    expect((await call('PATCH', `/v1/teams/${teamId}/members/${ownerM.id}`, admin, { role: 'viewer' })).statusCode).toBe(403);
    expect((await call('PATCH', `/v1/teams/${teamId}/members/${devM.id}`, admin, { role: 'admin' })).statusCode).toBe(403);
    expect((await call('PATCH', `/v1/teams/${teamId}/members/${devM.id}`, admin, { role: 'viewer' })).statusCode).toBe(200);
    expect((await call('DELETE', `/v1/teams/${teamId}/members/${ownerM.id}`, admin)).statusCode).toBe(403);
    // the only owner
    expect((await call('PATCH', `/v1/teams/${teamId}/members/${ownerM.id}`, owner, { role: 'admin' })).statusCode).toBe(409);
    const leave = await call('DELETE', `/v1/teams/${teamId}/members/${ownerM.id}`, owner);
    expect(leave.statusCode).toBe(409);
    expect(leave.json().code).toBe('team_last_owner');
    // with a second owner the first may leave
    const adminM = members.find((m) => m.userId === admin.id)!;
    expect((await call('PATCH', `/v1/teams/${teamId}/members/${adminM.id}`, owner, { role: 'owner' })).statusCode).toBe(200);
    expect((await call('DELETE', `/v1/teams/${teamId}/members/${ownerM.id}`, owner)).statusCode).toBe(204);
  });

  it('a member leaving hands the keys they made to the team; deleting the team revokes every key', async () => {
    const { owner, teamId } = await setupTeam();
    const dev = await join(teamId, owner, 'dev', 'developer');
    const keyId = (await call('POST', '/v1/gateway/api-keys', dev, { label: 'dev-key', services: ['registry_api'], teamId })).json().apiKey.id;
    const members = (await call('GET', `/v1/teams/${teamId}`, owner)).json().members as Array<{ id: string; userId: string }>;
    expect((await call('DELETE', `/v1/teams/${teamId}/members/${members.find((m) => m.userId === dev.id)!.id}`, dev)).statusCode).toBe(204);
    const { rows } = await pool.query(`SELECT owner_user_id, revoked_at FROM gateway_api_keys WHERE id = $1`, [keyId]);
    expect(rows[0].owner_user_id).toBe(owner.id);
    expect(rows[0].revoked_at).toBeNull();
    expect((await call('DELETE', `/v1/teams/${teamId}`, owner)).statusCode).toBe(204);
    expect((await call('GET', `/v1/teams/${teamId}`, owner)).statusCode).toBe(404);
    const after = await pool.query(`SELECT 1 FROM gateway_api_keys WHERE id = $1`, [keyId]);
    expect(after.rowCount).toBe(0);
  });

  it('deleting a person hands their team keys and ownership to the best remaining member; the last person takes the team with them', async () => {
    const { owner, teamId } = await setupTeam();
    const admin = await join(teamId, owner, 'admin', 'admin');
    const keyId = (await call('POST', '/v1/gateway/api-keys', owner, { label: 'owners-team-key', services: ['registry_api'], teamId })).json().apiKey.id;
    const personal = (await call('POST', '/v1/gateway/api-keys', owner, { label: 'personal', services: ['registry_api'] })).json().apiKey.id;
    // account deletion revokes the person's PERSONAL keys only, then removes the account
    await gatewayApiKeys.revokeAllForOwner(owner.id);
    await pool.query('DELETE FROM users WHERE id = $1', [owner.id]);
    const key = await pool.query(`SELECT owner_user_id, revoked_at FROM gateway_api_keys WHERE id = $1`, [keyId]);
    expect(key.rows[0].owner_user_id).toBe(admin.id);
    expect(key.rows[0].revoked_at).toBeNull();
    expect((await pool.query(`SELECT revoked_at FROM gateway_api_keys WHERE id = $1`, [personal])).rows.length).toBe(0); // its owner is gone
    const role = await pool.query(`SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`, [teamId, admin.id]);
    expect(role.rows[0].role).toBe('owner');
    // the last member goes: the team and its keys go too
    await pool.query('DELETE FROM users WHERE id = $1', [admin.id]);
    expect((await pool.query(`SELECT 1 FROM teams WHERE id = $1`, [teamId])).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM gateway_api_keys WHERE id = $1`, [keyId])).rowCount).toBe(0);
  });

  it('a person can create only five teams', async () => {
    const u = await mkUser('busy');
    for (let i = 0; i < 5; i++) expect((await call('POST', '/v1/teams', u, { name: `T${i}` })).statusCode).toBe(201);
    const sixth = await call('POST', '/v1/teams', u, { name: 'T5' });
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json().code).toBe('team_limit_reached');
  });
});
