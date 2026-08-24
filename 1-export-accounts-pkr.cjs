// 1-export-accounts-pkr.cjs
//
// This is the missing step from the PKR migration: README-PKR.md only
// ever moved pkr-ticket-threads (thread data) + the R2 screenshots. It
// never touched the OLD PKR account's login accounts (account:/office:
// keys) at all -- that's a completely separate KV namespace from
// pkr-ticket-threads, and nothing in the toolkit so far has read it.
// This script is step 1 of fixing that: export-only, touches nothing.
//
// IMPORTANT -- you need to find the right namespace ID first:
//   The OLD PKR account (danielwork17888@gmail.com) may or may not have
//   had its own dedicated "accounts" KV namespace. Two possibilities:
//     a) It has its own separate namespace (check the OLD project's own
//        wrangler.toml, or the OLD account's Workers KV dashboard, for
//        a binding that isn't THREADS_KV_PKR / pkr-ticket-threads --
//        likely named something like ACCOUNTS_KV or pkr-accounts).
//     b) It never had one and borrowed pkr-ticket-threads for accounts
//        too (same "temporary borrow" pattern documented in this
//        project's own wrangler.toml for INR). If so, point
//        CF_NAMESPACE_ID at c8ca68f7781a4f1b88d0997af023aec7 (same as
//        1-export-pkr.cjs used) -- this script only pulls account:/
//        office:/offices-index/accounts-index keys, so it's safe to
//        point at the same namespace even if threads live there too.
//   Don't guess -- open the OLD account's dashboard and check.
//
// Required env vars:
//   CF_API_TOKEN     — a token created IN THE OLD ACCOUNT
//                       (danielwork17888@gmail.com), scoped to
//                       "Workers KV Storage: Read" only. Delete it when
//                       done, same as every other read-only token in
//                       this toolkit.
//   CF_ACCOUNT_ID    — 237ce681d0d1252c4c75cc611be62646
//                       (the OLD account's account id)
//   CF_NAMESPACE_ID  — whichever namespace holds the OLD PKR account
//                       records (see above -- NOT necessarily the same
//                       as pkr-ticket-threads's id, verify first)
//
// Usage:
//   CF_API_TOKEN=xxx \
//   CF_ACCOUNT_ID=237ce681d0d1252c4c75cc611be62646 \
//   CF_NAMESPACE_ID=<verified namespace id> \
//   node 1-export-accounts-pkr.cjs

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
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const json = await res.json();
  if (!res.ok || json.success === false) {
    console.error('Cloudflare API error:', JSON.stringify(json, null, 2));
    throw new Error(`API call to ${path} failed (HTTP ${res.status})`);
  }
  return json;
}

async function listKeys(prefix) {
  let keys = [];
  let cursor;
  for (;;) {
    const qs = new URLSearchParams({ limit: '1000', prefix });
    if (cursor) qs.set('cursor', cursor);
    const json = await cfFetch(`/keys?${qs.toString()}`);
    keys = keys.concat(json.result);
    cursor = json.result_info && json.result_info.cursor;
    if (!cursor || json.result.length === 0) break;
  }
  return keys;
}

async function bulkGetValues(keyNames) {
  const values = {};
  for (let i = 0; i < keyNames.length; i += 100) {
    const chunk = keyNames.slice(i, i + 100);
    const json = await cfFetch(`/bulk/get`, { method: 'POST', body: JSON.stringify({ keys: chunk, type: 'text' }) });
    Object.assign(values, json.result.values || json.result);
  }
  return values;
}

// Only account/office data -- deliberately narrower than
// 1-export-pkr.cjs's "every key" approach, since if this namespace turns
// out to be the same shared one as pkr-ticket-threads (possibility "b"
// above), we do NOT want to re-export thread/mention/deposit data here.
const PREFIXES = ['account:', 'office:', 'offices-index', 'accounts-index'];

(async () => {
  let allKeys = [];
  for (const prefix of PREFIXES) {
    console.log(`Listing keys with prefix "${prefix}"...`);
    const keys = await listKeys(prefix);
    console.log(`  found ${keys.length}`);
    allKeys = allKeys.concat(keys);
  }
  console.log(`Total keys to export: ${allKeys.length}`);

  const values = await bulkGetValues(allKeys.map((k) => k.name));
  const merged = allKeys.map((k) => ({
    key: k.name,
    value: values[k.name] ?? null,
    metadata: k.metadata || null,
  }));

  const missing = merged.filter((m) => m.value === null);
  if (missing.length) {
    console.warn(`WARNING: ${missing.length} keys had no value:`, missing.map((m) => m.key));
  }

  fs.writeFileSync('pkr-accounts-export.json', JSON.stringify(merged, null, 2));
  console.log(`\nSaved ${merged.length} entries to pkr-accounts-export.json`);
  console.log('This contains real login credentials (password hashes) from the OLD account -- do not commit it, and delete it once the migration is verified.');
  console.log('Next: run 2-merge-accounts-pkr.cjs to compare against the NEW account\'s ACCOUNTS_KV and produce a review-first merge plan.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
