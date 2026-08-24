// 3-fix-accounts-index-pkr.cjs
//
// The 23 PKR accounts imported via accounts-pkr-merge.json in step 2
// went straight into `account:<username>` keys via `wrangler kv bulk
// put` -- correct data, but that bypassed saveAccount()'s own bookkeeping
// (see _shared/accounts.js) which normally also appends the new
// username to a SEPARATE index key, "accounts-index" (a single JSON
// array of every username). The admin UI's account list
// (listAccounts()) reads ONLY that index, not a live scan of KV -- so
// the 23 accounts are correctly stored and can log in, but don't show
// up in accounts-admin.html / the Agent Profile table until their
// usernames are added to the index too. This script does just that:
// read the index, add any of the 23 that are missing, write it back.
// Read-only against everything except this one key.
//
// Required env vars (NEW account, same as step 2's merge script):
//   CF_API_TOKEN     — needs Workers KV Storage: Edit this time (this
//                       script writes the index key), NOT just Read.
//   CF_ACCOUNT_ID    — the NEW account's account id
//   CF_NAMESPACE_ID  — 4821238464004b8289e4ded5a467d582 (ACCOUNTS_KV)
//
// Usage:
//   node 3-fix-accounts-index-pkr.cjs

const TOKEN = process.env.CF_API_TOKEN;
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const NAMESPACE_ID = process.env.CF_NAMESPACE_ID;

if (!TOKEN || !ACCOUNT_ID || !NAMESPACE_ID) {
  console.error('Missing CF_API_TOKEN / CF_ACCOUNT_ID / CF_NAMESPACE_ID env vars.');
  process.exit(1);
}

const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}`;
const INDEX_KEY = 'accounts-index';

// The exact 23 usernames imported in step 2 (from accounts-pkr-merge.json's
// report -- everyone marked NEW, i.e. every account: entry except the
// daniel01 collision, which was correctly skipped and is already indexed).
const IMPORTED_USERNAMES = [
  'csahad', 'csaizal', 'csali', 'csarsal', 'csasad', 'csatif', 'csawais',
  'csayan', 'csdanish', 'cshaseeb', 'cshasnain', 'csibrahim', 'csjack',
  'csjon', 'csnisha', 'csshah', 'cssufian', 'csted', 'csven', 'cswasif',
  'csyousuf', 'cszeshan', 'muzammil',
];

async function cfFetch(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  // The raw value endpoints (GET on a specific key) return plain text,
  // not a Cloudflare-envelope JSON -- handle both shapes.
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

(async () => {
  console.log(`Reading current "${INDEX_KEY}" from ACCOUNTS_KV...`);
  let usernames = [];
  try {
    const raw = await cfFetch(`/values/${encodeURIComponent(INDEX_KEY)}`);
    usernames = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(usernames)) throw new Error('accounts-index value is not a JSON array');
  } catch (e) {
    console.error(`Could not read/parse "${INDEX_KEY}" -- aborting without writing anything.`, e.message);
    process.exit(1);
  }
  console.log(`Current index has ${usernames.length} usernames.`);

  const missing = IMPORTED_USERNAMES.filter((u) => !usernames.includes(u));
  if (!missing.length) {
    console.log('All 23 imported usernames are already in the index -- nothing to do.');
    return;
  }
  console.log(`Adding ${missing.length} missing username(s): ${missing.join(', ')}`);

  const updated = [...missing, ...usernames]; // unshift, matching saveAccount()'s own ordering
  await cfFetch(`/values/${encodeURIComponent(INDEX_KEY)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(updated),
  });
  console.log(`Done. "${INDEX_KEY}" now has ${updated.length} usernames.`);
  console.log('Refresh accounts-admin.html / the Agent Profile table -- the 23 PKR accounts should now be visible.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
