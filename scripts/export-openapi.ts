// Writes docs/openapi.json from the TypeScript spec source.
// Run via: npm run generate:openapi
import { writeFileSync, mkdirSync } from 'fs';
import { OPENAPI_SPEC } from '../src/openapi';

mkdirSync('docs', { recursive: true });
writeFileSync('docs/openapi.json', JSON.stringify(OPENAPI_SPEC, null, 2));
console.log('Wrote docs/openapi.json');
