// 1-export.cjs
//
// Pulls EVERY key (value + metadata) out of THREADS_KV_PHP via the
// Cloudflare API and saves them to php-kv-export.json. Read-only —
// touches nothing in the live namespace.
//
// Required env vars:
//   CF_API_TOKEN     — a token scoped to "Workers KV Storage: Read"
//                       (create at https://dash.cloudflare.com/profile/api-tokens,
//                       "Edit Cloudflare Workers" template is overkill but
//                       works too; delete the token when done, per the
//                       handoff doc's own reminder about cleaning up
//                       one-off API tokens)
//   CF_ACCOUNT_ID    — 2eb52281c1a398ea026b3c3b025b83ea (the NEW account,
//                       per handoff doc section 五)
//   CF_NAMESPACE_ID  — 9b7c59c645064b08b79b89ad8a062102 (THREADS_KV_PHP)
//
// Usage:
//   CF_API_TOKEN=xxx CF_ACCOUNT_ID=2eb52281c1a398ea026b3c3b025b83ea \
//   CF_NAMESPACE_ID=9b7c59c645064b08b79b89ad8a062102 node 1-export.cjs

const fs = require('fs');

const TOKEN = process.env.CF_API_TOKEN;
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const NAMESPACE_ID = process.env.CF_NAMESPACE_ID;

if (!TOKEN || !ACCOUNT_ID || !NAMESPACE_ID) {
  console.error('Missing CF_API_TOKEN / CF_ACCOUNT_ID / CF_NAMESPACE_ID env vars. See comments at top of this file.');
  process.exit(1);
}

const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}`;

async function cfFetch(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const json = await res.json();
  if (!res.ok || json.success === false) {
    console.error('Cloudflare API error:', JSON.stringify(json, null, 2));
    throw new Error(`API call to ${path} failed (HTTP ${res.status})`);
  }
  return json;
}

async function listAllKeys() {
  let keys = [];
  let cursor = undefined;
  for (;;) {
    const qs = new URLSearchParams({ limit: '1000' });
    if (cursor) qs.set('cursor', cursor);
    const json = await cfFetch(`/keys?${qs.toString()}`);
    keys = keys.concat(json.result);
    cursor = json.result_info && json.result_info.cursor;
    console.log(`  listed ${keys.length} keys so far...`);
    if (!cursor || json.result.length === 0) break;
  }
  return keys;
}

async function bulkGetValues(keyNames) {
  // Cloudflare's bulk/get endpoint accepts up to 100 keys per call.
  const values = {};
  for (let i = 0; i < keyNames.length; i += 100) {
    const chunk = keyNames.slice(i, i + 100);
    const json = await cfFetch(`/bulk/get`, {
      method: 'POST',
      body: JSON.stringify({ keys: chunk, type: 'text' }),
    });
    Object.assign(values, json.result.values || json.result);
    console.log(`  fetched values for ${Math.min(i + 100, keyNames.length)}/${keyNames.length} keys...`);
  }
  return values;
}

(async () => {
  console.log('Listing keys...');
  const keyEntries = await listAllKeys();
  console.log(`Total keys in THREADS_KV_PHP: ${keyEntries.length}`);

  console.log('Fetching values (bulk)...');
  const values = await bulkGetValues(keyEntries.map((k) => k.name));

  const merged = keyEntries.map((k) => ({
    key: k.name,
    value: values[k.name] ?? null,
    metadata: k.metadata || null,
  }));

  const missing = merged.filter((m) => m.value === null);
  if (missing.length) {
    console.warn(`WARNING: ${missing.length} keys had no value returned by bulk/get — check php-kv-export.json manually for these:`, missing.map((m) => m.key).slice(0, 20));
  }

  fs.writeFileSync('php-kv-export.json', JSON.stringify(merged, null, 2));
  console.log(`\nSaved ${merged.length} entries to php-kv-export.json`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
