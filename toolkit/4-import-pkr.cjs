// 4-import-pkr.cjs
//
// Bypasses `wrangler kv bulk put` (which threw a confusing "Metadata
// length of 1044 exceeds limit of 1024" error that our diagnostics
// couldn't reproduce) and instead writes directly to the Cloudflare
// API's bulk/write endpoint, the same way 1-export-pkr.cjs read from
// it. This gives us:
//   - Control over batch size
//   - Automatic bisection on failure: if a batch of N keys fails, it
//     splits into two batches of N/2 and retries each, recursively,
//     until it isolates the exact key(s) causing the problem
//   - Keys that succeed get written normally; keys that fail are
//     skipped (NOT written) and logged to pkr-failed-keys.json with
//     the actual Cloudflare API error message, so nothing is silently
//     lost or silently corrupted — you get a precise list to look at
//     afterward.
//
// Required env vars (NEW account — this WRITES data):
//   CF_API_TOKEN     — token with Workers KV Storage: Edit, scoped to
//                       the NEW account (danielc17888@gmail.com)
//   CF_ACCOUNT_ID    — 2eb52281c1a398ea026b3c3b025b83ea
//   CF_NAMESPACE_ID  — 918893780bc444c2b6b49cfd4039ab3b (THREADS_KV_PKR)
//
// Usage:
//   $env:CF_API_TOKEN="..."
//   $env:CF_ACCOUNT_ID="2eb52281c1a398ea026b3c3b025b83ea"
//   $env:CF_NAMESPACE_ID="918893780bc444c2b6b49cfd4039ab3b"
//   node 4-import-pkr.cjs

const fs = require('fs');

const TOKEN = process.env.CF_API_TOKEN;
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const NAMESPACE_ID = process.env.CF_NAMESPACE_ID;

if (!TOKEN || !ACCOUNT_ID || !NAMESPACE_ID) {
  console.error('Missing CF_API_TOKEN / CF_ACCOUNT_ID / CF_NAMESPACE_ID env vars. See comments at top of this file.');
  process.exit(1);
}

if (!fs.existsSync('pkr-kv-export.json')) {
  console.error('pkr-kv-export.json not found in current directory.');
  process.exit(1);
}

const entries = JSON.parse(fs.readFileSync('pkr-kv-export.json', 'utf8'));
console.log(`Loaded ${entries.length} entries from pkr-kv-export.json`);

const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}`;
const INITIAL_BATCH_SIZE = 500; // Cloudflare's bulk/write max is 10,000 keys or 100MB per request; start smaller to fail fast and cheap.

async function bulkWrite(batch) {
  const res = await fetch(`${BASE}/bulk`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(batch),
  });
  const json = await res.json();
  return { ok: res.ok && json.success !== false, status: res.status, json };
}

let succeeded = 0;
const failed = []; // { key, error }

// Recursively try a batch; on failure, bisect until isolating bad keys.
async function tryBatch(batch) {
  if (batch.length === 0) return;

  const { ok, json } = await bulkWrite(batch);

  if (ok) {
    succeeded += batch.length;
    process.stdout.write(`\r  uploaded ${succeeded}/${entries.length} (${failed.length} failed so far)...`);
    return;
  }

  if (batch.length === 1) {
    // Isolated the exact offending key.
    const errMsg = (json.errors && json.errors.length) ? json.errors.map(e => e.message).join('; ') : JSON.stringify(json);
    failed.push({ key: batch[0].key, error: errMsg });
    process.stdout.write(`\r  uploaded ${succeeded}/${entries.length} (${failed.length} failed so far)...`);
    return;
  }

  // Split in half and retry each half.
  const mid = Math.floor(batch.length / 2);
  await tryBatch(batch.slice(0, mid));
  await tryBatch(batch.slice(mid));
}

(async () => {
  console.log(`Uploading in batches of up to ${INITIAL_BATCH_SIZE}, auto-bisecting any batch that fails...\n`);

  for (let i = 0; i < entries.length; i += INITIAL_BATCH_SIZE) {
    const chunk = entries.slice(i, i + INITIAL_BATCH_SIZE);
    await tryBatch(chunk);
  }

  console.log(`\n\nDone. Succeeded: ${succeeded}/${entries.length}. Failed: ${failed.length}.`);

  if (failed.length > 0) {
    fs.writeFileSync('pkr-failed-keys.json', JSON.stringify(failed, null, 2));
    console.log(`\nFailed keys (NOT written to the new namespace) saved to pkr-failed-keys.json:`);
    for (const f of failed.slice(0, 20)) {
      console.log(`  ${f.key} — ${f.error}`);
    }
    if (failed.length > 20) console.log(`  ...and ${failed.length - 20} more, see pkr-failed-keys.json`);
    console.log(`\nEverything else (${succeeded} keys) was written successfully. Send me pkr-failed-keys.json`);
    console.log('and we\'ll figure out a fix for just these remaining keys.');
  } else {
    console.log('\nAll keys imported successfully — nothing left to fix.');
  }
})().catch((e) => {
  console.error('\nUnexpected error:', e);
  process.exit(1);
});
