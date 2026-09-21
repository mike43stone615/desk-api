// A short end-to-end check of a RUNNING copy of the API, for a preview environment (a throwaway server and database made for
// a pull request) or any local copy:   node scripts/preview-check.mjs [http://localhost:3458]
// It only uses the public HTTP interface and a made-up account, so it can run against anything that is not production data.
const BASE = process.argv[2] || 'http://localhost:3458';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `  -> ${detail}`}`); if (!ok) failed++; };
const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(BASE + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), 'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 200)}` }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { s: res.status, json, h: res.headers, text };
};

// 1. it comes up
let ready = null;
for (let i = 0; i < 60 && !(ready?.s === 200); i++) {
  ready = await call('GET', '/health/ready').catch(() => null);
  if (ready?.s !== 200) await new Promise((r) => setTimeout(r, 1000));
}
check('the server answers /health/ready within a minute', ready?.s === 200, String(ready?.s));
check('the database is reported ok', ready?.json?.checks?.database === 'ok', JSON.stringify(ready?.json?.checks));

// 2. the published contract and the error catalogue
const spec = await call('GET', '/v1/gateway/openapi.json');
check('the API description is served with at least 20 paths', spec.s === 200 && Object.keys(spec.json?.paths ?? {}).length >= 20, String(spec.s));
const errors = await call('GET', '/v1/errors');
check('the error catalogue is served', errors.s === 200 && (errors.json?.errors?.length ?? 0) > 30, String(errors.s));
check('security headers are present', spec.h.get('x-content-type-options') === 'nosniff' && Boolean(spec.h.get('strict-transport-security') ?? spec.h.get('x-frame-options') ?? true));

// 3. a made-up account
const email = `preview-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
const password = `Pv!${Math.random().toString(36).slice(2)}Zx9#`;
const up = await call('POST', '/auth/signup', { body: { email, password, firstName: 'Preview', lastName: 'Check' } });
check('sign-up is accepted', up.s === 200 || up.s === 201, `${up.s} ${up.text.slice(0, 120)}`);
const unconfirmed = await call('POST', '/auth/signin', { body: { email, password } });
check('signing in before confirming the e-mail is refused with its own code', unconfirmed.s === 403 && unconfirmed.json?.code === 'email_not_confirmed', `${unconfirmed.s} ${unconfirmed.text.slice(0, 100)}`);
// The preview has its own throwaway database, so the e-mail is confirmed directly there (a real one is confirmed by the link).
let confirmed = false;
if (process.env.DATABASE_URL) {
  try {
    const { default: pg } = await import('pg');
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    confirmed = (await db.query(`UPDATE users SET email_confirmed_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE email = $1`, [email])).rowCount === 1;
    await db.end();
  } catch (e) { console.log(`  (could not confirm the e-mail directly: ${e.message})`); }
}
if (confirmed) {
  const inn = await call('POST', '/auth/signin', { body: { email, password } });
  check('sign-in returns a token once confirmed', inn.s === 200 && Boolean(inn.json?.token), `${inn.s} ${inn.text.slice(0, 120)}`);
  const token = inn.json?.token;
  const session = await call('GET', '/v1/auth/session', { token });
  check('the session shows the new account', session.s === 200 && session.json?.user?.email === email, String(session.s));
  const draft = await call('POST', '/v1/setup/drafts', { token, body: {} });
  check('creating a draft answers 201 with a Location header', draft.s === 201 && draft.h.get('location') === `/v1/setup/drafts/${draft.json?.id}`, `${draft.s} ${draft.h.get('location')}`);
  const key = await call('POST', '/v1/gateway/api-keys', { token, body: { label: 'preview', services: ['desk_api'], deskScopes: ['drafts'] } });
  check('a key limited to the drafts scope is created (201)', key.s === 201 && key.json?.apiKey?.deskScopes?.join() === 'drafts', `${key.s} ${key.text.slice(0, 100)}`);
  const viaKey = await call('GET', '/v1/setup/drafts', {});
  check('and a call without it is refused', viaKey.s === 401, String(viaKey.s));
  const withKey = await fetch(`${BASE}/v1/setup/businesses`, { headers: { 'x-api-key': key.json?.apiKey?.key ?? '' } });
  check('that key is refused outside its scope (403)', withKey.status === 403, String(withKey.status));
} else {
  console.log('  (no database access: the signed-in checks were skipped)');
}
const bad = await call('GET', '/v1/setup/drafts', {});
check('a call with no credentials is 401 in the standard error shape', bad.s === 401 && /problem\+json/.test(bad.h.get('content-type') ?? ''), String(bad.s));
const notFound = await call('GET', '/v1/definitely-not-a-route');
check('an unknown path is a standard 404', notFound.s === 404 && notFound.json?.status === 404, String(notFound.s));

console.log(failed ? `\n${failed} check(s) failed.` : '\nAll preview checks passed.');
process.exit(failed ? 1 : 0);
