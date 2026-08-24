// 6-regenerate-metadata-pkr.cjs
//
// The app's sidebar (Active/Solved/Recall counts + thread list) reads
// each `thread:` key's cheap KV *metadata* summary instead of the full
// JSON value, for performance (see scanThreadsFromKV() / summarize() in
// functions/_shared/threads.js). Any thread: key WITHOUT that metadata
// attached only gets "healed" (metadata computed and attached) at a
// rate of MAX_HEAL_PER_CALL = 15 per page load — with thousands of
// freshly-imported threads missing metadata, the vast majority would
// simply not show up in the sidebar at all until healed over many,
// many page refreshes.
//
// This script regenerates metadata for EVERY thread: entry in
// pkr-kv-export.json using the exact same summarize() logic from
// threads.js (copied verbatim below), so the re-import carries correct
// metadata from the start — no waiting on the 15-per-call healing
// trickle.
//
// Only touches `thread:` keys. Every other key (msgid:, activitylog:,
// mention-registry:, etc.) is left completely untouched.
//
// Usage:
//   node 6-regenerate-metadata-pkr.cjs
//
// Output: pkr-kv-export.json is overwritten in place with corrected
// metadata (a .bak copy of the pre-fix version is saved alongside it
// first, just in case).

const fs = require('fs');

if (!fs.existsSync('pkr-kv-export.json')) {
  console.error('pkr-kv-export.json not found in current directory.');
  process.exit(1);
}

// ---- copied verbatim from functions/_shared/threads.js ----
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
// ---- end copied logic ----

const entries = JSON.parse(fs.readFileSync('pkr-kv-export.json', 'utf8'));
console.log(`Total entries: ${entries.length}`);

fs.writeFileSync('pkr-kv-export.json.bak', JSON.stringify(entries, null, 2));
console.log('Backed up pre-fix version to pkr-kv-export.json.bak');

let regenerated = 0;
let parseFailed = 0;
let skippedNotThread = 0;

for (const e of entries) {
  if (!e.key.startsWith('thread:')) {
    skippedNotThread++;
    continue;
  }
  if (e.value === null || e.value === undefined) continue;

  let thread;
  try {
    thread = typeof e.value === 'string' ? JSON.parse(e.value) : e.value;
  } catch (err) {
    parseFailed++;
    console.warn(`  WARNING: could not JSON.parse value for ${e.key} — leaving its metadata untouched. (${err.message})`);
    continue;
  }

  e.metadata = summarize(thread);
  regenerated++;
}

console.log(`\nRegenerated metadata for ${regenerated} thread: keys.`);
console.log(`Skipped (not a thread: key): ${skippedNotThread}`);
if (parseFailed > 0) {
  console.log(`Could not parse value (metadata left as-is): ${parseFailed} — worth a manual look.`);
}

fs.writeFileSync('pkr-kv-export.json', JSON.stringify(entries, null, 2));
console.log('\nSaved pkr-kv-export.json with corrected metadata — ready to re-run 4-import-pkr.cjs.');
