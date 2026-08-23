// check-accounts.cjs
// Read-only: lists ACCOUNTS_KV's account: keys and prints each named
// account's current allowedCountries / allowedBrands, so we can decide
// whether the PHP-country fix is still needed before touching anything.
//
// Required env vars: CF_API_TOKEN, CF_ACCOUNT_ID, CF_NAMESPACE_ID
const TOKEN = process.env.CF_API_TOKEN;
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const NAMESPACE_ID = process.env.CF_NAMESPACE_ID;

if (!TOKEN || !ACCOUNT_ID || !NAMESPACE_ID) {
  console.error('Missing CF_API_TOKEN / CF_ACCOUNT_ID / CF_NAMESPACE_ID env vars.');
  process.exit(1);
}

const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}`;

async function cfFetch(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers||{}) },
  });
  const json = await res.json();
  if (!res.ok || json.success === false) {
    console.error('Cloudflare API error:', JSON.stringify(json, null, 2));
    throw new Error(`API call to ${path} failed (HTTP ${res.status})`);
  }
  return json;
}

async function listKeys(prefix) {
  let keys = []; let cursor;
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

const TARGET_USERNAMES = ['kai','jade','jaycee','edelyn','bea','loui','ash','sharra','virgielyn','daniel01'];

(async () => {
  console.log('Listing account: keys...');
  const keyEntries = await listKeys('account:');
  console.log(`Found ${keyEntries.length} account: keys total.`);
  const values = await bulkGetValues(keyEntries.map(k => k.name));

  console.log('\n=== Target accounts (PHP fix candidates + daniel01) ===\n');
  for (const uname of TARGET_USERNAMES) {
    // account key naming might be account:<username> or account:<id> with username field inside -- check both ways
    let found = null;
    let foundKey = null;
    for (const k of keyEntries) {
      if (k.name.toLowerCase() === `account:${uname}`.toLowerCase()) {
        found = values[k.name];
        foundKey = k.name;
        break;
      }
    }
    if (!found) {
      // fallback: scan all values for a username field match
      for (const k of keyEntries) {
        const v = values[k.name];
        if (!v) continue;
        try {
          const parsed = JSON.parse(v);
          if (parsed.username && parsed.username.toLowerCase() === uname.toLowerCase()) {
            found = v; foundKey = k.name; break;
          }
        } catch(e) {}
      }
    }
    if (!found) {
      console.log(`[NOT FOUND] ${uname} -- no matching key/username located`);
      continue;
    }
    try {
      const acc = JSON.parse(found);
      console.log(`${uname.padEnd(12)} key=${foundKey}`);
      console.log(`             role=${acc.role}  allowedCountries=${JSON.stringify(acc.allowedCountries)}  allowedBrands=${JSON.stringify(acc.allowedBrands)}`);
    } catch(e) {
      console.log(`[PARSE ERROR] ${uname}: ${e.message}`);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
