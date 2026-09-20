// Finds regular expressions that can hang on crafted input ("catastrophic backtracking"): every regex literal in the
// given source folders is run against long adversarial strings, each run inside a sandbox with a hard time limit.
//   node scripts/check-regex.mjs [folder ...]        (default: src scripts)
// A regex that takes more than SLOW_MS on any of the inputs is reported with its file and line. Exit code 1 if any.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const ts = require('typescript');
const SLOW_MS = 100;
const roots = process.argv.slice(2).length ? process.argv.slice(2) : ['src', 'scripts'];

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    if (n === 'node_modules' || n === 'dist' || n === '__tests__' || n.startsWith('.')) return [];
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|mts|js|mjs)$/.test(n) && !/\.d\.ts$/.test(n) && !/\.(test|spec)\./.test(n) ? [p] : [];
  });
}

/** Strings chosen to make nested or overlapping quantifiers backtrack: long runs of one character followed by a mismatch. */
const N = 30000;
const INPUTS = [
  'a'.repeat(N) + '!', ' '.repeat(N) + 'x', '0'.repeat(N) + 'x', '-'.repeat(N) + '\n', '<'.repeat(N), 'a@'.repeat(N / 2) + '!',
  '.'.repeat(N) + '!', 'a.'.repeat(N / 2) + '!', 'a b '.repeat(N / 4) + '!', '\\'.repeat(N) + '"', '"'.repeat(N), 'aA1!'.repeat(N / 4) + '\n', '/'.repeat(N) + 'a', '&'.repeat(N),
  'https://' + 'a'.repeat(N) + '.', 'x@' + 'a.'.repeat(N / 2), '\t\n '.repeat(N / 3) + 'x',
];

const found = [];
let count = 0;
for (const root of roots) {
  for (const file of files(root)) {
    const source = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
        count++;
        const literal = node.getText(sf);
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        let worst = 0;
        let hung = false;
        for (const input of INPUTS) {
          const script = new vm.Script(`(${literal}).test(input)`);
          let best = Infinity; // fastest of two runs: a one-off pause (JIT, garbage collection) is not a slow pattern
          for (let run = 0; run < 2 && !hung; run++) {
            const t0 = performance.now();
            try { script.runInNewContext({ input }, { timeout: 500 }); } catch { hung = true; }
            best = Math.min(best, performance.now() - t0);
          }
          worst = Math.max(worst, best);
          if (hung) break;
        }
        if (hung || worst > SLOW_MS) found.push(`${file}:${line}  ${hung ? 'HUNG (over 500 ms)' : `${worst.toFixed(0)} ms`}  ${literal.slice(0, 90)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}
console.log(`${count} regular expressions checked against ${INPUTS.length} adversarial inputs of ${N} characters each.`);
if (found.length) { console.log(found.map((f) => `  SLOW ${f}`).join('\n')); process.exit(1); }
console.log('None takes more than ' + SLOW_MS + ' ms: no sign of catastrophic backtracking.');
