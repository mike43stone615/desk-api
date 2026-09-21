// A small mutation test: breaks the code on purpose, one tiny change at a time (">" becomes ">=", "&&" becomes "||", a
// "return true" becomes "return false", ...), and runs the tests that are supposed to cover that file. A change that no
// test notices is a "survivor": a place where the code could be wrong and nothing would say so. (A full mutation tool ran
// the whole 600-test suite for every change and would need days; this uses only the tests named for each file.)
//   node scripts/mutation-lite.mjs [max-mutants-per-file=12]
// The file is always put back, even if this is interrupted (and `git diff` shows nothing left over on a clean run).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const MAX = Number(process.argv[2]) || 12;
const TARGETS = [
  { file: 'src/middleware/signup-limiter.ts', tests: ['src/__tests__/round3Units.test.ts'] },
  { file: 'src/middleware/route-limits.ts', tests: ['src/__tests__/routes/routeLimits.test.ts', 'src/__tests__/routes/inviteEnumeration.test.ts'] },
  { file: 'src/domain/email/outbox.ts', tests: ['src/__tests__/round3Units.test.ts'] },
  { file: 'src/domain/email/key-check.ts', tests: ['src/__tests__/round3Units.test.ts'] },
  { file: 'src/utils/strings.ts', tests: ['src/__tests__/round3Units.test.ts', 'src/__tests__/regexSafety.test.ts'] },
];
const OPERATORS = [
  [/ >= /, ' > '], [/ > /, ' >= '], [/ <= /, ' < '], [/ < /, ' <= '], [/ === /, ' !== '], [/ !== /, ' === '],
  [/ && /, ' || '], [/ \|\| /, ' && '], [/return true;/, 'return false;'], [/return false;/, 'return true;'], [/ \+ 1\b/, ' - 1'], [/\b0 \/\/ ok\b/, '1'],
];

function mutantsOf(source) {
  const lines = source.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('import ') || /^\s*(const|let)\s+\w+\s*=\s*['"`]/.test(line)) return;
    for (const [re, replacement] of OPERATORS) {
      if (re.test(line)) out.push({ line: i + 1, original: t, changed: line.replace(re, replacement).trim(), source: [...lines.slice(0, i), line.replace(re, replacement), ...lines.slice(i + 1)].join('\n') });
    }
  });
  return out;
}

// A fixed pseudo-random order, so two runs try the same mutants.
function shuffle(list) { let s = 42; const a = [...list]; for (let i = a.length - 1; i > 0; i--) { s = (s * 1664525 + 1013904223) % 4294967296; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

let killed = 0, survived = 0;
const survivors = [];
for (const { file, tests } of TARGETS) {
  const original = readFileSync(file, 'utf8');
  const picked = shuffle(mutantsOf(original)).slice(0, MAX);
  try {
    for (const m of picked) {
      writeFileSync(file, m.source);
      let passed = true;
      try { execFileSync('npx', ['vitest', 'run', ...tests, '--reporter=dot'], { stdio: 'pipe', timeout: 120000, shell: true }); }
      catch { passed = false; }
      if (passed) { survived++; survivors.push(`${file}:${m.line}   ${m.original}   ->   ${m.changed}`); } else killed++;
    }
  } finally { writeFileSync(file, original); }
  console.log(`${file}: ${picked.length} changes tried`);
}
console.log(`\n${killed + survived} deliberate breakages: ${killed} noticed by the tests, ${survived} not noticed (${Math.round((100 * killed) / (killed + survived || 1))}% caught).`);
for (const s of survivors) console.log('  NOT NOTICED  ' + s);
process.exit(survived ? 1 : 0);
