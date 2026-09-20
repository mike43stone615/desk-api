// The live checks: a short, repeatable end-to-end test of the REAL service, and a CONTRACT test of what each backend
// answers. Run from the repo folder:
//   npx tsx scripts/live-checks/smoke.mts            (about a minute; touches nothing that costs money)
//   npx tsx scripts/live-checks/smoke.mts --full     (also runs one market analysis)
// A daily Windows task runs it (scripts/install-live-checks.ps1). It makes throwaway accounts straight in the database
// (so the sign-up limit is not used up), and removes every one of them at the end. Nothing secret is printed.
//
// The contract part: for every endpoint in GATEWAY_EXAMPLES (real captured answers, src/openapi-examples.ts) it calls the
// live service with a fresh key and checks that the answer still HAS THE SHAPE the published description promises. If a
// backend changes an answer, this is what notices.
import { openHarness, sleep } from './live-lib.mjs';
import { GATEWAY_EXAMPLES } from '../../src/openapi-examples';
import { LIBRARY_OPENAPI_SPEC } from '../../src/openapi';
import { shapeProblems } from '../../src/openapi-schema';

const full = process.argv.includes('--full');
const h = await openHarness('smoke');
const started = Date.now();
try {
  // 1. the service and the published description
  const ready = await h.call('GET', '/health/ready', { pace: 0 });
  h.check('readiness answers 200 and reports no failed dependency', ready.s === 200 && ready.json?.checks?.database === 'ok', `${ready.s} ${ready.text.slice(0, 150)}`);
  const spec = await h.call('GET', '/v1/gateway/openapi.json', { pace: 0 });
  h.check('the published API description is served (with an ETag)', spec.s === 200 && Boolean(spec.h.get('etag')) && Object.keys(spec.json.paths).length >= 20, String(spec.s));
  const catalog = await h.call('GET', '/v1/errors', { pace: 0 });
  h.check('the error catalogue is served', catalog.s === 200 && catalog.json.errors.length > 30, String(catalog.s));

  // 2. an account, both ways of signing in, and the password rules
  const u = await h.mkUser('a');
  const bearer = await h.signin(u);
  const cookie = await h.signin(u, { cookieMode: true });
  h.check('sign-in works with a token and with the browser cookie (no token in the cookie answer)', Boolean(bearer.token) && /__Host-desk_session=/.test(cookie.res.h.get('set-cookie') || '') && !cookie.res.json?.token, `${bearer.status} ${cookie.status}`);
  const wrongPw = await h.call('POST', '/auth/password', { token: bearer.token, body: { currentPassword: 'Wrong!Pass123', password: 'N3w!Passw0rd77' } });
  h.check('a password change with the wrong current password is refused (403) and keeps the session', wrongPw.s === 403 && (await h.call('GET', '/auth/session', { token: bearer.token })).s === 200, String(wrongPw.s));

  // 3. one key for all three APIs, and its life cycle
  const created = await h.call('POST', '/gateway/api-keys', { token: bearer.token, body: { label: 'smoke', services: ['desk_api', 'registry_api', 'market_validation_api'], expiresInDays: 1 }, headers: { 'idempotency-key': `smoke-${h.stamp}` } });
  const key = created.json?.apiKey?.key as string;
  const keyId = created.json?.apiKey?.id as string;
  h.check('a key for all three APIs is created, shown once, with an expiry date', created.s === 201 && Boolean(key) && Boolean(created.json.apiKey.expiresAt), String(created.s));

  // 4. the contract: every documented endpoint still answers with the documented shape
  const skip = full ? new Set<string>() : new Set(['POST /v1/gateway/market/research/analyze']); // costs money upstream
  const specPaths = LIBRARY_OPENAPI_SPEC.paths as unknown as Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }> }> }>>;
  let checked = 0;
  for (const [name, ex] of Object.entries(GATEWAY_EXAMPLES)) {
    if (!/^(GET|POST) \/v1\/(gateway\/(registry|market)\/|auth\/session$|setup\/(businesses|drafts|invites)$)/.test(name) || skip.has(name)) continue;
    const [method, examplePath] = name.split(' ');
    const r = await h.call(method, examplePath.replace('{slug}', 'sole_proprietorship'), { key, body: (ex.request ?? undefined) as Record<string, unknown> | undefined, pace: 250 });
    const op = specPaths[examplePath.replace(/^\/v1/, '')]?.[method.toLowerCase()];
    const schema = op && Object.values(op.responses[String(ex.status)]?.content ?? {})[0]?.schema;
    const problems = schema ? shapeProblems(schema, r.json) : ['no schema in the published description'];
    h.check(`contract ${name}: answers ${ex.status} in the documented shape`, r.s === ex.status && problems.length === 0, `${r.s} ${problems.slice(0, 3).join('; ')}`);
    checked++;
  }
  h.check(`the contract check covered the key-callable endpoints (${checked})`, checked >= 12, String(checked));

  // 5. usage, suspend/resume, revoke
  await sleep(500);
  const usage = await h.call('GET', `/v1/gateway/api-keys/${keyId}/usage`, { token: bearer.token });
  h.check('the key\'s own usage shows the calls just made', usage.s === 200 && usage.json.totals.calls >= checked, JSON.stringify(usage.json?.totals));
  const suspended = await h.call('POST', `/v1/gateway/api-keys/${keyId}/suspend`, { token: bearer.token });
  const refused = await h.call('GET', '/v1/auth/session', { key });
  const resumed = await h.call('POST', `/v1/gateway/api-keys/${keyId}/resume`, { token: bearer.token });
  const back = await h.call('GET', '/v1/auth/session', { key });
  h.check('a suspended key is refused (403) and works again when resumed', suspended.s === 200 && refused.s === 403 && resumed.s === 200 && back.s === 200, `${suspended.s} ${refused.s} ${resumed.s} ${back.s}`);
  const revoked = await h.call('DELETE', `/v1/gateway/api-keys/${keyId}`, { token: bearer.token });
  const gone = await h.call('GET', '/v1/auth/session', { key });
  h.check('a revoked key is refused for good (401) and the second revoke is a 404', revoked.s === 204 && gone.s === 401 && (await h.call('DELETE', `/v1/gateway/api-keys/${keyId}`, { token: bearer.token })).s === 404, `${revoked.s} ${gone.s}`);

  // 6. leaving: the export, then deleting the account
  const exportRes = await h.call('GET', '/v1/auth/account/export', { token: bearer.token });
  h.check('the person can download their data, with no credential in it', exportRes.s === 200 && !exportRes.text.includes(bearer.token as string) && !/password_hash/.test(exportRes.text), String(exportRes.s));
  const del = await h.call('POST', '/auth/account/delete', { token: bearer.token, body: { password: u.password } });
  const after = await h.call('POST', '/auth/signin', { body: { email: u.email, password: u.password } });
  h.check('deleting the account works and the account is gone', del.s === 200 && after.s === 401, `${del.s} ${after.s}`);
} catch (err) {
  // Anything unexpected (the service unreachable, a crash in a check) is a FAILED run, never a quiet pass.
  h.check('the checks ran to the end without an unexpected error', false, err instanceof Error ? err.message : String(err));
} finally {
  const failed = h.results.filter((r) => !r.ok).length;
  await h.cleanup();
  console.log(`\nlive checks: ${h.results.length - failed} passed, ${failed} failed, ${Math.round((Date.now() - started) / 1000)} s`);
  process.exit(failed ? 1 : 0);
}
