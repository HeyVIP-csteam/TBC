// finalize-brand-and-brandid.cjs
//
// FINAL pass, run AFTER the code changes to _shared/threads.js,
// api/threads.js and api/threads/[id].js have been deployed (those add
// brandId to metadata and prefer it over brand for permission checks).
//
// For every `thread:` entry (both the normal value+metadata shape and
// INR's D1-placeholder metadata-only shape), this:
//   1. Figures out the correct BRANDS id, from whichever of these is
//      usable (in priority order):
//        a. thread.brandId / metadata.brandId, if it's already a valid
//           BRANDS key
//        b. thread.brand / metadata.brand, if it's already a valid
//           BRANDS key (e.g. entries this session's fix-brand-suffix.cjs
//           already touched)
//        c. thread.brand / metadata.brand as a NAME that's unambiguous
//           across ALL brands (only one country has that name)
//        d. thread.brand / metadata.brand as a NAME + the entry's
//           country (from countryArg passed in) to disambiguate a name
//           that exists in multiple countries
//   2. Sets brand = BRANDS[id].name (clean display name, matches what
//      new tickets already get from submit.js)
//   3. Sets brandId = id
//   4. Regenerates metadata via the SAME summarize() logic as the real
//      threads.js (now including brandId)
//
// Entries where no id can be determined are left untouched and reported
// in `unresolved` for manual review.
//
// Usage:
//   node finalize-brand-and-brandid.cjs <export-file.json> <COUNTRY>
//
// Example:
//   node finalize-brand-and-brandid.cjs pkr-kv-export.json PKR

const fs = require('fs');

const file = process.argv[2];
const country = (process.argv[3] || '').toUpperCase();

if (!file || !country) {
  console.error('Usage: node finalize-brand-and-brandid.cjs <export-file.json> <COUNTRY>');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`File not found: ${file}`);
  process.exit(1);
}

// ---- Full BRANDS table, copied from functions/_shared/routing.js ----
const BRANDS = {
  crickex_inr: { name: "Crickex", country: "INR" },
  betjili_inr: { name: "Betjili", country: "INR" },
  mostplay_inr: { name: "Mostplay", country: "INR" },
  betvisa_inr: { name: "BetVisa", country: "INR" },
  jeetway_inr: { name: "Jeetway", country: "INR" },
  crickex_pkr: { name: "Crickex", country: "PKR" },
  betjili_pkr: { name: "Betjili", country: "PKR" },
  mostplay_pkr: { name: "Mostplay", country: "PKR" },
  jeetwin_pkr: { name: "Jeetwin", country: "PKR" },
  sbj66_pkr: { name: "Sbj66", country: "PKR" },
  heybaji_pkr: { name: "Heybaji", country: "PKR" },
  superbaji_pkr: { name: "Superbaji", country: "PKR" },
  kv8_pkr: { name: "KV8", country: "PKR" },
  darazplay_pkr: { name: "Darazplay", country: "PKR" },
  betjili_php: { name: "Betjili", country: "PHP" },
  betvisa_php: { name: "BetVisa", country: "PHP" },
};

const validIds = new Set(Object.keys(BRANDS));
const nameToIds = {};
for (const [id, b] of Object.entries(BRANDS)) {
  (nameToIds[b.name] ||= []).push(id);
}

function resolveId(brandField, brandIdField) {
  if (brandIdField && validIds.has(brandIdField)) return brandIdField;
  if (brandField && validIds.has(brandField)) return brandField; // already-id (this session's earlier pass)
  const name = brandField || brandIdField;
  if (!name) return null;
  const candidates = nameToIds[name];
  if (!candidates) return null;
  if (candidates.length === 1) return candidates[0];
  // Ambiguous by name alone — narrow by this thread's own country.
  const matching = candidates.filter((id) => BRANDS[id].country === country);
  if (matching.length === 1) return matching[0];
  return null; // still ambiguous — leave for manual review
}

// ---- summarize(), matching the updated functions/_shared/threads.js ----
function clip(str, max) {
  const s = String(str || "");
  return s.length > max ? s.slice(0, max) : s;
}
function summarize(thread) {
  const extraSearchText = clip(
    (thread.summary || []).map((s) => s.value).filter(Boolean).join(" ").toLowerCase(),
    300
  );
  return {
    id: thread.id,
    module: thread.module,
    moduleName: thread.moduleName,
    icon: thread.icon,
    accent: thread.accent,
    brand: thread.brand,
    brandId: thread.brandId || null,
    title: clip(thread.title, 200),
    submitter: clip(thread.submitter, 100),
    submittedAt: thread.submittedAt,
    lastActivity: thread.lastActivity,
    solved: thread.solved,
    solvedAt: thread.solvedAt,
    deleted: !!thread.deleted,
    replyCount: (thread.messages || []).length,
    extraSearchText,
  };
}

const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log(`Total entries in ${file}: ${entries.length}`);

let normalFixed = 0;
let placeholderFixed = 0;
let alreadyOk = 0;
let unresolved = 0;
let parseFailed = 0;
let noBrandAtAll = 0;
const unresolvedSamples = [];

for (const e of entries) {
  if (!e.key || !e.key.startsWith('thread:')) continue;

  let thread;
  try {
    thread = JSON.parse(e.value);
  } catch {
    parseFailed++;
    continue;
  }

  // Normal case: value is the real thread object.
  if (thread && typeof thread === 'object' && (thread.brand || thread.brandId)) {
    const id = resolveId(thread.brand, thread.brandId);
    if (!id) {
      unresolved++;
      if (unresolvedSamples.length < 15) unresolvedSamples.push({ key: e.key, brand: thread.brand, brandId: thread.brandId, via: 'value' });
      continue;
    }
    if (thread.brand === BRANDS[id].name && thread.brandId === id) {
      alreadyOk++;
      continue;
    }
    thread.brand = BRANDS[id].name;
    thread.brandId = id;
    e.value = JSON.stringify(thread);
    e.metadata = summarize(thread);
    normalFixed++;
    continue;
  }

  // D1-placeholder case (mainly INR): real data lives in metadata.
  if (e.metadata && (e.metadata.brand || e.metadata.brandId)) {
    const id = resolveId(e.metadata.brand, e.metadata.brandId);
    if (!id) {
      unresolved++;
      if (unresolvedSamples.length < 15) unresolvedSamples.push({ key: e.key, brand: e.metadata.brand, brandId: e.metadata.brandId, via: 'metadata' });
      continue;
    }
    if (e.metadata.brand === BRANDS[id].name && e.metadata.brandId === id) {
      alreadyOk++;
      continue;
    }
    e.metadata = { ...e.metadata, brand: BRANDS[id].name, brandId: id };
    placeholderFixed++;
    continue;
  }

  noBrandAtAll++;
}

const outFile = file.replace(/\.json$/, '') + '-finalized.json';
fs.writeFileSync(outFile, JSON.stringify(entries, null, 2));

console.log(`\nfixed via value+metadata (normal)     : ${normalFixed}`);
console.log(`fixed via metadata only (D1 placeholder) : ${placeholderFixed}`);
console.log(`already correct (brand=name, brandId=id) : ${alreadyOk}`);
console.log(`no brand/brandId anywhere               : ${noBrandAtAll}`);
console.log(`parse failed                            : ${parseFailed}`);
console.log(`UNRESOLVED (needs manual review)        : ${unresolved}`);

if (unresolvedSamples.length) {
  console.log(`\nUnresolved samples (up to 15):`);
  unresolvedSamples.forEach((s) => console.log(`  ${s.key}  brand="${s.brand}" brandId="${s.brandId}"  (via ${s.via})`));
}

console.log(`\nWrote: ${outFile}`);
console.log(`Import with the same auto-fix-and-import.cjs flow used before, or:`);
console.log(`  wrangler kv bulk put ${outFile} --namespace-id=<COUNTRY's namespace id> --remote`);
