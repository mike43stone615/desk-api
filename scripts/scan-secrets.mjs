// Looks for secrets that must never be in a repository: in the files as they are now, and in every commit ever made.
//   node scripts/scan-secrets.mjs [path-to-repo ...]        (default: the current folder)
//   node scripts/scan-secrets.mjs --no-history [repo]       (files only)
// Prints where each finding is (file and line, or commit) and WHAT KIND of secret it looks like, never the secret itself.
// Exit code 1 when anything is found. Findings that are known to be harmless (test fixtures) are listed in ALLOW below.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const noHistory = args.includes('--no-history');
const repos = args.filter((a) => !a.startsWith('--'));
if (repos.length === 0) repos.push(process.cwd());

/** Kind of secret -> pattern. Deliberately narrow, so a finding is worth looking at. */
const PATTERNS = {
  'private key': /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  'AWS access key id': /\bAKIA[0-9A-Z]{16}\b/,
  'GitHub token': /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  'Slack token': /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  'Resend / Stripe style secret key': /\b(?:re|sk|rk)_(?:live_)?[A-Za-z0-9]{24,}\b/,
  'OpenAI style key': /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
  'Google API key': /\bAIza[0-9A-Za-z_-]{35}\b/,
  'Cloudflare API token (after a variable that names one)': /CLOUDFLARE_API_(?:TOKEN|KEY)\s*[=:]\s*["']?[A-Za-z0-9_-]{30,}/,
  'API Library key': /\bdeskgw_[a-f0-9]{48}\b/,
  'password inside a database address': /\b(?:postgres(?:ql)?|mysql|redis|mongodb):\/\/[^:\s/@]+:(?!password@|pass@|secret@|postgres@|\*+|xxx|changeme|desk_api_dev|desk_api_test)[^@\s"']{6,}@/i,
  'secret assigned in code or settings': /\b(?:[A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|API_KEY|ADMIN_KEY|TOKEN|ENCRYPTION_KEY)|password|secret)\s*[=:]\s*["']?(?![A-Za-z_]*\(|process\.env|env\.|config\.|["']?\$\{|<|your|xxx|changeme|placeholder|example|test|dummy|fake|stand-in|\*|$)[A-Za-z0-9+/_-]{24,}["']?/i,
};

/** Paths (regex) and finding kinds that are known harmless: fixtures that are deliberately fake. */
const ALLOW_PATHS = [/(^|\/)__tests__\//, /\.test\.(ts|js|mjs)$/, /(^|\/)test\//, /\.env\.example$/, /package-lock\.json$/, /\.md$/, /openapi-examples\.ts$/, /^docs\/.*\.(csv|json)$/, /scan-secrets\.mjs$/];

/** A token of only a few distinct characters (0000..., abab...) is a placeholder, not a secret. */
function lowEntropy(line) {
  const tokens = line.replace(/^[^=:]*[=:]/, '').match(/[A-Za-z0-9+/_-]{24,}/g) ?? []; // what comes after the name
  return tokens.length > 0 && tokens.every((t) => new Set(t).size < 6);
}

function git(repo, ...a) {
  return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 });
}

/** Findings looked at and judged harmless (say why). "repo|finding". */
const KNOWN_HARMLESS = new Set([
  // Sept 2026: the retired local Docker stack's own throwaway database password; not the password of any live database.
  'desk-api|history: commit 57b691e in compose.yaml  password inside a database address',
  'desk-api|history: commit 57b691e in scripts/server-compose.yml  password inside a database address',
]);

let total = 0;
for (const repo of repos) {
  if (!existsSync(path.join(repo, '.git'))) { console.error(`${repo}: not a git repository`); continue; }
  const name = path.basename(path.resolve(repo));
  const found = [];
  const check = (where, file, text) => {
    if (ALLOW_PATHS.some((re) => re.test(file))) return;
    text.split('\n').forEach((line, i) => {
      if (line.length > 2000) return; // minified or data lines: not readable secrets
      for (const [kind, re] of Object.entries(PATTERNS)) if (re.test(line) && !lowEntropy(line)) found.push(`${where}${file}:${i + 1}  ${kind}`);
    });
  };

  // 1. the files as they are now
  for (const file of git(repo, 'ls-files').split('\n').filter(Boolean)) {
    if (/\.(png|jpg|jpeg|gif|woff2?|ico|pdf|zip|gz|parquet|sqlite|xlsx)$/i.test(file)) continue;
    try { check('files: ', file, readFileSync(path.join(repo, file), 'utf8')); } catch { /* unreadable or deleted */ }
  }

  // 2. every line ever added in any commit
  if (!noHistory) {
    const log = git(repo, 'log', '--all', '-p', '--no-color', '--diff-filter=AM', '--format=@@commit %h', '-U0');
    let commit = '?';
    let file = '?';
    for (const line of log.split('\n')) {
      if (line.startsWith('@@commit ')) { commit = line.slice(9); continue; }
      if (line.startsWith('+++ b/')) { file = line.slice(6); continue; }
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      if (ALLOW_PATHS.some((re) => re.test(file)) || line.length > 2000) continue;
      for (const [kind, re] of Object.entries(PATTERNS)) if (re.test(line.slice(1)) && !lowEntropy(line)) found.push(`history: commit ${commit} in ${file}  ${kind}`);
    }
  }
  const unique = [...new Set(found)].filter((f) => !KNOWN_HARMLESS.has(`${name}|${f}`));
  total += unique.length;
  console.log(`${name}: ${unique.length === 0 ? 'clean' : `${unique.length} finding(s)`}${noHistory ? ' (files only)' : ' (files and every commit)'}`);
  for (const f of unique.slice(0, 40)) console.log(`  - ${f}`);
}
process.exit(total ? 1 : 0);
