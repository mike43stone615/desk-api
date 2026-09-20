// usage: npx tsx scripts/validate-env.ts <path to the .env to check>   (default: ./.env)
// Exit 0 when the settings are fit for a production deploy; 1 with a list of the problems otherwise. Prints names and
// reasons only, never values. It reads the file itself and does not touch this process's own environment.
import { readFileSync } from 'fs';
import { parse } from 'dotenv';

const file = process.argv[2] ?? '.env';
// Load the schema WITHOUT letting config.ts exit the process on a bad environment: give it a harmless one first.
process.env.DATABASE_URL ??= 'postgresql://x:x@localhost/x';

async function main() {
  const { validateProductionEnv } = await import('../src/deploy/validate-env');
  let env: Record<string, string>;
  try {
    env = parse(readFileSync(file, 'utf8'));
  } catch {
    console.error(`Cannot read ${file}`);
    process.exit(1);
  }
  const problems = validateProductionEnv(env);
  if (problems.length === 0) {
    console.log(`${file}: settings are valid for production (${Object.keys(env).length} settings checked).`);
    return;
  }
  console.error(`${file}: ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p.name}: ${p.problem}`);
  process.exit(1);
}

void main();
