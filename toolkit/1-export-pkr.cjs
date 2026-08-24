// 1-export-pkr.cjs
//
// Pulls EVERY key (value + metadata) out of the OLD PKR KV namespace
// (pkr-ticket-threads, in the OLD account danielwork17888@gmail.com)
// via the Cloudflare API and saves them to pkr-kv-export.json.
// Read-only — touches nothing in the live namespace.
//
// This is the PKR sibling of 1-export.cjs (which was for PHP, and
// pointed at the NEW account). PKR is the opposite direction: we are
// reading FROM the old account, because that's where the real PKR
// data still lives.
//
// Required env vars:
//   CF_API_TOKEN     — a token created IN THE OLD ACCOUNT
//                       (danielwork17888@gmail.com), scoped to
//                       "Workers KV Storage: Read" only.
//                       Create at https://dash.cloudflare.com/profile/api-tokens
//                       while logged into the OLD account.
//                       Delete the token when done (see toolkit/README.md
//                       cleanup reminder — same policy applies here).
//   CF_ACCOUNT_ID    — 237ce681d0d1252c4c75cc611be62646
//                       (the OLD account's account id, per
//                       SESSION-SUMMARY-2026-08-23-v4)
//   CF_NAMESPACE_ID  — c8ca68f7781a4f1b88d0997af023aec7
//                       (pkr-ticket-threads, in the OLD account)
//
// Usage:
//   CF_API_TOKEN=xxx \
//   CF_ACCOUNT_ID=237ce681d0d1252c4c75cc611be62646 \
//   CF_NAMESPACE_ID=c8ca68f7781a4f1b88d0997af023aec7 \
//   node 1-export-pkr.cjs

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
  console.log('Listing keys in OLD-account PKR namespace (pkr-ticket-threads)...');
  const keyEntries = await listAllKeys();
  console.log(`Total keys in pkr-ticket-threads: ${keyEntries.length}`);

  console.log('Fetching values (bulk)...');
  const values = await bulkGetValues(keyEntries.map((k) => k.name));

  const merged = keyEntries.map((k) => ({
    key: k.name,
    value: values[k.name] ?? null,
    metadata: k.metadata || null,
  }));

  const missing = merged.filter((m) => m.value === null);
  if (missing.length) {
    console.warn(`WARNING: ${missing.length} keys had no value returned by bulk/get — check pkr-kv-export.json manually for these:`, missing.map((m) => m.key).slice(0, 20));
  }

  // This file is already in the exact shape `wrangler kv bulk put` expects
  // ([{key, value, metadata}, ...]), so unless a mojibake-style problem
  // turns up on inspection, it can be imported as-is with 2-import-pkr.cjs
  // (which just double-checks + summarizes before you run the real
  // `wrangler kv bulk put`).
  fs.writeFileSync('pkr-kv-export.json', JSON.stringify(merged, null, 2));
  console.log(`\nSaved ${merged.length} entries to pkr-kv-export.json`);
  console.log('This file contains real customer/business data from the OLD account — do not commit it or leave it lying around once the migration is verified.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
