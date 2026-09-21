// The changelog is served by the API (GET /v1/changelog), so the build puts a copy next to the compiled code.
import { copyFileSync, existsSync } from 'node:fs';
if (existsSync('CHANGELOG.md') && existsSync('dist')) copyFileSync('CHANGELOG.md', 'dist/CHANGELOG.md');
