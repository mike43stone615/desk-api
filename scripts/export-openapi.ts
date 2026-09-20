// Writes the two OpenAPI descriptions to files, so they can be run through linters and client generators:
//   npx tsx scripts/export-openapi.ts <folder>      -> <folder>/desk-api.json and <folder>/library.json
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LIBRARY_OPENAPI_SPEC, OPENAPI_SPEC } from '../src/openapi';

const dir = process.argv[2] ?? 'openapi-out';
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'desk-api.json'), JSON.stringify(OPENAPI_SPEC, null, 2));
writeFileSync(path.join(dir, 'library.json'), JSON.stringify(LIBRARY_OPENAPI_SPEC, null, 2));
console.log(`wrote ${dir}/desk-api.json and ${dir}/library.json`);
