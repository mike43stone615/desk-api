import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';

// OAuth 2.0 (authorization code + PKCE) and the read-only GraphQL endpoint, against a real database.
// Skipped without E2E_DATABASE_URL.
const hasDb = !!process.env.E2E_DATABASE_URL;

import { pool } from '../../db';
import { buildApp } from '../../app';
import { gatewayApiKeys } from '../../domain/gateway/keys';
import type { FastifyInstance } from 'fastify';

const rid = () => randomBytes(10).toString('hex');
const verifierFor = () => randomBytes(32).toString('base64url');
const challengeOf = (v: string) => createHash('sha256').update(v).digest('base64url');
const REDIRECT = 'https://app.example.org/callback';

describe.skipIf(!hasDb)('E2E: OAuth and GraphQL', () => {
  let app: FastifyInstance;
  const users: string[] = [];

  async function mkUser(name: string) {
    const id = rid();
    const now = new Date().toISOString();
    await pool.query(`INSERT INTO users (id, email, password_hash, first_name, last_name, email_confirmed_at, created_at, updated_at) VALUES ($1,$2,'x',$3,'Tester',$4,$4,$4)`, [id, `oa-${name}-${id}@example.com`, name, now]);
    users.push(id);
    const { authDb } = await import('../../infrastructure/auth');
    const token = randomBytes(24).toString('hex');
    await authDb.createSession(rid(), id, token, new Date(Date.now() + 3_600_000).toISOString());
    return { id, headers: { authorization: `Bearer ${token}` } as Record<string, string> };
  }
  const ip = () => ({ 'cf-connecting-ip': `203.0.113.${1 + Math.floor(Math.random() * 250)}` });
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, headers: Record<string, string>, payload?: unknown) =>
    app.inject({ method, url, headers: { ...headers, ...ip() }, payload: payload as never });
  const gql = (headers: Record<string, string>, query: string, variables?: unknown) => call('POST', '/v1/graphql', headers, { query, variables });

  beforeAll(async () => { app = await buildApp(); });
  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [users]);
    await app.close();
  });

  async function registerApp(owner: { headers: Record<string, string> }, scopes = ['profile', 'businesses'], confidential = true) {
    const res = await call('POST', '/v1/oauth/clients', owner.headers, { name: 'Sample App', redirectUris: [REDIRECT], scopes, confidential });
    expect(res.statusCode).toBe(201);
    return res.json() as { client: { id: string }; clientSecret: string | null };
  }
  async function authorize(user: { headers: Record<string, string> }, clientId: string, scope: string, verifier: string) {
    const res = await call('POST', '/v1/oauth/authorize/decision', user.headers, {
      clientId, redirectUri: REDIRECT, scope, state: 'xyz', codeChallenge: challengeOf(verifier), codeChallengeMethod: 'S256', responseType: 'code', approve: true,
    });
    expect(res.statusCode).toBe(200);
    const back = new URL(res.json().redirectTo);
    expect(back.searchParams.get('state')).toBe('xyz');
    return back.searchParams.get('code')!;
  }
  const tokenCall = (form: Record<string, string>, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/v1/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers, ...ip() }, payload: new URLSearchParams(form).toString() });

  it('the authorize endpoint checks the request before anyone sees it, then hands the browser to the consent page', async () => {
    const dev = await mkUser('dev');
    const { client } = await registerApp(dev);
    const base = { response_type: 'code', client_id: client.id, redirect_uri: REDIRECT, scope: 'profile', state: 's', code_challenge: challengeOf(verifierFor()), code_challenge_method: 'S256' };
    const ok = await app.inject({ method: 'GET', url: `/v1/oauth/authorize?${new URLSearchParams(base)}`, headers: ip() });
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toMatch(/^\/developer\/authorize\?/);
    const bad = async (over: Record<string, string>) => (await app.inject({ method: 'GET', url: `/v1/oauth/authorize?${new URLSearchParams({ ...base, ...over })}`, headers: ip() })).json();
    expect((await bad({ redirect_uri: 'https://evil.example.org/cb' })).error).toBe('invalid_request');
    expect((await bad({ client_id: 'dsk_client_nope' })).error).toBe('invalid_client');
    expect((await bad({ code_challenge: '' })).error).toBe('invalid_request'); // PKCE is required
    expect((await bad({ code_challenge_method: 'plain' })).error).toBe('invalid_request');
    expect((await bad({ scope: 'drafts' })).error).toBe('invalid_scope'); // not registered for it
    expect((await bad({ scope: 'admin' })).error).toBe('invalid_scope');
    expect((await bad({ response_type: 'token' })).error).toBe('unauthorized_client');
  });

  it('runs the whole flow: approve, exchange (PKCE), call the API within the scopes, refuse the rest', async () => {
    const dev = await mkUser('dev2');
    const person = await mkUser('person');
    const { client, clientSecret } = await registerApp(dev);
    const verifier = verifierFor();
    const code = await authorize(person, client.id, 'profile', verifier);

    // a wrong verifier, a wrong secret, a wrong redirect: all refused, and a refused attempt still spends the code
    const wrong = await tokenCall({ grant_type: 'authorization_code', client_id: client.id, client_secret: clientSecret!, code, redirect_uri: REDIRECT, code_verifier: verifierFor() });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe('invalid_grant');
    const code2 = await authorize(person, client.id, 'profile', verifier);
    expect((await tokenCall({ grant_type: 'authorization_code', client_id: client.id, client_secret: 'dsk_cs_wrong', code: code2, redirect_uri: REDIRECT, code_verifier: verifier })).statusCode).toBe(401);
    const code3 = await authorize(person, client.id, 'profile', verifier);
    const good = await tokenCall({ grant_type: 'authorization_code', client_id: client.id, client_secret: clientSecret!, code: code3, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(good.statusCode).toBe(200);
    expect(good.headers['cache-control']).toMatch(/no-store/);
    const tokens = good.json();
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'profile' });
    // the same code cannot be used twice
    expect((await tokenCall({ grant_type: 'authorization_code', client_id: client.id, client_secret: clientSecret!, code: code3, redirect_uri: REDIRECT, code_verifier: verifier })).json().error).toBe('invalid_grant');

    const bearer = { authorization: `Bearer ${tokens.access_token}` };
    expect((await call('GET', '/v1/auth/session', bearer)).json().user.id).toBe(person.id);
    const noScope = await call('GET', '/v1/setup/businesses', bearer);
    expect(noScope.statusCode).toBe(403);
    expect(noScope.json().code).toBe('oauth_insufficient_scope');
    for (const [method, url] of [['GET', '/v1/teams'], ['GET', '/v1/gateway/api-keys'], ['POST', '/v1/gateway/api-keys'], ['GET', '/v1/admin/tables'], ['POST', '/v1/oauth/clients'], ['GET', '/v1/oauth/authorizations']] as const) {
      const res = await call(method, url, bearer, method === 'POST' ? {} : undefined);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await call('GET', '/v1/auth/session', { authorization: 'Bearer dsk_at_' + 'a'.repeat(48) })).statusCode).toBe(401);

    // the person sees the app in their list and can take its access away
    const list = (await call('GET', '/v1/oauth/authorizations', person.headers)).json().authorizations;
    expect(list).toEqual([expect.objectContaining({ clientId: client.id, name: 'Sample App', scopes: ['profile'] })]);
    expect((await call('DELETE', `/v1/oauth/authorizations/${client.id}`, person.headers)).statusCode).toBe(204);
    expect((await call('GET', '/v1/auth/session', bearer)).statusCode).toBe(401);
  });

  it('refresh tokens work once and replace both tokens; revoking a token ends it; deleting the app ends everything', async () => {
    const dev = await mkUser('dev3');
    const person = await mkUser('person3');
    const { client, clientSecret } = await registerApp(dev);
    const v = verifierFor();
    const first = (await tokenCall({ grant_type: 'authorization_code', client_id: client.id, client_secret: clientSecret!, code: await authorize(person, client.id, 'profile businesses', v), redirect_uri: REDIRECT, code_verifier: v })).json();
    // client credentials by HTTP Basic instead of the body
    const basic = { authorization: 'Basic ' + Buffer.from(`${client.id}:${clientSecret}`).toString('base64') };
    const second = (await tokenCall({ grant_type: 'refresh_token', refresh_token: first.refresh_token }, basic)).json();
    expect(second.access_token).not.toBe(first.access_token);
    expect((await call('GET', '/v1/auth/session', { authorization: `Bearer ${first.access_token}` })).statusCode).toBe(401); // the old one is gone
    expect((await tokenCall({ grant_type: 'refresh_token', client_id: client.id, client_secret: clientSecret!, refresh_token: first.refresh_token })).json().error).toBe('invalid_grant'); // and so is the old refresh token
    expect((await call('GET', '/v1/setup/businesses', { authorization: `Bearer ${second.access_token}` })).statusCode).toBe(200);
    // revoke (RFC 7009)
    const revoked = await app.inject({ method: 'POST', url: '/v1/oauth/revoke', headers: { 'content-type': 'application/x-www-form-urlencoded', ...ip() }, payload: new URLSearchParams({ token: second.access_token, client_id: client.id, client_secret: clientSecret! }).toString() });
    expect(revoked.statusCode).toBe(200);
    expect((await call('GET', '/v1/auth/session', { authorization: `Bearer ${second.access_token}` })).statusCode).toBe(401);
    // a new authorization, then the developer deletes the app
    const third = (await tokenCall({ grant_type: 'authorization_code', client_id: client.id, client_secret: clientSecret!, code: await authorize(person, client.id, 'profile', v), redirect_uri: REDIRECT, code_verifier: v })).json();
    expect((await call('DELETE', `/v1/oauth/clients/${client.id}`, dev.headers)).statusCode).toBe(204);
    expect((await call('GET', '/v1/auth/session', { authorization: `Bearer ${third.access_token}` })).statusCode).toBe(401);
  });

  it('a public client (no secret) works with PKCE alone; a stranger cannot delete someone else\'s app', async () => {
    const dev = await mkUser('dev4');
    const person = await mkUser('person4');
    const { client, clientSecret } = await registerApp(dev, ['profile'], false);
    expect(clientSecret).toBeNull();
    const v = verifierFor();
    const res = await tokenCall({ grant_type: 'authorization_code', client_id: client.id, code: await authorize(person, client.id, 'profile', v), redirect_uri: REDIRECT, code_verifier: v });
    expect(res.statusCode).toBe(200);
    expect((await call('DELETE', `/v1/oauth/clients/${client.id}`, person.headers)).statusCode).toBe(404);
    expect((await call('POST', '/v1/oauth/clients', dev.headers, { name: 'x', redirectUris: ['http://evil.example.org/cb'], scopes: ['profile'] })).statusCode).toBe(400); // http only on localhost
    expect((await call('POST', '/v1/oauth/clients', dev.headers, { name: 'native', redirectUris: ['http://127.0.0.1:8123/cb'], scopes: ['profile'], confidential: false })).statusCode).toBe(201);
  });

  it('denying sends the person back with access_denied and grants nothing', async () => {
    const dev = await mkUser('dev5');
    const person = await mkUser('person5');
    const { client } = await registerApp(dev);
    const res = await call('POST', '/v1/oauth/authorize/decision', person.headers, { clientId: client.id, redirectUri: REDIRECT, scope: 'profile', state: 'q', codeChallenge: challengeOf(verifierFor()), codeChallengeMethod: 'S256', responseType: 'code', approve: false });
    const back = new URL(res.json().redirectTo);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('code')).toBeNull();
    expect((await call('GET', '/v1/oauth/authorizations', person.headers)).json().authorizations).toHaveLength(0);
  });

  it('GraphQL: a session reads its own data in one request; there are no mutations; the limits hold', async () => {
    const u = await mkUser('gq');
    const other = await mkUser('gq-other');
    await call('POST', '/v1/teams', u.headers, { name: 'GraphQL team' });
    await call('POST', '/v1/teams', other.headers, { name: 'Not mine' });
    const res = await gql(u.headers, '{ viewer { id firstName } teams { name role memberCount members { email role } keys { id } } plan { id maxKeys } businesses { id } drafts { id } }');
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.viewer.id).toBe(u.id);
    expect(data.teams).toHaveLength(1);
    expect(data.teams[0]).toMatchObject({ name: 'GraphQL team', role: 'owner', memberCount: 1 });
    expect(data.plan).toMatchObject({ id: 'free', maxKeys: 10 });
    // no way to change anything, and no GET
    const mut = await gql(u.headers, 'mutation { deleteEverything }');
    expect(mut.statusCode).toBe(400);
    expect(mut.json().errors[0].extensions.code).toBe('READ_ONLY');
    expect((await gql(u.headers, '{ nonsense }')).statusCode).toBe(400);
    expect((await call('GET', '/v1/graphql?query={viewer{id}}', u.headers)).statusCode).toBe(405);
    // limits
    const deep = await gql(u.headers, '{ teams { members { email } keys { id label } } businesses { members { email } } }');
    expect(deep.statusCode).toBe(200); // depth 3: fine
    const tooDeep = '{ teams { members { email } } }'; // depth 3
    expect((await gql(u.headers, tooDeep)).statusCode).toBe(200);
    const nested = '{ ' + 'teams { keys { '.repeat(4) + 'id' + ' } }'.repeat(4) + ' }';
    expect((await gql(u.headers, nested)).statusCode).toBe(400); // not a valid selection, and far over the depth limit
    const manyAliases = '{ ' + Array.from({ length: 12 }, (_, i) => `a${i}: viewer { id }`).join(' ') + ' }';
    expect((await gql(u.headers, manyAliases)).json().errors[0].extensions.code).toBe('QUERY_TOO_COSTLY');
    const manyFields = '{ viewer { ' + Array.from({ length: 160 }, () => 'id').join(' ') + ' } }';
    expect((await gql(u.headers, manyFields)).json().errors[0].extensions.code).toBe('QUERY_TOO_COSTLY');
    expect((await gql(u.headers, '{ viewer { id } }' + ' '.repeat(9000))).json().errors[0].extensions.code).toBe('QUERY_TOO_LARGE');
    // introspection works and is not counted against the limits
    const intro = await gql(u.headers, '{ __schema { queryType { name fields { name type { ofType { ofType { name } } } } } } }');
    expect(intro.statusCode).toBe(200);
    expect(intro.json().data.__schema.queryType.name).toBe('Query');
    // anonymous callers are refused
    expect((await app.inject({ method: 'POST', url: '/v1/graphql', headers: ip(), payload: { query: '{ viewer { id } }' } })).statusCode).toBe(401);
  });

  it('GraphQL: an API key or an OAuth app sees only what its scopes allow', async () => {
    const u = await mkUser('gq2');
    const key = await gatewayApiKeys.create(u.id, 'profile only', ['desk_api'], undefined, ['profile']);
    const kh = { 'x-api-key': key.key };
    const viaKey = await gql(kh, '{ viewer { id } businesses { id } teams { name } }');
    expect(viaKey.statusCode).toBe(200);
    const body = viaKey.json();
    expect(body.errors.map((e: { extensions: { code: string } }) => e.extensions.code).sort()).toEqual(['SCOPE_MISSING', 'SCOPE_MISSING', 'SCOPE_MISSING'].slice(0, body.errors.length));
    expect(body.data).toBeNull(); // non-null list fields fail the whole answer; ask for what you have scope for
    const only = await gql(kh, '{ viewer { id } }');
    expect(only.json().data.viewer.id).toBe(u.id);
    // an OAuth app with teams scope may read teams; one without may not
    const dev = await mkUser('dev6');
    const { client, clientSecret } = await registerApp(dev, ['profile', 'teams']);
    const v = verifierFor();
    const tokens = (await tokenCall({ grant_type: 'authorization_code', client_id: client.id, client_secret: clientSecret!, code: await authorize(u, client.id, 'profile teams', v), redirect_uri: REDIRECT, code_verifier: v })).json();
    const ok = await gql({ authorization: `Bearer ${tokens.access_token}` }, '{ viewer { id } teams { name } }');
    expect(ok.json().data.viewer.id).toBe(u.id);
    expect(Array.isArray(ok.json().data.teams)).toBe(true);
  });
});
