// Looks through the service's log files for personal data or secrets that should never be written there.
//   node scripts/scan-logs.mjs [logs-folder ...]        (default: the live service's logs and ./logs)
// Reports, for each kind of finding, how many lines contain it and one example line NUMBER and file (never the text
// itself, so running this cannot spread what it finds). Exit code 1 if anything is found. Run daily by the live checks.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_DIRS = ['C:/actions-runners/desk-api/_work/live/logs', path.join(process.cwd(), 'logs')];
const dirs = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_DIRS;
const DAYS = Number(process.env.SCAN_LOG_DAYS) || 7;

// An e-mail address is fine when it is one of ours or a documentation domain used in tests.
const ALLOWED_EMAIL = /@(example\.(com|org|net)|deskbusiness\.co)$/i;
const RULES = [
  { name: 'e-mail address', re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}/g, allow: (m) => ALLOWED_EMAIL.test(m) },
  { name: 'API library key', re: /deskgw_[0-9a-f]{20,}/g },
  { name: 'backend API key', re: /\b(?:regapi|mvapi)_[0-9a-zA-Z]{16,}/g },
  { name: 'bearer token', re: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
  { name: 'session or reset token (long hex)', re: /"(?:token|password|secret|apiKey|api_key|authorization|cookie)"\s*:\s*"[^"[][^"]{15,}"/gi },
  { name: 'US phone number', re: /\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g },
  { name: 'social security number', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: 'payment card number', re: /(?<![\w.-])(?:\d{4}[ -]){3}\d{3,4}(?![\w.-])|(?<![\w.-])(?<!id":")\d{15,16}(?![\w.-])/g, allow: (m) => !luhn(m.replace(/\D/g, '')) },
];

/** Card numbers pass the Luhn check; long decimals such as response times almost never do. */
function luhn(digits) {
  if (digits.length < 15 || digits.length > 16 || !/^[3-6]/.test(digits)) return false; // Amex, Visa, Mastercard, Discover; not epoch times (13 digits, start 1)
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

const cutoff = Date.now() - DAYS * 86_400_000;
const findings = new Map();
let files = 0;
let lines = 0;
for (const dir of dirs) {
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    if (!/\.log$/.test(name)) continue;
    const file = path.join(dir, name);
    if (statSync(file).mtimeMs < cutoff) continue;
    files++;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      lines++;
      if (line.length > 20000) return;
      for (const rule of RULES) {
        rule.re.lastIndex = 0;
        const hits = (line.match(rule.re) ?? []).filter((m) => !(rule.allow?.(m)));
        if (hits.length) {
          const f = findings.get(rule.name) ?? { lines: 0, example: `${name}:${i + 1}` };
          f.lines++;
          findings.set(rule.name, f);
        }
      }
    });
  }
}
console.log(`Scanned ${lines.toLocaleString()} log lines in ${files} file(s) from the last ${DAYS} days.`);
if (findings.size === 0) { console.log('Nothing that looks like personal data or a secret.'); process.exit(0); }
for (const [name, f] of findings) console.log(`  FOUND ${name}: ${f.lines} line(s), first at ${f.example}`);
process.exit(1);
