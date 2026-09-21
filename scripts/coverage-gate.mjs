// Combined coverage gate: the unit run and the real-database (e2e) run each write a coverage-final.json; this merges them
// (a line counts as covered if EITHER run executed it) and fails when the merged figures fall below the floors below.
//
//   npx vitest run --coverage --coverage.reporter=json --coverage.reportsDirectory=coverage-unit
//   npx vitest run --config vitest.e2e.config.ts --coverage --coverage.reporter=json --coverage.reportsDirectory=coverage-e2e
//   node scripts/coverage-gate.mjs            (add --report to print every file under 100%)
//
// Why not 100%: a hard 100% makes people write tests that only execute lines (to satisfy the number) and pushes code into
// "coverage ignore" comments; it says nothing about whether behaviour is checked. So the gate is (1) a high overall floor and
// (2) a stricter floor for the files where a bug is a security or money problem. Raise a floor whenever the real figure moves up.
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const libCoverage = require('istanbul-lib-coverage');

const RUNS = ['coverage-unit/coverage-final.json', 'coverage-e2e/coverage-final.json'];

// Overall floors for the merged run (statements / branches / functions / lines, percent).
const GLOBAL = { statements: 86, branches: 76, functions: 85, lines: 89 };

// Files where a mistake is a security or billing problem: a stricter floor on lines and branches each.
const CRITICAL = {
  'src/middleware/auth.ts': [90, 80],
  'src/domain/gateway/keys.ts': [90, 77],
  'src/domain/gateway/crypto.ts': [90, 80],
  'src/domain/oauth/oauth.ts': [90, 75],
  'src/domain/webhooks/webhooks.ts': [90, 75],
  'src/domain/teams/teams.ts': [90, 75],
  'src/domain/billing/plans.ts': [90, 70],
  'src/domain/graphql/schema.ts': [90, 70],
};

const files = RUNS.filter((f) => existsSync(f));
if (files.length === 0) { console.error('No coverage files found. Run the unit and e2e coverage commands first.'); process.exit(2); }
const map = libCoverage.createCoverageMap({});
for (const f of files) map.merge(JSON.parse(readFileSync(f, 'utf8')));
console.log(`Merged: ${files.join(' + ')}`);

const rel = (p) => p.replace(/\\/g, '/').replace(/^.*?\/(src\/)/, '$1');
const pct = (s) => (s.total === 0 ? 100 : s.pct);
const failures = [];

const total = map.getCoverageSummary().toJSON();
for (const [k, floor] of Object.entries(GLOBAL)) {
  const v = pct(total[k]);
  console.log(`  ${k.padEnd(11)} ${String(v).padStart(6)}%   (floor ${floor}%)`);
  if (v < floor) failures.push(`overall ${k} ${v}% is below ${floor}%`);
}

const perFile = new Map(map.files().map((f) => [rel(f), map.fileCoverageFor(f).toSummary().toJSON()]));
for (const [file, [lineFloor, branchFloor]] of Object.entries(CRITICAL)) {
  const s = perFile.get(file);
  if (!s) { failures.push(`${file}: no coverage data (moved or deleted? update CRITICAL in scripts/coverage-gate.mjs)`); continue; }
  const l = pct(s.lines);
  const b = pct(s.branches);
  console.log(`  ${file.padEnd(38)} lines ${String(l).padStart(6)}% (>= ${lineFloor})  branches ${String(b).padStart(6)}% (>= ${branchFloor})`);
  if (l < lineFloor) failures.push(`${file}: lines ${l}% below ${lineFloor}%`);
  if (b < branchFloor) failures.push(`${file}: branches ${b}% below ${branchFloor}%`);
}

if (process.argv.includes('--report')) {
  console.log('\nFiles under 100% lines (lowest first):');
  [...perFile.entries()].filter(([, s]) => pct(s.lines) < 100).sort((a, b) => pct(a[1].lines) - pct(b[1].lines))
    .forEach(([f, s]) => console.log(`  ${String(pct(s.lines)).padStart(6)}% lines ${String(pct(s.branches)).padStart(6)}% branches  ${f}`));
}

if (failures.length) {
  console.error('\nCoverage gate FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nCoverage gate passed.');
