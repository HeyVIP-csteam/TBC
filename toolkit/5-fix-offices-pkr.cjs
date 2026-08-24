// 5-fix-offices-pkr.cjs
//
// Reads pkr-offices-export.json (from 4-export-offices-pkr.cjs) and, for
// each office: record not already present in the NEW account's
// ACCOUNTS_KV (matched by office id), writes it across as-is and adds
// its id to the NEW side's "offices-index". Office records don't
// contain credentials (just a name + allowed IP list) so unlike the
// account merge, this writes directly rather than staging a
// review-first file -- collision risk is also much lower, since office
// ids are randomly generated (off_<timestamp>_<random>).
//
// Required env vars (NEW account):
//   CF_API_TOKEN     — needs Workers KV Storage: Edit.
//   CF_ACCOUNT_ID    — the NEW account's account id
//   CF_NAMESPACE_ID  — 4821238464004b8289e4ded5a467d582 (ACCOUNTS_KV)
//
// Usage:
//   node 5-fix-offices-pkr.cjs

const fs = require('fs');

const TOKEN = process.env.CF_API_TOKEN;
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const NAMESPACE_ID = process.env.CF_NAMESPACE_ID;

if (!TOKEN || !ACCOUNT_ID || !NAMESPACE_ID) {
  console.error('Missing CF_API_TOKEN / CF_ACCOUNT_ID / CF_NAMESPACE_ID env vars.');
  process.exit(1);
}

const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}`;
const OFFICES_INDEX_KEY = 'offices-index';

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

async function getValueOrNull(key) {
  try {
    return await cfFetch(`/values/${encodeURIComponent(key)}`);
  } catch (e) {
    return null;
  }
}

(async () => {
  if (!fs.existsSync('pkr-offices-export.json')) {
    console.error('pkr-offices-export.json not found -- run 4-export-offices-pkr.cjs first.');
    process.exit(1);
  }
  const { offices } = JSON.parse(fs.readFileSync('pkr-offices-export.json', 'utf8'));
  console.log(`Loaded ${offices.length} office record(s) from pkr-offices-export.json.`);

  console.log(`Reading current "${OFFICES_INDEX_KEY}" from NEW ACCOUNTS_KV...`);
  const rawIndex = await getValueOrNull(OFFICES_INDEX_KEY);
  let ids = [];
  if (rawIndex) {
    try {
      ids = typeof rawIndex === 'string' ? JSON.parse(rawIndex) : rawIndex;
      if (!Array.isArray(ids)) throw new Error('not an array');
    } catch (e) {
      console.error(`Could not parse existing "${OFFICES_INDEX_KEY}" -- aborting without writing anything.`, e.message);
      process.exit(1);
    }
  }
  console.log(`Current offices-index has ${ids.length} id(s).`);

  let written = 0;
  const newIds = [];
  for (const entry of offices) {
    const id = entry.key.replace(/^office:/, '');
    const existing = await getValueOrNull(entry.key);
    if (existing) {
      console.log(`  ${id}: already exists in NEW ACCOUNTS_KV -- skipped (not overwritten).`);
      continue;
    }
    await cfFetch(`/values/${encodeURIComponent(entry.key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: entry.value,
    });
    written++;
    if (!ids.includes(id)) newIds.push(id);
    console.log(`  ${id}: imported.`);
  }

  if (newIds.length) {
    const updated = [...newIds, ...ids];
    await cfFetch(`/values/${encodeURIComponent(OFFICES_INDEX_KEY)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(updated),
    });
    console.log(`"${OFFICES_INDEX_KEY}" updated: ${ids.length} -> ${updated.length} id(s).`);
  } else {
    console.log(`"${OFFICES_INDEX_KEY}" unchanged (nothing new to add).`);
  }

  console.log(`\nDone. ${written} office record(s) imported.`);
  console.log('Refresh the Agent Profile table -- the "No office -- can\'t log in" warning should be gone for PKR accounts now.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
