// A software bill of materials (CycloneDX) for what actually ships (production dependencies), plus a licence check:
//   npm run sbom        writes sbom.cdx.json (not committed; it is regenerated on demand) and prints a licence summary
// Fails (exit 1) if any shipped component is copyleft/restricted (GPL, AGPL, SSPL, BUSL...) or has no licence declared.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const out = 'sbom.cdx.json';
execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', '@cyclonedx/cyclonedx-npm', '--omit', 'dev', '--output-format', 'JSON', '--output-file', out], { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
const sbom = JSON.parse(readFileSync(out, 'utf8'));
const licences = {};
const problems = [];
for (const c of sbom.components) {
  const text = (c.licenses ?? []).map((l) => l.license?.id ?? l.license?.name ?? l.expression).join(' OR ');
  licences[text || 'UNKNOWN'] = (licences[text || 'UNKNOWN'] ?? 0) + 1;
  if (!text) problems.push(`${c.name}@${c.version}: no licence declared`);
  else if (/GPL|AGPL|SSPL|BUSL|Commons Clause/i.test(text)) problems.push(`${c.name}@${c.version}: ${text}`);
}
console.log(`${sbom.components.length} production components written to ${out}`);
for (const [l, n] of Object.entries(licences).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${l}`);
if (problems.length) { console.error('\nLicence problems:\n' + problems.map((p) => `  - ${p}`).join('\n')); process.exit(1); }
console.log('No copyleft or unlicensed components.');
