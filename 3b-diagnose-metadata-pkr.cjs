// 3b-diagnose-metadata-pkr.cjs
//
// v1 (3-diagnose-metadata-pkr.cjs) found 0 entries over the 1024-byte
// metadata limit using plain UTF-8 byte length, but `wrangler kv bulk put`
// still errored with "Metadata length of 1044 exceeds limit of 1024".
//
// The likely explanation: this data contains CJK characters / emoji
// (same as the PHP dataset), and whatever JSON encoding wrangler/the
// Cloudflare API uses internally may escape non-ASCII characters as
// \uXXXX sequences instead of raw UTF-8 bytes. A single Chinese
// character is ~3 bytes in UTF-8 but 6 bytes as \uXXXX; an emoji
// (often a surrogate pair) can be ~4 bytes in UTF-8 but 12 bytes as
// \uXXXX\uXXXX. That inflates the effective "metadata length" far
// beyond what raw UTF-8 byte counting suggests.
//
// This script checks BOTH ways and reports anything that's borderline
// or over 1024 under either method, so we don't miss it again.
//
// Usage:
//   node 3b-diagnose-metadata-pkr.cjs

const fs = require('fs');

if (!fs.existsSync('pkr-kv-export.json')) {
  console.error('pkr-kv-export.json not found in current directory.');
  process.exit(1);
}

const entries = JSON.parse(fs.readFileSync('pkr-kv-export.json', 'utf8'));
console.log(`Total entries: ${entries.length}`);

const LIMIT = 1024;

// Mimics JSON.stringify but escapes all non-ASCII chars as \uXXXX,
// which is the "worst case" some JSON encoders/transports use.
function jsonStringifyAsciiEscaped(value) {
  const json = JSON.stringify(value);
  let out = '';
  for (const ch of json) {
    const code = ch.codePointAt(0);
    if (code > 0x7e) {
      // Escape as \uXXXX (handles BMP chars directly; surrogate pairs
      // naturally split into two \uXXXX since we're iterating UTF-16
      // code units via a plain for...of on a JS string over char codes)
      out += '\\u' + code.toString(16).padStart(4, '0');
    } else {
      out += ch;
    }
  }
  return out;
}

const offenders = [];

for (const e of entries) {
  if (e.metadata === null || e.metadata === undefined) continue;

  const metaValue = e.metadata;
  const utf8Str = typeof metaValue === 'string' ? metaValue : JSON.stringify(metaValue);
  const utf8Bytes = Buffer.byteLength(utf8Str, 'utf8');

  const asciiEscaped = typeof metaValue === 'string'
    ? jsonStringifyAsciiEscaped(metaValue) // string metadata, escape as-is
    : jsonStringifyAsciiEscaped(metaValue);
  const asciiBytes = asciiEscaped.length; // already ASCII-only at this point, 1 char = 1 byte

  if (utf8Bytes > LIMIT || asciiBytes > LIMIT) {
    offenders.push({ key: e.key, utf8Bytes, asciiBytes, metaStr: utf8Str });
  }
}

console.log(`\nEntries over ${LIMIT} bytes under UTF-8 OR ascii-escaped counting: ${offenders.length}`);

if (offenders.length === 0) {
  console.log('\nStill nothing found by either method. The oversized entry might have');
  console.log('a metadata shape my script isn\'t reading correctly, or the limit is');
  console.log('being hit on a field other than metadata. Next step: run wrangler with');
  console.log('a small --batch-size (e.g. 1) starting partway through the file to');
  console.log('binary-search the exact failing key, or share the FULL wrangler error');
  console.log('output (it sometimes names the key directly above the "Metadata length"');
  console.log('line).');
  process.exit(0);
}

const byPrefix = {};
for (const o of offenders) {
  const prefix = o.key.split(':')[0] || o.key;
  byPrefix[prefix] = byPrefix[prefix] || { count: 0, maxUtf8: 0, maxAscii: 0 };
  byPrefix[prefix].count++;
  byPrefix[prefix].maxUtf8 = Math.max(byPrefix[prefix].maxUtf8, o.utf8Bytes);
  byPrefix[prefix].maxAscii = Math.max(byPrefix[prefix].maxAscii, o.asciiBytes);
}

console.log('\nBy prefix:');
for (const [prefix, stats] of Object.entries(byPrefix).sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${prefix.padEnd(25)} count=${stats.count}  max_utf8=${stats.maxUtf8}B  max_ascii_escaped=${stats.maxAscii}B`);
}

console.log('\nFirst 5 offending keys:');
for (const o of offenders.slice(0, 5)) {
  const preview = o.metaStr.length > 400 ? o.metaStr.slice(0, 400) + '...(truncated)' : o.metaStr;
  console.log(`\n--- ${o.key} (utf8=${o.utf8Bytes}B, ascii_escaped=${o.asciiBytes}B) ---`);
  console.log(preview);
}

fs.writeFileSync('pkr-metadata-offenders.json', JSON.stringify(offenders.map(o => ({ key: o.key, utf8Bytes: o.utf8Bytes, asciiBytes: o.asciiBytes })), null, 2));
console.log(`\nFull list saved to pkr-metadata-offenders.json (${offenders.length} keys).`);
