// EXPLAIN the queries behind the busiest and slowest routes on the production database (read-only), and report the
// table sizes, so "tables are small" is a measurement and index use is checked.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/User/desk-api/package.json');
const { Client } = require('pg');
const env = readFileSync('C:/actions-runners/desk-api/_work/live/.env', 'utf8');
const url = /^DATABASE_URL\s*=\s*(.*)$/m.exec(env)[1].trim().replace(/^["']|["']$/g, '');
const c = new Client({ connectionString: url }); await c.connect();
if (process.argv.includes('--force-index')) { await c.query('SET enable_seqscan = off'); console.log('(sequential scans switched off for this session: shows whether an index EXISTS for each query)'); }

const sizes = await c.query(`SELECT relname, n_live_tup::int AS rows, pg_size_pretty(pg_total_relation_size(relid)) AS size FROM pg_stat_user_tables ORDER BY n_live_tup DESC`);
console.log('table sizes:', sizes.rows.map((r) => `${r.relname}=${r.rows} rows/${r.size}`).join(', '));

// a real user id and session hash to make the plans realistic
const u = (await c.query('SELECT id FROM users LIMIT 1')).rows[0]?.id ?? 'x';
const queries = {
  'session lookup (every signed-in request)': ["SELECT id, user_id, token, expires_at, created_at, user_agent, ip, last_used_at FROM sessions WHERE token = $1", ['a'.repeat(64)]],
  'find user by id (every signed-in request)': ['SELECT id, email, password_hash, first_name, last_name, email_confirmed_at, created_at, updated_at FROM users WHERE id = $1', [u]],
  'find user by email (sign-in)': ['SELECT id, email, password_hash, first_name, last_name, email_confirmed_at, created_at, updated_at FROM users WHERE email = $1', ['someone@example.com']],
  'API key lookup (every key call)': ['SELECT id, owner_user_id, revoked_at, created_at, last_used_at, expires_at FROM gateway_api_keys WHERE key_hash = $1', ['b'.repeat(64)]],
  'key grants': ['SELECT service FROM gateway_api_key_grants WHERE api_key_id = $1', ['x']],
  'key or account suspended (every key call)': ['SELECT 1 FROM key_suspensions WHERE api_key_id = $1 UNION ALL SELECT 1 FROM account_suspensions WHERE user_id = $2', ['x', u]],
  'account suspended (every signed-in request)': ['SELECT 1 FROM account_suspensions WHERE user_id = $1', [u]],
  "list a person's drafts": ['SELECT id, draft_json, created_at, updated_at FROM business_setup_drafts WHERE user_id = $1 ORDER BY updated_at DESC', [u]],
  "list a person's businesses": ['SELECT b.id, b.name, b.industry, bm.role FROM businesses b INNER JOIN business_memberships bm ON bm.business_id = b.id WHERE bm.user_id = $1 AND bm.accepted_at IS NOT NULL ORDER BY b.updated_at DESC, b.id LIMIT 101 OFFSET 0', [u]],
  'membership role check': ['SELECT id, role FROM business_memberships WHERE business_id = $1 AND user_id = $2 AND accepted_at IS NOT NULL', ['x', u]],
  'security events for the activity list': ['SELECT id, event, outcome, ip_address, user_agent, created_at FROM security_events WHERE user_id = $1 OR subject = $2 ORDER BY created_at DESC LIMIT 50', [u, 'abc']],
  'usage per day': ['SELECT day, calls, errors FROM gateway_key_usage WHERE api_key_id = $1 AND day >= $2 ORDER BY day DESC', ['x', '2026-01-01']],
  'idempotency lookup': ['SELECT * FROM idempotency_keys WHERE key = $1', ['x']],
};
let seq = 0;
for (const [name, [sql, params]] of Object.entries(queries)) {
  const plan = (await c.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0];
  const nodes = [];
  (function walk(n) { nodes.push(n['Node Type'] + (n['Index Name'] ? `(${n['Index Name']})` : '') + (n['Relation Name'] ? `[${n['Relation Name']}]` : '')); (n.Plans ?? []).forEach(walk); })(plan.Plan);
  const seqScans = nodes.filter((x) => /^Seq Scan/.test(x)).length;
  if (seqScans) seq++;
  console.log(`${plan['Execution Time'].toFixed(2).padStart(7)} ms  ${seqScans ? 'SEQ SCAN' : 'indexed  '}  ${name}  -> ${nodes.join(' > ')}`);
}
console.log(`\nqueries that scan a whole table: ${seq} of ${Object.keys(queries).length} (on tables this small a scan can be the right plan)`);
await c.end();
