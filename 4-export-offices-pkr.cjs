// 4-export-offices-pkr.cjs
//
// Same root problem as step 1/2's accounts, but for office: records.
// pkr-accounts-export.json (from step 1) DID pull the office:/offices-index
// keys off the OLD account, but 2-merge-accounts-pkr.cjs only ever staged
// account: entries into accounts-pkr-merge.json -- the 3 office: records
// were exported but never actually imported into the NEW account. That's
// why every imported agent now shows "No office -- can't log in": their
// officeId points at an office record that only ever existed on the OLD
// side.
//
// pkr-accounts-export.json was already deleted (correctly, per the
// cleanup step) so this re-exports just the office data, fresh.
//
// Required env vars (OLD account, same as step 1):
//   CF_API_TOKEN     — OLD account (danielwork17888@gmail.com) token,
//                       Workers KV Storage: Read is enough.
//   CF_ACCOUNT_ID    — 237ce681d0d1252c4c75cc611be62646
//   CF_NAMESPACE_ID  — c8ca68f7781a4f1b88d0997af023aec7
//                       (same namespace as before -- accounts/offices
//                       were confirmed to live alongside threads here)
//
// Usage:
//   node 4-export-offices-pkr.cjs

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
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = await res.json();
    if (!res.ok || json.success === false) {
      console.error('Cloudflare API error:', JSON.stringify(json, null, 2));
      throw new Error(`API call to ${path} failed (HTTP ${res.status})`);
    }
    return json;
  }
  const text = await res.text();
  if (!res.ok) {
    console.error('Cloudflare API error (non-JSON):', text);
    throw new Error(`API call to ${path} failed (HTTP ${res.status})`);
  }
  return text;
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

(async () => {
  const officeKeys = await listKeys('office:');
  console.log(`Found ${officeKeys.length} office: keys.`);

  let officesIndexRaw = null;
  try {
    officesIndexRaw = await cfFetch(`/values/${encodeURIComponent('offices-index')}`);
  } catch (e) {
    console.warn('No offices-index key found on the OLD side (or read failed) -- continuing without it.', e.message);
  }

  const entries = [];
  for (const k of officeKeys) {
    const val = await cfFetch(`/values/${encodeURIComponent(k.name)}`);
    entries.push({ key: k.name, value: typeof val === 'string' ? val : JSON.stringify(val) });
  }

  const output = {
    offices: entries,
    oldOfficesIndex: officesIndexRaw ? (typeof officesIndexRaw === 'string' ? JSON.parse(officesIndexRaw) : officesIndexRaw) : [],
  };

  fs.writeFileSync('pkr-offices-export.json', JSON.stringify(output, null, 2));
  console.log(`Saved ${entries.length} office record(s) to pkr-offices-export.json.`);
  console.log('Next: run 5-fix-offices-pkr.cjs (against the NEW account) to import these and update offices-index.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
