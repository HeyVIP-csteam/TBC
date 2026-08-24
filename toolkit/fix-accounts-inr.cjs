// fix-accounts-inr.cjs
//
// Sets allowedCountries: ["INR"] on exactly these 30 named accounts.
// Two different starting states are handled, confirmed via
// list-all-accounts-v2.cjs's full output:
//   - 29 accounts: allowedCountries currently undefined (never set)
//   - 1 account (june, superadmin): allowedCountries currently [] (an
//     explicit empty array, not undefined -- per countryAccess.js's own
//     documented migration rule this normally means "deliberately
//     narrowed to see nothing" and would NOT be auto-migrated, but the
//     business owner explicitly confirmed via this conversation this one
//     should get ["INR"] too)
//
// Every other field on each account record (role, allowedBrands,
// password hash, everything) is copied through byte-identical. No
// account outside this exact list of 30 is read or touched -- daniel01
// (already correctly ["INR","PKR","PHP"]) and the 9 PHP accounts
// (handled separately by fix-accounts-country.cjs) are excluded on
// purpose.
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
  const values = {};
  for (let i = 0; i < keyNames.length; i += 100) {
    const chunk = keyNames.slice(i, i + 100);
    const json = await cfFetch(`/bulk/get`, { method: 'POST', body: JSON.stringify({ keys: chunk, type: 'text' }) });
    Object.assign(values, json.result.values || json.result);
  }
  return values;
}

// Group A: specific INR brand names already assigned -- allowedCountries
// currently undefined.
const GROUP_UNDEFINED = [
  'akilan','ben','daemon','darsh','david','deepak','dhanush','evans',
  'goutham','jennie','joan','kedareswar','krishnakumar','mani','micheal',
  'rohan','sameer','soundara',
  // Group B: allowedBrands:"all", allowedCountries currently undefined
  'arbaaz','arun','guru','icxteamtest','kiran','manish','naseem','pappala','sarath','siva','tanmoy',
];
// Group C: currently an explicit [] (not undefined) -- confirmed via
// this conversation the business owner wants ["INR"] here too.
const GROUP_EMPTY_ARRAY = ['june'];

const ALL_TARGETS = [...GROUP_UNDEFINED, ...GROUP_EMPTY_ARRAY];

(async () => {
  const keys = ALL_TARGETS.map(u => `account:${u}`);
  console.log(`Fetching current records for ${keys.length} accounts...`);
  const values = await bulkGetValues(keys);

  const output = [];
  const report = [];

  for (const uname of ALL_TARGETS) {
    const key = `account:${uname}`;
    const raw = values[key];
    if (!raw) {
      report.push({ username: uname, status: 'NOT FOUND -- skipped, no output produced' });
      continue;
    }
    let acc;
    try {
      acc = JSON.parse(raw);
    } catch (e) {
      report.push({ username: uname, status: `PARSE ERROR -- skipped: ${e.message}` });
      continue;
    }

    const isEmptyArrayGroup = GROUP_EMPTY_ARRAY.includes(uname);
    const currentIsExpected = isEmptyArrayGroup
      ? (Array.isArray(acc.allowedCountries) && acc.allowedCountries.length === 0)
      : (acc.allowedCountries === undefined);

    if (!currentIsExpected) {
      report.push({ username: uname, status: `SKIPPED -- allowedCountries is now ${JSON.stringify(acc.allowedCountries)} (not what was expected when this plan was made), not touching -- re-run list-all-accounts-v2.cjs to see current state` });
      continue;
    }

    const fixed = { ...acc, allowedCountries: ['INR'] };
    output.push({ key, value: JSON.stringify(fixed) });
    report.push({ username: uname, status: 'WILL SET allowedCountries=["INR"] -- everything else unchanged' });
  }

  fs.writeFileSync('accounts-inr-fix.json', JSON.stringify(output, null, 2));

  console.log('\n=== Plan (nothing written to Cloudflare yet) ===');
  for (const r of report) console.log(`${r.username.padEnd(15)} ${r.status}`);
  console.log(`\n${output.length} account record(s) staged in accounts-inr-fix.json -- review before importing.`);
})().catch(e => { console.error(e); process.exit(1); });
