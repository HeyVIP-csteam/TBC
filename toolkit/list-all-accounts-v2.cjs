// list-all-accounts.cjs
// Read-only. Lists EVERY account: key in ACCOUNTS_KV (not just the 9 PHP
// ones) with its allowedCountries / allowedBrands / role, so we can see
// the full picture before deciding which INR accounts might need their
// allowedBrands narrowed back down.
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

(async () => {
  const keyEntries = await listKeys('account:');
  console.log(`Found ${keyEntries.length} account: keys total.\n`);
  const values = await bulkGetValues(keyEntries.map(k => k.name));

  const rows = [];
  for (const k of keyEntries) {
    const raw = values[k.name];
    if (!raw) { rows.push({ key: k.name, error: 'no value' }); continue; }
    try {
      const acc = JSON.parse(raw);
      if (!acc || typeof acc !== 'object') {
        rows.push({ key: k.name, error: `unexpected shape: ${JSON.stringify(acc).slice(0,80)}` });
        continue;
      }
      rows.push({
        key: k.name,
        username: acc.username || k.name.replace('account:',''),
        role: acc.role || '(none)',
        allowedCountries: acc.allowedCountries,
        allowedBrands: acc.allowedBrands,
      });
    } catch (e) {
      rows.push({ key: k.name, error: `parse error: ${e.message} -- raw: ${String(raw).slice(0,80)}` });
    }
  }

  // Sort: flag anything with allowedBrands === "all" first (candidates to review)
  rows.sort((a,b) => {
    const aAll = (!a.error && a.allowedBrands === 'all') ? 0 : 1;
    const bAll = (!b.error && b.allowedBrands === 'all') ? 0 : 1;
    return aAll - bAll;
  });

  console.log('=== ALL accounts (allowedBrands:"all" listed first) ===\n');
  for (const r of rows) {
    if (r.error) { console.log(`${r.key.padEnd(25)} ERROR: ${r.error}`); continue; }
    const uname = String(r.username || '(no username)').padEnd(15);
    const role = String(r.role || '(none)').padEnd(10);
    const countriesStr = String(JSON.stringify(r.allowedCountries)).padEnd(25); // JSON.stringify(undefined) returns the JS value undefined, not "undefined" -- String() wraps it so padEnd never crashes
    const brandsStr = String(JSON.stringify(r.allowedBrands));
    console.log(`${uname} role=${role} allowedCountries=${countriesStr} allowedBrands=${brandsStr}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
