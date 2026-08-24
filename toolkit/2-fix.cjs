// 2-fix.cjs
//
// Reads php-kv-export.json (produced by 1-export.cjs), fixes mojibake
// everywhere it's detected, and — for every `thread:*` key — REGENERATES
// its KV metadata from scratch from the (now-fixed) full record. That
// second part is what finally kills 根因一 (missing/incomplete metadata
// from the original bulk import) in the same pass, instead of waiting
// on the 15-per-10-minute self-heal to slowly catch up over ~6 hours.
//
// The summarize()/clip() logic below is copied verbatim from
// functions/_shared/threads.js so the regenerated metadata is BYTE-
// COMPATIBLE with what the app itself would have written — this is not
// a reimplementation, it's the same rule applied offline.
//
// Output:
//   php-threads-corrected.json   — bulk-put-ready, all `thread:*` keys
//   php-other-corrected.json     — bulk-put-ready, everything else
//   report.json                  — stats + before/after samples for
//                                   spot-checking before you import
//
// Usage: node 2-fix.cjs

const fs = require('fs');
const { deepFix } = require('./mojibake-fix.cjs');

function clip(str, max) {
  const s = String(str || '');
  return s.length > max ? s.slice(0, max) : s;
}

// Mirrors functions/_shared/threads.js summarize() exactly.
function summarize(thread) {
  const extraSearchText = clip(
    (thread.summary || []).map((s) => s.value).filter(Boolean).join(' ').toLowerCase(),
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

const raw = JSON.parse(fs.readFileSync('php-kv-export.json', 'utf8'));
console.log(`Loaded ${raw.length} KV entries from php-kv-export.json`);

const threadsOut = [];
const otherOut = [];
const report = {
  totalKeys: raw.length,
  stringsFixedCount: 0,
  keysWithAnyFix: 0,
  threadMetadataRegenerated: 0,
  samples: [],
  parseFailures: [],
};

for (const entry of raw) {
  const { key, value, metadata } = entry;
  const isThread = key.startsWith('thread:');
  const changedCount = { n: 0 };
  const samples = [];

  let fixedValue = value;
  let parsedThread = null;

  if (value !== null && value !== undefined) {
    // Try JSON first (thread records, and most other structured keys
    // like mention-registry:/route:/deposit-sheet: are JSON too).
    // Non-JSON values (e.g. the "1" D1 placeholder, plain string
    // values) fall back to direct string fixing.
    try {
      const parsed = JSON.parse(value);
      const fixed = deepFix(parsed, changedCount, samples);
      fixedValue = JSON.stringify(fixed);
      // Guard: only treat this as "a thread record" for metadata
      // regeneration if it actually parsed to a plain object (a full
      // thread JSON). A D1-backed country's placeholder value ("1",
      // just a bare number) parses successfully as JSON but is NOT a
      // thread record -- summarize() would silently produce garbage
      // metadata (title:"", replyCount:0, ...) if run on it. PHP has
      // no D1 so this shouldn't occur in practice, but this script is
      // meant to be reused for PKR too, so guard it properly anyway.
      if (isThread && fixed && typeof fixed === 'object' && !Array.isArray(fixed)) {
        parsedThread = fixed;
      }
    } catch (e) {
      const { fixString } = require('./mojibake-fix.cjs');
      const r = fixString(value);
      fixedValue = r.value;
      if (r.changed) {
        changedCount.n++;
        samples.push({ before: value, after: r.value });
      }
      report.parseFailures.push(key); // not an error -- just noting it wasn't JSON
    }
  }

  const fixedMetadata = metadata ? deepFix(metadata, changedCount, samples) : metadata;

  if (changedCount.n > 0) {
    report.keysWithAnyFix++;
    report.stringsFixedCount += changedCount.n;
    if (report.samples.length < 15) {
      report.samples.push({ key, fixes: samples.slice(0, 2) });
    }
  }

  let outMetadata = fixedMetadata;
  if (isThread && parsedThread) {
    // Regenerate metadata from the corrected full record, regardless of
    // whether it had valid/complete metadata before -- this is what
    // fully resolves 根因一 in one pass instead of relying on self-heal.
    outMetadata = summarize(parsedThread);
    report.threadMetadataRegenerated++;
  }

  const outEntry = { key, value: fixedValue };
  if (outMetadata) outEntry.metadata = outMetadata;

  (isThread ? threadsOut : otherOut).push(outEntry);
}

fs.writeFileSync('php-threads-corrected.json', JSON.stringify(threadsOut, null, 2));
fs.writeFileSync('php-other-corrected.json', JSON.stringify(otherOut, null, 2));
fs.writeFileSync('report.json', JSON.stringify(report, null, 2));

console.log(`\n=== Summary ===`);
console.log(`thread: keys        : ${threadsOut.length} -> php-threads-corrected.json`);
console.log(`other keys          : ${otherOut.length} -> php-other-corrected.json`);
console.log(`keys with any fix   : ${report.keysWithAnyFix}`);
console.log(`total strings fixed : ${report.stringsFixedCount}`);
console.log(`thread metadata regenerated: ${report.threadMetadataRegenerated}`);
console.log(`\nFull report + samples written to report.json -- SPOT CHECK these before importing.`);
