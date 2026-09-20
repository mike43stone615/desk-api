// Runs the exact locking statements the routes use (draft creation, owner removal, account deletion) concurrently, many
// rounds, on throwaway rows, and reports database deadlocks (40P01), other errors and ownerless businesses.
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
const require = createRequire(process.cwd() + '/package.json');
const { Pool } = require('pg');
// Only ever run against a scratch database (create one by hand, then "npm run migrate"): this creates and deletes rows in bulk.
//   DATABASE_URL=postgres://.../deskapi_stress_test node scripts/stress-locks.mjs [rounds]
const url = process.env.DATABASE_URL ?? '';
if (!/_(test|dev)(\?|$)/.test(url)) { console.error('Set DATABASE_URL to a scratch database whose name ends in _test or _dev.'); process.exit(2); }
const pool = new Pool({ connectionString: url, max: 30 });
const ROUNDS = Number(process.argv[2] ?? 40);
const id = () => randomBytes(16).toString('hex');
const now = () => new Date().toISOString();
const tally = { deadlock: 0, other: 0, ok: 0, ownerless: 0, refused: 0 };
const made = { users: [], businesses: [] };

async function mkUser() {
  const u = id();
  await pool.query(`INSERT INTO users (id, email, password_hash, first_name, last_name, email_confirmed_at, created_at, updated_at) VALUES ($1,$2,'x','S','T',$3,$3,$3)`, [u, `stress-${u}@example.com`, now()]);
  made.users.push(u);
  return u;
}
async function mkBusiness(owners) {
  const b = id();
  await pool.query(`INSERT INTO businesses (id, user_id, name, industry, business_json, created_at, updated_at) VALUES ($1,$2,'stress','x','{}',$3,$3)`, [b, owners[0], now()]);
  for (const o of owners) await pool.query(`INSERT INTO business_memberships (id, business_id, user_id, role, accepted_at, created_at, updated_at) VALUES ($1,$2,$3,'owner',$4,$4,$4)`, [id(), b, o, now()]);
  made.businesses.push(b);
  return b;
}
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await fn(c); await c.query('COMMIT'); tally.ok++; }
  catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    if (e.code === '40P01') tally.deadlock++;
    else if (e.refused) tally.refused++;
    else { tally.other++; if (tally.other < 4) console.log('  other error:', e.code, String(e.message).slice(0, 100)); }
  } finally { c.release(); }
}
// same statements as removeMemberHandler
const removeMember = (b, membershipId) => tx(async (c) => {
  await c.query(`SELECT id FROM businesses WHERE id = $1 FOR UPDATE`, [b]);
  const t = (await c.query(`SELECT id, role FROM business_memberships WHERE id = $1 AND business_id = $2`, [membershipId, b])).rows[0];
  if (!t) throw Object.assign(new Error('gone'), { refused: true });
  const n = Number((await c.query(`SELECT COUNT(*)::text AS count FROM business_memberships WHERE business_id = $1 AND role = 'owner' AND accepted_at IS NOT NULL`, [b])).rows[0].count);
  if (n <= 1) throw Object.assign(new Error('last'), { refused: true });
  await c.query(`DELETE FROM business_memberships WHERE id = $1 AND business_id = $2`, [membershipId, b]);
});
const createDraft = (u) => tx(async (c) => {
  await c.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [u]);
  const n = Number((await c.query(`SELECT COUNT(*)::text AS count FROM business_setup_drafts WHERE user_id = $1`, [u])).rows[0].count);
  if (n >= 5) throw Object.assign(new Error('limit'), { refused: true });
  await c.query(`INSERT INTO business_setup_drafts (id, user_id, draft_json, created_at, updated_at) VALUES ($1,$2,'{}',$3,$3)`, [id(), u, now()]);
});
const deleteAccount = (u) => tx(async (c) => { await c.query(`DELETE FROM users WHERE id = $1`, [u]); });

for (let r = 0; r < ROUNDS; r++) {
  const [a, b, c3] = [await mkUser(), await mkUser(), await mkUser()];
  const biz1 = await mkBusiness([a, b]); // two owners who try to remove each other
  const biz2 = await mkBusiness([b, c3]); // shares owner b with biz1
  const m = async (bz, u) => (await pool.query(`SELECT id FROM business_memberships WHERE business_id=$1 AND user_id=$2`, [bz, u])).rows[0]?.id;
  const [a1, b1, b2, c2] = [await m(biz1, a), await m(biz1, b), await m(biz2, b), await m(biz2, c3)];
  await Promise.all([
    removeMember(biz1, a1), removeMember(biz1, b1), removeMember(biz2, b2), removeMember(biz2, c2),
    createDraft(a), createDraft(a), createDraft(a), createDraft(b), createDraft(b), createDraft(c3),
    deleteAccount(b), // account deleted while everything above is in flight
    removeMember(biz1, a1), removeMember(biz2, c2),
  ]);
  const over = (await pool.query(`SELECT user_id FROM business_setup_drafts WHERE user_id = ANY($1) GROUP BY user_id HAVING COUNT(*) > 5`, [[a, b, c3]])).rowCount;
  if (over) { tally.other++; console.log('  draft limit exceeded'); }
  // a business whose owners were all removed by the removal path (not by deleting the person) is a bug: b's deletion may
  // legitimately leave a business with one owner, and a and c3 are never deleted, so a business with zero owners while a or c3 was removed
  for (const [bz, keep] of [[biz1, a], [biz2, c3]]) {
    const exists = (await pool.query(`SELECT 1 FROM businesses WHERE id=$1`, [bz])).rowCount;
    if (!exists) continue;
    const owners = (await pool.query(`SELECT user_id FROM business_memberships WHERE business_id=$1 AND role='owner'`, [bz])).rows.map((x) => x.user_id);
    // b is deleted, so zero owners means both removal paths (a's and b's membership) succeeded against the last-owner rule
    if (owners.length === 0) tally.ownerless++;
    void keep;
  }
}

// cleanup
await pool.query(`DELETE FROM business_setup_drafts WHERE user_id = ANY($1)`, [made.users]);
await pool.query(`DELETE FROM business_memberships WHERE business_id = ANY($1)`, [made.businesses]);
await pool.query(`DELETE FROM businesses WHERE id = ANY($1)`, [made.businesses]);
await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [made.users]);
const left = (await pool.query(`SELECT COUNT(*)::int n FROM users WHERE email LIKE 'stress-%@example.com'`)).rows[0].n;
console.log(`${ROUNDS} rounds x 13 concurrent transactions:`, JSON.stringify(tally), `| leftover stress users: ${left}`);
await pool.end();
process.exit(tally.deadlock || tally.other || tally.ownerless || left ? 1 : 0);
