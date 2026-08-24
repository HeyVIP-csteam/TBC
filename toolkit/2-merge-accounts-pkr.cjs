// 2-merge-accounts-pkr.cjs
//
// Reads pkr-accounts-export.json (from 1-export-accounts-pkr.cjs) and
// compares every account: record in it against the NEW account's
// (danielc17888@gmail.com) shared ACCOUNTS_KV, by username. Produces
// accounts-pkr-merge.json (wrangler-bulk-put-ready, NEW account) plus a
// printed report -- nothing is written to Cloudflare by this script.
//
// Two outcomes per old PKR username:
//
//   1. Username does NOT exist yet in ACCOUNTS_KV
//      -> staged as a brand-new account: key, copied through from the
//         old record (salt/hash/role/etc all preserved so the agent's
//         existing password keeps working), with allowedCountries set
//         to ["PKR"] (or the old record's own allowedCountries array
//         plus "PKR" if it already had one -- old PKR-only accounts
//         should just have PKR, but this handles it either way).
//
//   2. Username ALREADY exists in ACCOUNTS_KV (the daniel01 case --
//      same person already has an INR and/or PHP account)
//      -> NOT auto-merged. Flagged in the report only. Per the same
//         precedent set for daniel01/PHP (see wrangler.toml's own
//         comment: "daniel01 ... 两边确认是同一个人，合并成了一个账号
//         ... 密码沿用 INR/PKR 那边原来的"), collapsing two credential
//         records into one is a judgment call (whose password wins,
//         whose role wins) that needs a human to confirm per-account,
//         not a script guessing. Add each confirmed case to
//         CONFIRMED_SAME_PERSON below (mirroring the pattern) and
//         re-run -- this keeps every merge decision visible in a
//         reviewable diff instead of silently happening inside a
//         script.
//
// Required env vars (point these at the NEW account, unlike step 1):
//   CF_API_TOKEN     — NEW account (danielc17888@gmail.com) token,
//                       "Workers KV Storage: Read" is enough (this
//                       script only reads the new side; the actual
//                       import is a separate `wrangler kv bulk put`
//                       you run yourself after reviewing the output).
//   CF_ACCOUNT_ID    — the NEW account's account id
//   CF_NAMESPACE_ID  — 4821238464004b8289e4ded5a467d582
//                       (ACCOUNTS_KV, i.e. the borrowed INR namespace
//                       -- see wrangler.toml's ACCOUNTS_KV comment)
//
// Usage:
//   node 2-merge-accounts-pkr.cjs
//   (reads pkr-accounts-export.json from the current directory)

const fs = require('fs');

const TOKEN = process.env.CF_API_TOKEN;
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const NAMESPACE_ID = process.env.CF_NAMESPACE_ID;

if (!TOKEN || !ACCOUNT_ID || !NAMESPACE_ID) {
  console.error('Missing CF_API_TOKEN / CF_ACCOUNT_ID / CF_NAMESPACE_ID env vars. See comments at top of this file.');
  process.exit(1);
}

// If, after reading the report this script prints, you confirm a
// username collision is genuinely the same person (like daniel01), add
// it here with which side's password should win, then re-run. Leave
// empty on the first run -- the report is meant to be read before any
// decision is made.
//   Example: { username: 'daniel01', keepPasswordFrom: 'new' }
const CONFIRMED_SAME_PERSON = [
  // { username: '____', keepPasswordFrom: 'new' | 'old' },
];

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
  if (!fs.existsSync('pkr-accounts-export.json')) {
    console.error('pkr-accounts-export.json not found -- run 1-export-accounts-pkr.cjs first.');
    process.exit(1);
  }
  const exported = JSON.parse(fs.readFileSync('pkr-accounts-export.json', 'utf8'));
  const oldAccountEntries = exported.filter((e) => e.key.startsWith('account:'));
  console.log(`Loaded ${oldAccountEntries.length} old PKR account: entries from pkr-accounts-export.json.`);

  console.log('Checking which of these usernames already exist in the NEW account\'s ACCOUNTS_KV...');
  const newValues = await bulkGetValues(oldAccountEntries.map((e) => e.key));

  const output = [];
  const report = [];

  for (const entry of oldAccountEntries) {
    const username = entry.key.replace(/^account:/, '');
    let oldAcc;
    try {
      oldAcc = JSON.parse(entry.value);
    } catch (e) {
      report.push({ username, status: `PARSE ERROR on old record -- skipped: ${e.message}` });
      continue;
    }

    const existingNewRaw = newValues[entry.key];
    if (!existingNewRaw) {
      // Case 1: brand-new username, not in ACCOUNTS_KV yet -- safe to
      // copy across as-is with allowedCountries set/extended to include PKR.
      const currentCountries = Array.isArray(oldAcc.allowedCountries) ? oldAcc.allowedCountries : [];
      const mergedCountries = currentCountries.includes('PKR') ? currentCountries : [...currentCountries, 'PKR'];
      const fixed = { ...oldAcc, username, allowedCountries: mergedCountries };
      output.push({ key: entry.key, value: JSON.stringify(fixed) });
      report.push({ username, status: `NEW -- will import with allowedCountries=${JSON.stringify(mergedCountries)}` });
      continue;
    }

    // Case 2: username collision with an existing NEW-account record.
    const confirmed = CONFIRMED_SAME_PERSON.find((c) => c.username.toLowerCase() === username.toLowerCase());
    if (!confirmed) {
      report.push({ username, status: 'COLLISION -- already exists in NEW ACCOUNTS_KV. NOT merged. Confirm this is the same person, then add to CONFIRMED_SAME_PERSON and re-run (see daniel01/PHP precedent in this file\'s header comment).' });
      continue;
    }
    let newAcc;
    try {
      newAcc = JSON.parse(existingNewRaw);
    } catch (e) {
      report.push({ username, status: `PARSE ERROR on existing new record -- skipped: ${e.message}` });
      continue;
    }
    const base = confirmed.keepPasswordFrom === 'old' ? oldAcc : newAcc;
    const currentCountries = Array.isArray(newAcc.allowedCountries) ? newAcc.allowedCountries : [];
    const mergedCountries = currentCountries.includes('PKR') ? currentCountries : [...currentCountries, 'PKR'];
    const merged = { ...base, username, allowedCountries: mergedCountries };
    output.push({ key: entry.key, value: JSON.stringify(merged) });
    report.push({ username, status: `MERGED (confirmed same person, password kept from "${confirmed.keepPasswordFrom}") -- allowedCountries=${JSON.stringify(mergedCountries)}` });
  }

  fs.writeFileSync('accounts-pkr-merge.json', JSON.stringify(output, null, 2));

  console.log('\n=== Plan (nothing written to Cloudflare yet) ===');
  for (const r of report) console.log(`${r.username.padEnd(15)} ${r.status}`);
  console.log(`\n${output.length} account record(s) staged in accounts-pkr-merge.json.`);
  console.log('Review it, then import into the NEW account with:');
  console.log('  wrangler kv bulk put accounts-pkr-merge.json --binding=ACCOUNTS_KV --remote');
  console.log('(run from project/ so wrangler.toml resolves the ACCOUNTS_KV binding)');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
