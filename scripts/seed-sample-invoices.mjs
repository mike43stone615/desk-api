// Loads three sample invoices (different months, plans and amounts) onto one account, so the Invoices list and the
// "Print to PDF" view can be looked at. They are marked with ids that start with "sample-", so they are easy to remove.
//
// Usage:
//   node scripts/seed-sample-invoices.mjs you@example.com            add the three (safe to run again: an existing month is left alone)
//   node scripts/seed-sample-invoices.mjs you@example.com --remove   delete only the sample ones
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const [email, flag] = process.argv.slice(2);
if (!email) { console.error('Give the account email: node scripts/seed-sample-invoices.mjs you@example.com [--remove]'); process.exit(1); }

const line = (description, quantity, unitCents) => ({ description, quantity, unitCents, totalCents: quantity * unitCents });
const SAMPLES = [
  { month: '2026-07', planId: 'developer', status: 'paid', lines: [line('Pro plan, one month', 1, 1500)] },
  { month: '2026-08', planId: 'business', status: 'paid', lines: [
    line('Business plan, one month', 1, 5000),
    line('Market analyses beyond the 350 included', 41, 30),
    line("API calls beyond the plan's monthly limits", 2150, 3),
  ] },
  { month: '2026-09', planId: 'developer', status: 'open', lines: [
    line('Pro plan, one month', 1, 1500),
    line('Market analyses beyond the 75 included', 37, 30),
    line("API calls beyond the plan's monthly limits", 420, 5),
  ] },
];

const nextMonth = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 1)).toISOString(); };

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const user = (await client.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email])).rows[0];
  if (!user) { console.error(`No account with the email ${email}.`); process.exit(1); }

  if (flag === '--remove') {
    const res = await client.query(`DELETE FROM invoices WHERE subject_type = 'user' AND subject_id = $1 AND id LIKE 'sample-%' RETURNING period_start`, [user.id]);
    console.log(`Removed ${res.rowCount} sample invoice(s).`);
  } else {
    for (const s of SAMPLES) {
      const start = `${s.month}-01T00:00:00.000Z`;
      const subtotal = s.lines.reduce((n, l) => n + l.totalCents, 0);
      const res = await client.query(
        `INSERT INTO invoices (id, subject_type, subject_id, plan_id, period_start, period_end, lines, subtotal_cents, status, created_at)
         VALUES ($1, 'user', $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (subject_type, subject_id, period_start) DO NOTHING`,
        [`sample-${randomUUID()}`, user.id, s.planId, start, nextMonth(s.month), JSON.stringify(s.lines), subtotal, s.status, nextMonth(s.month)],
      );
      console.log(`${s.month} ${s.planId}: ${res.rowCount ? `added ($${(subtotal / 100).toFixed(2)}, ${s.status})` : 'already has an invoice for that month, left alone'}`);
    }
  }
} finally {
  await client.end();
}
