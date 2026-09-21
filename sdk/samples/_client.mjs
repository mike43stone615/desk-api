// A tiny shared helper for the samples: one call function that sends the key, waits when told to, and reads errors.
const BASE = process.env.DESK_API_BASE || 'https://api.deskbusiness.co';
const KEY = process.env.DESK_API_KEY;
if (!KEY) { console.error('Set DESK_API_KEY to a key from the API Library page.'); process.exit(2); }

export async function call(method, path, body, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, { method, headers: { 'x-api-key': KEY, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 429 && attempt < retries) {
      const wait = Number(res.headers.get('retry-after') || 5);
      console.error(`Limited: waiting ${wait} s (Retry-After) ...`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, rateLimit: { limit: res.headers.get('x-ratelimit-limit'), remaining: res.headers.get('x-ratelimit-remaining') } };
  }
}

export function fail(result) {
  console.error(`Failed (${result.status}): ${result.json?.code ?? ''} ${result.json?.detail ?? JSON.stringify(result.json)}`);
  process.exit(1);
}
