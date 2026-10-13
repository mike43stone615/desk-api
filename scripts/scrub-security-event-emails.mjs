// One-off cleanup (October 2026): before 67e39b5 the key-sharing audit stored the invitee's e-mail address in full in
// security_events.detail (as sharedWithEmail). This replaces every e-mail address found in any security_events detail
// with the same fingerprint the logs use (email:<12 hex>), and renames sharedWithEmail to sharedWith.
//   node scripts/scrub-security-event-emails.mjs            # dry run: counts only, changes nothing
//   node scripts/scrub-security-event-emails.mjs --apply    # makes the change, in one transaction
// Reads the database address from the live service's settings. Never prints an address. Safe to run again.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const { Client } = require('pg');
const apply = process.argv.includes('--apply');
const env = readFileSync('C:/actions-runners/desk-api/_work/live/.env', 'utf8');
const url = (/^DATABASE_URL\s*=\s*(.*)$/m.exec(env)?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
if (!url) throw new Error('DATABASE_URL not found in the live settings');

const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}/g;
const fingerprint = (e) => `email:${createHash('sha256').update(e.trim().toLowerCase()).digest('hex').slice(0, 12)}`;
let replaced = 0;
function scrub(value) {
  if (typeof value === 'string') return value.replace(EMAIL, (m) => (replaced++, fingerprint(m)));
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k === 'sharedWithEmail' ? 'sharedWith' : k] = scrub(v);
    return out;
  }
  return value;
}

const db = new Client({ connectionString: url });
await db.connect();
try {
  await db.query('BEGIN');
  const { rows } = await db.query(`SELECT id, detail FROM security_events WHERE detail::text ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}' FOR UPDATE`);
  for (const r of rows) await db.query('UPDATE security_events SET detail = $1 WHERE id = $2', [JSON.stringify(scrub(r.detail)), r.id]);
  const { rows: left } = await db.query(`SELECT count(*)::int AS n FROM security_events WHERE detail::text ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}'`);
  console.log(`${rows.length} security event(s) contained an e-mail address (${replaced} address(es)); after the change: ${left[0].n} would remain.`);
  if (left[0].n !== 0) throw new Error('some addresses were not replaced; nothing was changed');
  if (apply) { await db.query('COMMIT'); console.log('Applied.'); }
  else { await db.query('ROLLBACK'); console.log('Dry run: nothing was changed. Run again with --apply to make the change.'); }
} catch (err) {
  await db.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  await db.end();
}
