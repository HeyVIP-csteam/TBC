const iconv = require('iconv-lite');
const { fixString, deepFix } = require('./mojibake-fix.cjs');

function corrupt(original, encChain) {
  let bytes = Buffer.from(original, 'utf8');
  let str = null;
  for (const enc of encChain) {
    str = iconv.decode(bytes, enc);
    bytes = Buffer.from(str, 'utf8');
  }
  return str;
}

console.log('--- SINGLE-layer corruption ---');
const singleSamples = [
  ['Promotion Request — 充值活动 🎉', ['cp850']],
  ['Risk Issue — 风控问题', ['cp850']],
  ['代付申请 Bea', ['cp850']],
  ['Edelyn — 存款问题（急）', ['cp437']],
  ['Withdraw Issue —— Withdraw Disapproved', ['win1252']],
];
for (const [orig, chain] of singleSamples) {
  const bad = corrupt(orig, chain);
  const r = fixString(bad);
  console.log(r.value === orig ? 'PASS' : 'FAIL', JSON.stringify({ orig, bad, fixed: r.value, enc: r.encoding }));
}

console.log('\n--- DOUBLE-layer corruption (the real bug found in spot-check) ---');
const doubleSamples = [
  ['Withdraw Issue —— Withdraw Disapproved', ['win1252', 'win1252']],
  ['Promotion Request — 充值活动 🎉', ['win1252', 'win1252']],
  ['风控问题正常存储 测试', ['win1252', 'win1252']],
];
for (const [orig, chain] of doubleSamples) {
  const bad = corrupt(orig, chain);
  const r = fixString(bad);
  console.log(r.value === orig ? 'PASS' : 'FAIL', JSON.stringify({ orig, bad, fixed: r.value, enc: r.encoding }));
}

console.log('\n--- clean strings should still be left untouched ---');
const cleanSamples = [
  'Promotion Request',
  'https://t.me/c/123456/789',
  '2026-07-30T10:26:00.000Z',
  '风控问题正常存储',
  'crickex-brand-01',
  '',
  null,
  'Betjili PHP',
];
for (const s of cleanSamples) {
  const r = fixString(s);
  console.log(!r.changed ? 'PASS' : 'FAIL', JSON.stringify({ s, changed: r.changed, out: r.value }));
}

console.log('\n--- the EXACT real sample from the spot-check screenshot ---');
const realBefore = 'Withdraw Issue \u00e3\u0192\u00e2\u20ac\u00e3\u0192\u00e2\u20ac\u00a1\u00e3\u0192\u00c2\u00b6 Withdraw Disapproved';
const r = fixString(realBefore);
console.log('fixed:', r.value, '| encoding chain used:', r.encoding);
