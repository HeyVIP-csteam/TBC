const fs = require('fs');
const iconv = require('iconv-lite');
function corrupt(s) { return iconv.decode(Buffer.from(s, 'utf8'), 'cp850'); }

const goodThread = {
  id: 't1', module: 'promotion', moduleName: 'Promotion Request', icon: '🎯', accent: '#f00',
  brand: 'Crickex', title: 'Promotion Request', submitter: 'Ash',
  submittedAt: '2026-07-30T10:26:00.000Z', lastActivity: '2026-07-30T10:26:00.000Z',
  solved: false, solvedAt: null, deleted: false, messages: [], summary: [{ label: 'Amount', value: '500' }],
};

const badThread = {
  ...goodThread,
  id: 't2',
  title: corrupt('Promotion Request — 充值活动 🎉'),
  submitter: corrupt('Ash'),
  messages: [{ from: 'agent01', text: corrupt('已处理 ✅'), ts: '2026-07-30T10:30:00.000Z' }],
};

const entries = [
  // thread with metadata missing entirely (simulates 根因一)
  { key: 'thread:t1', value: JSON.stringify(goodThread), metadata: null },
  // thread with corrupted title/submitter AND stale/corrupted metadata
  { key: 'thread:t2', value: JSON.stringify(badThread), metadata: { id: 't2', title: corrupt('Promotion Request — 充值活动 🎉'), submitter: corrupt('Ash') } },
  // a non-thread JSON key with corrupted content
  { key: 'mention-registry:crickex', value: JSON.stringify({ jade: { from: corrupt('客服Jade'), lastSeen: '2026-07-01' } }), metadata: null },
  // a plain non-JSON string value, corrupted
  { key: 'route:crickex:promotion', value: corrupt('风控问题'), metadata: null },
  // a D1-placeholder-style plain "1" value (should pass through untouched)
  { key: 'thread:t3', value: '1', metadata: { id: 't3', title: 'Fine already' } },
];

fs.writeFileSync('php-kv-export.json', JSON.stringify(entries, null, 2));
console.log('wrote fake php-kv-export.json with', entries.length, 'entries');
