// 5-verify-thread-count-old.cjs
//
// The old system's UI showed "Active 8 / Solved 1306 / Recall 14" but
// our raw export only found 477 `thread:` keys total. Before assuming
// data was lost, this script re-checks the OLD account's KV namespace
// RIGHT NOW, querying Cloudflare's API directly with a `thread:` prefix
// filter — bypassing the app's own 10-minute cache layer entirely
// (see LIST_CACHE_KEY / thread-list-cache in threads.js). This tells us
// the actual current ground truth, independent of any stale cache the
// old UI might be reading from.
//
// Read-only, touches nothing.
//
// Required env vars (OLD account):
//   CF_API_TOKEN     — Workers KV Storage: Read, scoped to OLD account
//                       (danielwork17888@gmail.com) — you'll need a
//                       fresh one since the earlier one was deleted
//   CF_ACCOUNT_ID    — 237ce681d0d1252c4c75cc611be62646
//   CF_NAMESPACE_ID  — c8ca68f7781a4f1b88d0997af023aec7
//
// Usage:
//   $env:CF_API_TOKEN="..."
//   $env:CF_ACCOUNT_ID="237ce681d0d1252c4c75cc611be62646"
//   $env:CF_NAMESPACE_ID="c8ca68f7781a4f1b88d0997af023aec7"
//   node 5-verify-thread-count-old.cjs

const TOKEN = process.env.CF_API_TOKEN;
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const NAMESPACE_ID = process.env.CF_NAMESPACE_ID;

if (!TOKEN || !ACCOUNT_ID || !NAMESPACE_ID) {
  console.error('Missing CF_API_TOKEN / CF_ACCOUNT_ID / CF_NAMESPACE_ID env vars. See comments at top of this file.');
  process.exit(1);
}

const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}`;

async function cfFetch(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const json = await res.json();
  if (!res.ok || json.success === false) {
    console.error('Cloudflare API error:', JSON.stringify(json, null, 2));
    throw new Error(`API call to ${path} failed (HTTP ${res.status})`);
  }
  return json;
}

(async () => {
  console.log('Querying CURRENT thread: prefix key count directly from Cloudflare API (old account, pkr-ticket-threads)...\n');

  let keys = [];
  let cursor;
  for (;;) {
    const qs = new URLSearchParams({ limit: '1000', prefix: 'thread:' });
    if (cursor) qs.set('cursor', cursor);
    const json = await cfFetch(`/keys?${qs.toString()}`);
    keys = keys.concat(json.result);
    cursor = json.result_info && json.result_info.cursor;
    console.log(`  found ${keys.length} thread: keys so far...`);
    if (!cursor || json.result.length === 0) break;
  }

  console.log(`\nTOTAL thread: keys existing RIGHT NOW in the old account's pkr-ticket-threads namespace: ${keys.length}`);
  console.log('\nThis is a live, direct query — not affected by any app-level cache.');
  console.log('If this number is close to 477, it confirms the KV genuinely only has ~477');
  console.log('thread records right now, and the "1306 solved" the old UI showed is a stale');
  console.log('cached number, not current reality — meaning our migration captured everything');
  console.log('that actually exists.');
  console.log('\nIf this number is much higher (closer to 1300+), something else is going on');
  console.log('and we need to look further — share this output either way.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
