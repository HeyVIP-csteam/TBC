// fix-accounts-country.cjs
//
// Read-only preparation step (does NOT write to Cloudflare). Fetches the
// 9 named accounts' CURRENT full records via bulk/get, and -- ONLY for
// accounts where allowedCountries is still missing/undefined (a safety
// re-check, in case something changed between check-accounts.cjs and
// now) -- produces accounts-country-fix.json: a wrangler-bulk-put-ready
// file that sets allowedCountries: ["PHP"] on that record while copying
// every other field through byte-identical (role, allowedBrands,
// password hash, everything).
//
// daniel01 and every other account in ACCOUNTS_KV is never read or
// touched -- only these 9 exact keys are fetched.
//
// Required env vars: CF_API_TOKEN, CF_ACCOUNT_ID, CF_NAMESPACE_ID
const fs = require('fs');
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

async function bulkGetValues(keyNames) {
  const json = await cfFetch(`/bulk/get`, { method: 'POST', body: JSON.stringify({ keys: keyNames, type: 'text' }) });
  return json.result.values || json.result;
}

// EXACTLY these 9 -- deliberately excludes daniel01 (already correctly
// set to ["INR","PKR","PHP"], confirmed via check-accounts.cjs) and
// every INR/PKR-only account. This list is intentionally hardcoded, not
// derived from a scan, so there is no way a stray account gets swept in.
const TARGET_USERNAMES = ['kai','jade','jaycee','edelyn','bea','loui','ash','sharra','virgielyn'];

(async () => {
  const keys = TARGET_USERNAMES.map(u => `account:${u}`);
  console.log('Fetching current records for:', keys.join(', '));
  const values = await bulkGetValues(keys);

  const output = [];
  const report = [];

  for (const uname of TARGET_USERNAMES) {
    const key = `account:${uname}`;
    const raw = values[key];
    if (!raw) {
      report.push({ username: uname, key, status: 'NOT FOUND -- skipped, no output produced' });
      continue;
    }
    let acc;
    try {
      acc = JSON.parse(raw);
    } catch (e) {
      report.push({ username: uname, key, status: `PARSE ERROR -- skipped: ${e.message}` });
      continue;
    }
    if (acc.allowedCountries !== undefined) {
      report.push({ username: uname, key, status: `SKIPPED -- allowedCountries already set to ${JSON.stringify(acc.allowedCountries)}, not touching` });
      continue;
    }
    const fixed = { ...acc, allowedCountries: ['PHP'] };
    output.push({ key, value: JSON.stringify(fixed) });
    report.push({ username: uname, key, status: 'WILL SET allowedCountries=["PHP"] -- everything else unchanged' });
  }

  fs.writeFileSync('accounts-country-fix.json', JSON.stringify(output, null, 2));

  console.log('\n=== Plan (nothing written to Cloudflare yet) ===');
  for (const r of report) console.log(`${r.username.padEnd(12)} ${r.status}`);
  console.log(`\n${output.length} account record(s) staged in accounts-country-fix.json -- review before importing.`);
})().catch(e => { console.error(e); process.exit(1); });
