// node samples/03-list-my-drafts.mjs      (needs a key with the Desk API and the "drafts" scope)
import { call, fail } from './_client.mjs';

const r = await call('GET', '/v1/setup/drafts');
if (r.status === 403 && r.json?.code === 'api_key_scope_missing') {
  console.error('This key was made without the "drafts" scope. Create a key that includes it.');
  process.exit(1);
}
if (r.status !== 200) fail(r);
const drafts = r.json.drafts ?? [];
console.log(`${drafts.length} draft(s)`);
for (const d of drafts) console.log(` - ${d.id} (updated ${d.updatedAt})`);
