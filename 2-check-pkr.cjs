// 2-check-pkr.cjs
//
// Sanity-checks pkr-kv-export.json before you run the real
// `wrangler kv bulk put` import into the NEW account's PKR namespace.
// Read-only, no network calls — just inspects the local export file.
//
// Unlike PHP, PKR was never confirmed to have the mojibake problem
// (that was traced to a specific PowerShell/CP850 export step used
// for PHP — this PKR export goes straight over the Cloudflare API in
// UTF-8, so that specific failure mode shouldn't recur). This script
// does a lighter check: key counts by prefix, null/empty values, and
// a mojibake *heuristic* scan (flags suspicious byte patterns like
// "Ã", "â€", "Ä-" so you know to pull in mojibake-fix.cjs if PKR's
// old data was ALSO exported badly at some point in its history).
//
// Usage:
//   node 2-check-pkr.cjs

const fs = require('fs');

if (!fs.existsSync('pkr-kv-export.json')) {
  console.error('pkr-kv-export.json not found — run 1-export-pkr.cjs first.');
  process.exit(1);
}

const entries = JSON.parse(fs.readFileSync('pkr-kv-export.json', 'utf8'));
console.log(`Total entries: ${entries.length}`);

const byPrefix = {};
let nullValues = 0;
let emptyValues = 0;
const mojibakeSuspects = [];
// Common tell-tale byte sequences when UTF-8 text has been mangled
// through win1252/cp850 round-trips (same families 2-fix.cjs looks for).
const MOJIBAKE_PATTERN = /Ã[\x80-\xBF]|â€[\x99\x9c\x9d\x93\x94]|Ä-|Å-/;

for (const e of entries) {
  const prefix = (e.key.split(':')[0]) || e.key;
  byPrefix[prefix] = (byPrefix[prefix] || 0) + 1;

  if (e.value === null || e.value === undefined) {
    nullValues++;
  } else if (e.value === '') {
    emptyValues++;
  } else if (typeof e.value === 'string' && MOJIBAKE_PATTERN.test(e.value)) {
    mojibakeSuspects.push(e.key);
  }
}

console.log('\nKey counts by prefix:');
for (const [prefix, count] of Object.entries(byPrefix).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${prefix.padEnd(30)} ${count}`);
}

console.log(`\nNull values: ${nullValues}`);
console.log(`Empty-string values: ${emptyValues}`);

if (mojibakeSuspects.length) {
  console.log(`\n⚠️  ${mojibakeSuspects.length} keys look like they might have mojibake (same pattern as the PHP bug):`);
  console.log('   ' + mojibakeSuspects.slice(0, 15).join('\n   '));
  console.log('\n   If these look genuinely garbled when you open them, reuse');
  console.log('   mojibake-fix.cjs the same way 2-fix.cjs did for PHP, instead of');
  console.log('   importing pkr-kv-export.json as-is.');
} else {
  console.log('\nNo mojibake-style patterns detected — pkr-kv-export.json looks safe to import as-is.');
}

console.log(`\nNext step (imports into the NEW account, --remote actually writes data):
  wrangler kv bulk put pkr-kv-export.json --binding=THREADS_KV_PKR --remote

Make sure your wrangler CLI is authenticated against the NEW account
(danielc17888@gmail.com) — not the old one — before running that,
since this script only checked the local file and made no network calls.`);
