// 可拆成兩個模組的題目:比較單人、平行分工與接力用。兩個模組的介面都寫在題目裡,
// 平行分工時兩邊不必等對方;接力時後一棒看得到前一棒實際寫出的檔案。
import type { AbTask } from './ab-tasks';

export const SPLIT_TASKS: AbTask[] = [
  {
    id: 'ledger',
    set: 'split',
    asks: '解析與彙總兩個模組:日期、金額精度、行號與截斷規則都要對',
    task: '建立兩個模組,都以 module.exports = { 名稱 } 匯出。\n\n'
      + '(一)ledger/parse.js 匯出 parseLedger(text):text 是多行帳目,每行格式為「日期,帳戶,金額」,例如「2024-03-01,expenses:food,-12.50」。'
      + '每行前後空白忽略;空行與以 # 開頭的行略過。日期為 YYYY-MM-DD,必須是真實存在的日期(考慮閏年)。'
      + '帳戶由一到多段以冒號連接,每段只能是小寫英文字母或數字,不可為空。'
      + '金額為可帶 + 或 - 號的十進位數,最多兩位小數(例如 5、-3.1、+0.25),不可有千分位或其他字元。'
      + '回傳依原順序排列的 { date, account, cents } 陣列,cents 是換算成「分」的整數,不可有浮點誤差。'
      + '任何一行不合格就丟出 Error,訊息要包含「line N」,N 是原始文字中從 1 起算的行號(空行與註解也算行數)。\n\n'
      + '(二)ledger/report.js 匯出 balances(entries, options):entries 是 parseLedger 的回傳值;options 可省略,可含 from、to(YYYY-MM-DD,含當天,可各自省略)與 depth(正整數,可省略)。'
      + '先依日期篩選,再把帳戶截斷成前 depth 段(段數不足就保留原名;沒給 depth 就不截斷),同名的加總。'
      + '回傳 [{ account, cents }] 陣列,依 account 字串由小到大排序,並去掉加總為 0 的帳戶。不可修改傳入的陣列與物件。',
    parts: [
      '這次你只負責(一):建立 ledger/parse.js。ledger/report.js 由另一位成員負責,不要建立或修改它。',
      '這次你只負責(二):建立 ledger/report.js。ledger/parse.js 由另一位成員負責,不要建立或修改它;report.js 只依上面寫的 entries 格式運作。',
    ],
    entry: 'ledger/parse.js',
    tests: `
const P = () => M().parseLedger;
const R = () => require(require('path').join(require('path').dirname(ENTRY), 'report.js')).balances;
const e = (date, account, cents) => ({ date, account, cents });
const sample = () => [e('2024-01-05', 'expenses:food:lunch', -500), e('2024-01-10', 'expenses:food:dinner', -700), e('2024-02-01', 'expenses:rent', -10000), e('2024-01-20', 'income', 20000), e('2024-01-21', 'expenses:rent', 10000)];
t('基本解析', () => assert.deepStrictEqual(P()('2024-03-01,expenses:food,-12.50'), [e('2024-03-01', 'expenses:food', -1250)]));
t('略過空行與註解', () => assert.deepStrictEqual(P()('# 註解\\n\\n  2024-01-02,cash,5  \\n'), [e('2024-01-02', 'cash', 500)]));
t('金額換算沒有浮點誤差', () => assert.deepStrictEqual(P()('2024-01-01,a,0.29\\n2024-01-01,a,1.1').map((x) => x.cents), [29, 110]));
t('正號與一位小數', () => assert.deepStrictEqual(P()('2024-01-01,a,+3.1').map((x) => x.cents), [310]));
t('閏年 2 月 29 日有效', () => assert.strictEqual(P()('2024-02-29,a,1').length, 1));
t('不存在的日期要丟錯', () => assert.throws(() => P()('2023-02-29,a,1')));
t('錯誤訊息帶原始行號', () => assert.throws(() => P()('# x\\n\\n2024-01-01,a,1\\n2024-01-01,A,1'), /line 4/));
t('三位小數要丟錯', () => assert.throws(() => P()('2024-01-01,a,1.234')));
t('千分位要丟錯', () => assert.throws(() => P()('2024-01-01,a,1,000')));
t('空的帳戶段要丟錯', () => assert.throws(() => P()('2024-01-01,a::b,1')));
t('不給選項:原帳戶加總、排序、去掉 0', () => assert.deepStrictEqual(R()(sample()), [{ account: 'expenses:food:dinner', cents: -700 }, { account: 'expenses:food:lunch', cents: -500 }, { account: 'income', cents: 20000 }]));
t('截斷成兩段', () => assert.deepStrictEqual(R()(sample(), { depth: 2 }), [{ account: 'expenses:food', cents: -1200 }, { account: 'income', cents: 20000 }]));
t('截斷成一段', () => assert.deepStrictEqual(R()(sample(), { depth: 1 }), [{ account: 'expenses', cents: -1200 }, { account: 'income', cents: 20000 }]));
t('日期區間含頭尾', () => assert.deepStrictEqual(R()(sample(), { from: '2024-01-10', to: '2024-01-21', depth: 1 }), [{ account: 'expenses', cents: 9300 }, { account: 'income', cents: 20000 }]));
t('只給結束日', () => assert.deepStrictEqual(R()(sample(), { to: '2024-01-05' }), [{ account: 'expenses:food:lunch', cents: -500 }]));
t('空陣列', () => assert.deepStrictEqual(R()([]), []));
t('不修改輸入', () => { const input = sample(); const copy = JSON.parse(JSON.stringify(input)); R()(input, { depth: 1 }); assert.deepStrictEqual(input, copy); });
t('兩個模組串起來', () => assert.deepStrictEqual(R()(P()('2024-01-01,a:x,1.5\\n2024-01-02,a:y,-0.5'), { depth: 1 }), [{ account: 'a', cents: 100 }]));
`,
    reference: {
      'ledger/parse.js': `function parseLedger(text) {
  const out = [];
  String(text).split('\\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const fail = () => { throw new Error('invalid entry at line ' + (i + 1)); };
    const parts = line.split(',');
    if (parts.length !== 3) fail();
    const [date, account, amount] = parts;
    const d = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(date);
    if (!d) fail();
    const y = Number(d[1]), m = Number(d[2]), day = Number(d[3]);
    const dt = new Date(Date.UTC(y, m - 1, day));
    if (m < 1 || m > 12 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== day) fail();
    if (!/^[a-z0-9]+(?::[a-z0-9]+)*$/.test(account)) fail();
    const a = /^([+-]?)(\\d+)(?:\\.(\\d{1,2}))?$/.exec(amount);
    if (!a) fail();
    const cents = Number(a[2]) * 100 + Number((a[3] || '').padEnd(2, '0'));
    out.push({ date, account, cents: a[1] === '-' ? -cents : cents });
  });
  return out;
}
module.exports = { parseLedger };
`,
      'ledger/report.js': `function balances(entries, options) {
  const { from, to, depth } = options || {};
  const sums = new Map();
  for (const e of entries) {
    if (from && e.date < from) continue;
    if (to && e.date > to) continue;
    const key = depth ? e.account.split(':').slice(0, depth).join(':') : e.account;
    sums.set(key, (sums.get(key) || 0) + e.cents);
  }
  return [...sums].filter(([, c]) => c !== 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([account, cents]) => ({ account, cents }));
}
module.exports = { balances };
`,
    },
    // 浮點換算、不驗日期、沒有行號;彙總不去掉 0
    naive: {
      'ledger/parse.js': `function parseLedger(text) {
  return String(text).split('\\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
    const [date, account, amount] = l.split(',');
    if (!date || !account || isNaN(Number(amount))) throw new Error('invalid');
    return { date, account, cents: Number(amount) * 100 };
  });
}
module.exports = { parseLedger };
`,
      'ledger/report.js': `function balances(entries, options = {}) {
  const sums = {};
  for (const e of entries) {
    if (options.from && e.date < options.from) continue;
    if (options.to && e.date > options.to) continue;
    const key = options.depth ? e.account.split(':').slice(0, options.depth).join(':') : e.account;
    sums[key] = (sums[key] || 0) + e.cents;
  }
  return Object.keys(sums).sort().map((account) => ({ account, cents: sums[account] }));
}
module.exports = { balances };
`,
    },
  },
  {
    id: 'rooms',
    set: 'split',
    asks: '時段解析與會議室分配兩個模組:邊界時間與處理順序都要照規格',
    task: '建立兩個模組,都以 module.exports = { 名稱 } 匯出。\n\n'
      + '(一)rooms/time.js 匯出 parseSlot(text):把「Mon 09:30-11:00」這類字串轉成 { day, start, end }。'
      + 'day 為 Mon、Tue、Wed、Thu、Fri 之一(大小寫須完全相同),依序轉成 0 到 4。'
      + '時間一律是兩位數的 HH:MM(24 小時制,分為 00–59),start、end 是從當天 00:00 起算的分鐘數;00:00–23:59 都可當開始或結束,另外 24:00 只能當結束時間。'
      + 'end 必須大於 start。前後空白忽略;星期與時間之間恰好一個空白;時間中間的連字號前後不可有空白。其他任何格式一律丟出 Error。\n\n'
      + '(二)rooms/assign.js 匯出 assignRooms(meetings, rooms):meetings 是 [{ id, slot, size }](slot 是 parseSlot 的回傳值,id 為不重複的字串,size 為正整數),rooms 是 [{ name, capacity }](name 不重複)。'
      + '把每場會議排進一間 capacity >= size 的會議室;同一間會議室同一天的會議不可重疊(前一場的 end 等於後一場的 start 不算重疊)。'
      + '依以下順序逐一處理會議:day 小的先,再來 start 早的先,再來 size 大的先,最後依 id 字串由小到大。'
      + '每場選目前可用的會議室中 capacity 最小的,capacity 相同選 name 字串較小的;沒有可用的會議室就是 null。'
      + '回傳物件,key 是會議 id,value 是會議室 name 或 null。不可修改傳入的陣列與物件。',
    parts: [
      '這次你只負責(一):建立 rooms/time.js。rooms/assign.js 由另一位成員負責,不要建立或修改它。',
      '這次你只負責(二):建立 rooms/assign.js。rooms/time.js 由另一位成員負責,不要建立或修改它;assign.js 只依上面寫的 slot 格式運作。',
    ],
    entry: 'rooms/time.js',
    tests: `
const S = () => M().parseSlot;
const A = () => require(require('path').join(require('path').dirname(ENTRY), 'assign.js')).assignRooms;
const slot = (day, start, end) => ({ day, start, end });
const rooms = () => [{ name: 'B', capacity: 10 }, { name: 'C', capacity: 4 }, { name: 'A', capacity: 4 }];
t('基本解析', () => assert.deepStrictEqual(S()('Mon 09:30-11:00'), slot(0, 570, 660)));
t('前後空白', () => assert.deepStrictEqual(S()('  Fri 08:00-09:15 '), slot(4, 480, 555)));
t('24:00 可以當結束', () => assert.deepStrictEqual(S()('Wed 23:00-24:00'), slot(2, 1380, 1440)));
t('超過 24:00 要丟錯', () => assert.throws(() => S()('Mon 09:00-24:30')));
t('週末要丟錯', () => assert.throws(() => S()('Sat 09:00-10:00')));
t('大小寫不同要丟錯', () => assert.throws(() => S()('mon 09:00-10:00')));
t('一位數小時要丟錯', () => assert.throws(() => S()('Mon 9:00-10:00')));
t('分鐘超出範圍要丟錯', () => assert.throws(() => S()('Mon 09:60-10:00')));
t('結束不晚於開始要丟錯', () => assert.throws(() => S()('Tue 10:00-10:00')));
t('連字號旁有空白要丟錯', () => assert.throws(() => S()('Tue 10:00 - 11:00')));
t('選容量最小、同容量選名字小的', () => assert.deepStrictEqual(A()([{ id: 'm1', slot: slot(0, 540, 600), size: 3 }], rooms()), { m1: 'A' }));
t('相接不算重疊', () => assert.deepStrictEqual(A()([{ id: 'm1', slot: slot(0, 540, 600), size: 3 }, { id: 'm2', slot: slot(0, 600, 660), size: 3 }], rooms()), { m1: 'A', m2: 'A' }));
t('重疊就換下一間', () => assert.deepStrictEqual(A()([{ id: 'm1', slot: slot(0, 540, 600), size: 3 }, { id: 'm2', slot: slot(0, 570, 630), size: 3 }], rooms()), { m1: 'A', m2: 'C' }));
t('同一時間大的先排', () => assert.deepStrictEqual(A()([{ id: 'm1', slot: slot(0, 540, 600), size: 2 }, { id: 'm2', slot: slot(0, 540, 600), size: 5 }], [{ name: 'X', capacity: 10 }]), { m1: null, m2: 'X' }));
t('開始早的先排', () => assert.deepStrictEqual(A()([{ id: 'a', slot: slot(0, 600, 660), size: 2 }, { id: 'b', slot: slot(0, 540, 620), size: 2 }], [{ name: 'X', capacity: 4 }]), { a: null, b: 'X' }));
t('不同天互不影響', () => assert.deepStrictEqual(A()([{ id: 'm1', slot: slot(1, 540, 600), size: 2 }, { id: 'm2', slot: slot(0, 540, 600), size: 2 }], [{ name: 'X', capacity: 4 }]), { m1: 'X', m2: 'X' }));
t('容量不足是 null', () => assert.deepStrictEqual(A()([{ id: 'm1', slot: slot(0, 540, 600), size: 20 }], rooms()), { m1: null }));
t('不修改輸入', () => {
  const meetings = [{ id: 'b', slot: slot(0, 540, 600), size: 2 }, { id: 'a', slot: slot(0, 540, 600), size: 2 }];
  const list = rooms();
  const copy = JSON.parse(JSON.stringify([meetings, list]));
  A()(meetings, list);
  assert.deepStrictEqual([meetings, list], copy);
});
t('兩個模組串起來', () => assert.deepStrictEqual(A()([{ id: 'x', slot: S()('Tue 13:00-14:00'), size: 4 }, { id: 'y', slot: S()('Tue 13:30-15:00'), size: 4 }], rooms()), { x: 'A', y: 'C' }));
`,
    reference: {
      'rooms/time.js': `const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
function minutes(h, m, isEnd) {
  const H = Number(h), Mi = Number(m);
  if (Mi > 59) throw new Error('invalid minute');
  if (H === 24 && Mi === 0 && isEnd) return 1440;
  if (H > 23) throw new Error('invalid hour');
  return H * 60 + Mi;
}
function parseSlot(text) {
  const m = /^(Mon|Tue|Wed|Thu|Fri) (\\d{2}):(\\d{2})-(\\d{2}):(\\d{2})$/.exec(String(text).trim());
  if (!m) throw new Error('invalid slot');
  const start = minutes(m[2], m[3], false), end = minutes(m[4], m[5], true);
  if (end <= start) throw new Error('end must be after start');
  return { day: DAYS.indexOf(m[1]), start, end };
}
module.exports = { parseSlot };
`,
      'rooms/assign.js': `const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function assignRooms(meetings, rooms) {
  const order = [...meetings].sort((a, b) => a.slot.day - b.slot.day || a.slot.start - b.slot.start || b.size - a.size || cmp(a.id, b.id));
  const byRoom = [...rooms].sort((a, b) => a.capacity - b.capacity || cmp(a.name, b.name));
  const booked = new Map(rooms.map((r) => [r.name, []]));
  const out = {};
  for (const m of order) {
    const room = byRoom.find((r) => r.capacity >= m.size && booked.get(r.name).every((s) => s.day !== m.slot.day || s.end <= m.slot.start || m.slot.end <= s.start));
    out[m.id] = room ? room.name : null;
    if (room) booked.get(room.name).push(m.slot);
  }
  return out;
}
module.exports = { assignRooms };
`,
    },
    // 不驗格式;照輸入順序、選第一間放得下的
    naive: {
      'rooms/time.js': `function parseSlot(text) {
  const [d, range] = String(text).trim().split(' ');
  const [a, b] = range.split('-').map((x) => { const [h, m] = x.split(':').map(Number); return h * 60 + m; });
  return { day: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].indexOf(d), start: a, end: b };
}
module.exports = { parseSlot };
`,
      'rooms/assign.js': `function assignRooms(meetings, rooms) {
  const used = {};
  const out = {};
  for (const m of meetings) {
    const room = rooms.find((r) => r.capacity >= m.size && !(used[r.name] || []).some((s) => s.day === m.slot.day && s.start < m.slot.end && m.slot.start < s.end));
    out[m.id] = room ? room.name : null;
    if (room) (used[room.name] = used[room.name] || []).push(m.slot);
  }
  return out;
}
module.exports = { assignRooms };
`,
    },
  },
];
