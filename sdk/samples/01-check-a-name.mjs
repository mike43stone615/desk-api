// node samples/01-check-a-name.mjs "Acme Widgets LLC" FL
import { call, fail } from './_client.mjs';

const [name = 'Acme Widgets LLC', state = 'FL'] = process.argv.slice(2);
const r = await call('POST', '/v1/gateway/registry/name-availability', { businessName: name, stateOfFormation: state });
if (r.status !== 200) fail(r);
console.log(`${name} in ${state}: ${r.json.status} (available: ${r.json.available})`);
console.log(`Similar registered names found: ${(r.json.matches ?? []).length}`);
console.log(`Calls left this minute: ${r.rateLimit.remaining} of ${r.rateLimit.limit}`);
