// 3-diagnose-metadata-pkr.cjs
//
// wrangler kv bulk put 报错 "Metadata length of 1044 exceeds limit of 1024"
// 说明 pkr-kv-export.json 里至少有一条 key 的 metadata 字段（JSON 序列化后）
// 超过了 Cloudflare 对 KV metadata 的 1024 字节硬性上限。
//
// 这个脚本只做诊断，不改数据：把每条 entry 的 metadata 算一下 JSON 字节数，
// 列出所有超标的 key，以及按前缀（thread: / msgid: / mention-registry: 等）
// 统计有多少条超标、平均/最大超了多少，方便判断修复思路
// （比如是不是某个字段特别大、是不是只有 thread: 这一类超标）。
//
// 用法：
//   node 3-diagnose-metadata-pkr.cjs

const fs = require('fs');

if (!fs.existsSync('pkr-kv-export.json')) {
  console.error('pkr-kv-export.json not found in current directory.');
  process.exit(1);
}

const entries = JSON.parse(fs.readFileSync('pkr-kv-export.json', 'utf8'));
console.log(`Total entries: ${entries.length}`);

const LIMIT = 1024;
const offenders = [];

for (const e of entries) {
  if (e.metadata === null || e.metadata === undefined) continue;
  const metaStr = typeof e.metadata === 'string' ? e.metadata : JSON.stringify(e.metadata);
  const byteLen = Buffer.byteLength(metaStr, 'utf8');
  if (byteLen > LIMIT) {
    offenders.push({ key: e.key, byteLen, metaStr });
  }
}

console.log(`\nEntries with metadata over ${LIMIT} bytes: ${offenders.length}`);

if (offenders.length === 0) {
  console.log('No offenders found by this check — the error might be intermittent or from a key not caught here. Re-run wrangler with a smaller --batch-size to isolate which key fails, or share the exact error again.');
  process.exit(0);
}

// Group by prefix so we know which category of key is the problem.
const byPrefix = {};
for (const o of offenders) {
  const prefix = o.key.split(':')[0] || o.key;
  byPrefix[prefix] = byPrefix[prefix] || { count: 0, maxBytes: 0, totalBytes: 0 };
  byPrefix[prefix].count++;
  byPrefix[prefix].maxBytes = Math.max(byPrefix[prefix].maxBytes, o.byteLen);
  byPrefix[prefix].totalBytes += o.byteLen;
}

console.log('\nBy prefix:');
for (const [prefix, stats] of Object.entries(byPrefix).sort((a, b) => b[1].count - a[1].count)) {
  const avg = Math.round(stats.totalBytes / stats.count);
  console.log(`  ${prefix.padEnd(25)} count=${stats.count}  max=${stats.maxBytes}B  avg=${avg}B`);
}

console.log('\nFirst 5 offending keys (key, byte length, metadata preview):');
for (const o of offenders.slice(0, 5)) {
  const preview = o.metaStr.length > 300 ? o.metaStr.slice(0, 300) + '...(truncated for display)' : o.metaStr;
  console.log(`\n--- ${o.key} (${o.byteLen} bytes) ---`);
  console.log(preview);
}

fs.writeFileSync('pkr-metadata-offenders.json', JSON.stringify(offenders.map(o => ({ key: o.key, byteLen: o.byteLen })), null, 2));
console.log(`\nFull list of ${offenders.length} offending keys (key + byte length only, no full metadata) saved to pkr-metadata-offenders.json`);
