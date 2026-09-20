// Finds lines in the service's daily log files (see src/supervisor.ts: one file per day, kept 30 days).
//   node scripts/search-logs.mjs <text> [--request <id>] [--days 7] [--dir C:\actions-runners\desk-api\_work\live\logs] [--errors]
// Prints the time, level, message and request id of each match; --raw prints the whole line.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); if (i < 0) return fallback; const v = args[i + 1]; args.splice(i, 2); return v; };
const bool = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const dir = flag('--dir', process.env.LOG_DIR || 'C:\actions-runners\desk-api\_work\live\logs');
const days = Number(flag('--days', '7'));
const request = flag('--request', '');
const raw = bool('--raw');
const errorsOnly = bool('--errors');
const text = args.join(' ').toLowerCase();
if (!text && !request && !errorsOnly) { console.error('Give some text, --request <id> or --errors.'); process.exit(2); }

const cutoff = Date.now() - days * 86_400_000;
const files = readdirSync(dir).filter((n) => /^desk-api-\d{4}-\d{2}-\d{2}(\.err)?\.log$/.test(n)).filter((n) => Date.parse(n.slice(9, 19) + 'T23:59:59Z') >= cutoff).sort();
let matches = 0;
for (const file of files) {
  for (const line of readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    let j = null;
    try { j = JSON.parse(line); } catch { /* not a JSON line */ }
    if (request && !(j?.reqId === request || j?.requestId === request || line.includes(request))) continue;
    if (text && !line.toLowerCase().includes(text)) continue;
    if (errorsOnly && !(j && (j.level >= 50 || (j.res && j.res.statusCode >= 500))) && !file.endsWith('.err.log')) continue;
    matches++;
    if (raw || !j) console.log(`${file}: ${line.slice(0, 400)}`);
    else console.log(`${new Date(j.time).toISOString()} ${j.level} ${j.msg ?? ''} ${j.reqId ?? j.requestId ?? ''} ${j.req ? `${j.req.method} ${j.req.url}` : ''}${j.res ? ` -> ${j.res.statusCode}` : ''}`.trim());
  }
}
console.error(`${matches} matching line(s) in ${files.length} file(s) from the last ${days} day(s).`);
