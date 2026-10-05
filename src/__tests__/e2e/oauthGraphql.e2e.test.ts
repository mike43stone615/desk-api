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
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, payload?: unknown) =>
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

  it('granular scopes: an app gets only the pieces it was approved for, field by field', async () => {
    const dev = await mkUser('granular-dev');
    const person = await mkUser('granular');
    const { client, clientSecret } = await registerApp(dev, ['profile:name', 'businesses:basic', 'businesses:formation']);
    // asking for a piece the app did not register for is refused before anyone sees a consent page
    const refused = await call('POST', '/v1/oauth/authorize/decision', person.headers, {
      clientId: client.id, redirectUri: REDIRECT, scope: 'profile:email', state: 'x', codeChallenge: challengeOf(verifierFor()), codeChallengeMethod: 'S256', responseType: 'code', approve: true,
    });
    expect(refused.statusCode).toBe(400);
    const v = verifierFor();
    const code = await authorize(person, client.id, 'profile:name businesses:basic', v);
    const tokens = (await tokenCall({ grant_type: 'authorization_code', client_id: client.id, client_secret: clientSecret!, code, redirect_uri: REDIRECT, code_verifier: v })).json();
    const bearer = { authorization: `Bearer ${tokens.access_token}` };
    // REST: the name without the email address
    const me = (await call('GET', '/v1/auth/session', bearer)).json().user;
    expect(me).toMatchObject({ id: person.id, firstName: 'granular' });
    expect(me.email).toBeUndefined();
    // GraphQL: the name answers, the email is refused on its own
    const body = (await gql(bearer, '{ viewer { id firstName email } }')).json();
    expect(body.data.viewer).toMatchObject({ id: person.id, firstName: 'granular', email: null });
    expect(body.errors[0].extensions.code).toBe('SCOPE_MISSING');
    // approved businesses:basic but not businesses:formation (registered, not asked for): the list works, the details don't
    const biz = (await gql(bearer, '{ businesses { id formation { legalEntity } } }')).json();
    expect(Array.isArray(biz.data.businesses)).toBe(true);
    expect((await call('GET', '/v1/setup/businesses', bearer)).statusCode).toBe(200);
    expect((await call('GET', '/v1/setup/invites', bearer)).statusCode).toBe(403);
  });

  it('the owner can change the redirect addresses of an app and rotate its secret; nobody else can', async () => {
    const dev = await mkUser('redir-dev');
    const other = await mkUser('redir-other');
    const { client, clientSecret } = await registerApp(dev, ['profile:name']);
    const uris = [REDIRECT, 'https://app.example.org/second', 'http://localhost:8080/cb'];
    const changed = await call('PUT', `/v1/oauth/clients/${client.id}/redirect-uris`, dev.headers, { redirectUris: uris });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().client.redirectUris).toEqual(uris);
    expect((await call('PUT', `/v1/oauth/clients/${client.id}/redirect-uris`, dev.headers, { redirectUris: ['http://evil.example.org/cb'] })).statusCode).toBe(400);
    expect((await call('PUT', `/v1/oauth/clients/${client.id}/redirect-uris`, other.headers, { redirectUris: uris })).statusCode).toBe(404);

    const rotated = await call('POST', `/v1/oauth/clients/${client.id}/rotate-secret`, dev.headers, {});
    expect(rotated.statusCode).toBe(200);
    const newSecret = rotated.json().clientSecret as string;
    expect(newSecret).toMatch(/^dsk_cs_/);
    expect(newSecret).not.toBe(clientSecret);
    expect((await call('POST', `/v1/oauth/clients/${client.id}/rotate-secret`, other.headers, {})).statusCode).toBe(404);
    // the old secret no longer works at the token endpoint; the new one does
    const v = verifierFor();
    const person = await mkUser('redir-person');
    const code = await authorize(person, client.id, 'profile:name', v);
    expect((await tokenCall({ grant_type: 'authorization_code', client_id: client.id, client_secret: clientSecret!, code, redirect_uri: REDIRECT, code_verifier: v })).statusCode).toBe(401);
    const code2 = await authorize(person, client.id, 'profile:name', v);
    expect((await tokenCall({ grant_type: 'authorization_code', client_id: client.id, client_secret: newSecret, code: code2, redirect_uri: REDIRECT, code_verifier: v })).statusCode).toBe(200);
    // a public app has no secret to rotate
    const pub = await registerApp(dev, ['profile:name'], false);
    expect((await call('POST', `/v1/oauth/clients/${pub.client.id}/rotate-secret`, dev.headers, {})).statusCode).toBe(400);
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
    for (const [method, url] of [['GET', '/v1/gateway/api-keys'], ['POST', '/v1/gateway/api-keys'], ['GET', '/v1/admin/tables'], ['POST', '/v1/oauth/clients'], ['GET', '/v1/oauth/authorizations']] as const) {
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
    // (presenting the old refresh token again is covered in the next test: it ends the whole grant)
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

  it('presenting a used refresh token again ends the whole grant (a stolen copy), and two simultaneous refreshes cannot both win', async () => {
    const dev = await mkUser('dev5');
    const person = await mkUser('person5');
    const { client, clientSecret } = await registerApp(dev);
    const v = verifierFor();
    const first = (await tokenCall({ grant_type: 'authorization_code', client_id: client.id, client_secret: clientSecret!, code: await authorize(person, client.id, 'profile', v), redirect_uri: REDIRECT, code_verifier: v })).json();
    const refresh = (rt: string) => tokenCall({ grant_type: 'refresh_token', client_id: client.id, client_secret: clientSecret!, refresh_token: rt });
    const second = (await refresh(first.refresh_token)).json();
    expect((await call('GET', '/v1/auth/session', { authorization: `Bearer ${second.access_token}` })).statusCode).toBe(200);
    // the first (used) token is presented again: refused, and the newest pair stops working too
    expect((await refresh(first.refresh_token)).json().error).toBe('invalid_grant');
    expect((await call('GET', '/v1/auth/session', { authorization: `Bearer ${second.access_token}` })).statusCode).toBe(401);
    expect((await refresh(second.refresh_token)).json().error).toBe('invalid_grant');
    // the person approves again and the app works normally
    const again = (await tokenCall({ grant_type: 'authorization_code', client_id: client.id, client_secret: clientSecret!, code: await authorize(person, client.id, 'profile', v), redirect_uri: REDIRECT, code_verifier: v })).json();
    // two refreshes at the same instant with the same token: exactly one wins
    const race = await Promise.all([refresh(again.refresh_token), refresh(again.refresh_token)]);
    expect(race.map((r) => r.statusCode).sort()).toEqual([200, 400]);
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
    const res = await gql(u.headers, '{ viewer { id firstName } teams { name role memberCount members { email role } keys { id } } plan { id maxKeys } businesses { id } drafts { id } }');
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.viewer.id).toBe(u.id);
    expect(data.teams).toEqual([]); // teams no longer exist; the field stays for old integrations and always answers empty
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

  it('GraphQL: business details come from the finished setup, each behind its own scope', async () => {
    const owner = await mkUser('bizdetail');
    const now = new Date().toISOString();
    const full = {
      legalEntity: 'LLC', businessStructure: 'llc', taxElection: 'S Corp', specialLegalDesignation: '', formationState: 'OH', formationCity: 'Anna',
      hasPartners: true, numberOfPartners: 2, isRegisteredBusiness: false, formationAddress: '1 Main St, Anna, OH', formationPlaceId: 'place-1',
      businessIdea: 'Mobile bike repair', customerType: 'B2C', customerProblem: 'No local shop', geographicScope: 'Local', industry: 'Repair',
      additionalIndustries: ['Retail', '', 7], businessPlanSections: [{ title: 'Summary', content: 'Hi' }, null, { title: 'Second' }],
      pricingHypothesis: '$40 a visit', competitors: 'None', validationPlan: 'Ask 20 people',
      requirements: [{ id: 'r1', title: 'Village license', description: 'Yearly', category: 'LICENSE', selection: 'done' }, { title: 'no id' }, 'junk'],
      regulatoryStatuses: ['none'], nameAvailability: { label: 'Available' }, marketResearch: { score: 61 },
      registeredAgentStatus: 'has_one', registeredAgentName: 'Agent Co',
    };
    const fullId = rid();
    const brokenId = rid();
    for (const [id, name, json] of [[fullId, 'Full Biz', JSON.stringify(full)], [brokenId, 'Broken Biz', '{not json']] as const) {
      await pool.query(`INSERT INTO businesses (id, user_id, name, industry, business_json, created_at, updated_at) VALUES ($1,$2,$3,'Repair',$4,$5,$5)`, [id, owner.id, name, json, now]);
      await pool.query(`INSERT INTO business_memberships (id, business_id, user_id, role, accepted_at, created_at, updated_at) VALUES ($1,$2,$3,'owner',$4,$4,$4)`, [rid(), id, owner.id, now]);
    }
    const q = `{ businesses { id name formation { legalEntity taxElection formationState hasPartners numberOfPartners isRegisteredBusiness specialLegalDesignation }
      location { address city state placeId } idea { description customerType additionalIndustries } plan { sections { title content } pricingHypothesis }
      requirements { items { id title selection } regulatoryStatuses } nameCheck marketResearch registeredAgent { status name } members { role } } }`;
    const res = (await gql(owner.headers, q)).json();
    expect(res.errors).toBeUndefined();
    const byName = Object.fromEntries(res.data.businesses.map((b: { name: string }) => [b.name, b]));
    const b = byName['Full Biz'];
    expect(b.formation).toEqual({ legalEntity: 'LLC', taxElection: 'S Corp', formationState: 'OH', hasPartners: true, numberOfPartners: 2, isRegisteredBusiness: false, specialLegalDesignation: null });
    expect(b.location).toEqual({ address: '1 Main St, Anna, OH', city: 'Anna', state: 'OH', placeId: 'place-1' });
    expect(b.idea.additionalIndustries).toEqual(['Retail']);
    expect(b.plan.sections).toEqual([{ title: 'Summary', content: 'Hi' }, { title: 'Second', content: '' }]);
    expect(b.requirements.items).toEqual([{ id: 'r1', title: 'Village license', selection: 'done' }]);
    expect(JSON.parse(b.nameCheck)).toEqual({ label: 'Available' });
    expect(JSON.parse(b.marketResearch)).toEqual({ score: 61 });
    expect(b.registeredAgent).toEqual({ status: 'has_one', name: 'Agent Co' });
    expect(b.members).toEqual([{ role: 'owner' }]);
    // an unreadable stored setup still lists, with every detail empty rather than an error
    const broken = byName['Broken Biz'];
    expect(broken.formation.legalEntity).toBeNull();
    expect(broken.plan.sections).toEqual([]);
    expect(broken.nameCheck).toBeNull();

    // an app approved only for businesses:basic gets the list, and each detail is refused on its own
    const dev = await mkUser('bizdetail-dev');
    const { client, clientSecret } = await registerApp(dev, ['businesses:basic', 'businesses:plan']);
    const v = verifierFor();
    const code = await authorize(owner, client.id, 'businesses:basic', v);
    const tokens = (await tokenCall({ grant_type: 'authorization_code', client_id: client.id, client_secret: clientSecret!, code, redirect_uri: REDIRECT, code_verifier: v })).json();
    const viaApp = (await gql({ authorization: `Bearer ${tokens.access_token}` }, '{ businesses { name plan { pricingHypothesis } location { city } } }')).json();
    expect(viaApp.data.businesses.map((x: { name: string }) => x.name).sort()).toEqual(['Broken Biz', 'Full Biz']);
    expect(viaApp.data.businesses.every((x: { plan: unknown; location: unknown }) => x.plan === null && x.location === null)).toBe(true);
    expect(new Set(viaApp.errors.map((e: { extensions: { scope: string } }) => e.extensions.scope))).toEqual(new Set(['businesses:plan', 'businesses:location']));
    await pool.query('DELETE FROM businesses WHERE id = ANY($1)', [[fullId, brokenId]]);
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
