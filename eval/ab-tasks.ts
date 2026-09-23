// 單人 vs 圓桌對照實驗的題目。每題都有「隱藏測試」:模型看不到,跑完才拿來量它做對了幾項。
//
// 匯出方式一律寫成 module.exports = { 名稱 }:第一版只寫「以 module.exports 匯出」,
// 模型把函式本身指定給 module.exports 也是合理的讀法,結果邏輯全對卻 0 分——量到的是題目的歧義。
//
// 選題原則:對 27B 級的本機模型有一定難度(有邊界條件、或有不只一個錯),
// 否則兩邊都滿分,量不出差別。每題附一份參考解(測試必須全過)與一份常見的錯解
// (必須至少錯一項),由 test/eval.test.ts 檢查,確保測試本身是對的。

export interface AbTask {
  id: string;
  // basic:第一批題目,對 27B 本機模型偏容易(單人約八成全對);hard:用來拉開差距的難題;split:可拆成兩個模組
  set: 'basic' | 'hard' | 'split';
  asks: string;
  task: string;
  // 平行分工 / 接力時,兩位成員各自拿到 task 加上這一段
  parts?: [string, string];
  // 任務開始前就在工作目錄裡的檔案
  files?: Record<string, string>;
  // 要測的模組(相對工作目錄)
  entry: string;
  // 測試本體:用 t(名稱, () => { ... }) 定義,M() 取得模組、assert 可直接用
  tests: string;
  reference: Record<string, string>;
  naive: Record<string, string>;
}

import { EXERCISM_TASKS } from './ab-tasks-exercism';

const OWN_TASKS: AbTask[] = [
  {
    id: 'semver',
    set: 'basic',
    asks: '規格細節多(預發布版本的比較規則),容易漏掉幾條',
    task: '建立 semver.js,以 module.exports = { compare } 匯出 compare(a, b):依 Semantic Versioning 2.0.0 比較兩個版本字串,a < b 回傳 -1,相等回傳 0,a > b 回傳 1。要支援預發布版本(例如 1.0.0-alpha.1);建置中繼資料(+ 之後的部分)不影響比較。',
    entry: 'semver.js',
    tests: `
t('主版本', () => assert.strictEqual(M().compare('1.0.0', '2.0.0'), -1));
t('次版本以數字比較', () => assert.strictEqual(M().compare('1.10.0', '1.9.0'), 1));
t('修訂版', () => assert.strictEqual(M().compare('2.1.0', '2.0.9'), 1));
t('相等', () => assert.strictEqual(M().compare('3.4.5', '3.4.5'), 0));
t('預發布小於正式版', () => assert.strictEqual(M().compare('1.0.0-alpha', '1.0.0'), -1));
t('預發布的數字欄位以數字比較', () => assert.strictEqual(M().compare('1.0.0-alpha.2', '1.0.0-alpha.10'), -1));
t('英數欄位大於數字欄位', () => assert.strictEqual(M().compare('1.0.0-alpha.beta', '1.0.0-alpha.1'), 1));
t('欄位較少的較小', () => assert.strictEqual(M().compare('1.0.0-alpha', '1.0.0-alpha.1'), -1));
t('英數欄位依字典序', () => assert.strictEqual(M().compare('1.0.0-rc.1', '1.0.0-beta.11'), 1));
t('建置中繼資料不影響', () => assert.strictEqual(M().compare('1.0.0+build.1', '1.0.0+build.2'), 0));
`,
    reference: {
      'semver.js': `function parse(v) {
  const core = v.split('+')[0];
  const i = core.indexOf('-');
  const main = i < 0 ? core : core.slice(0, i);
  return { nums: main.split('.').map(Number), pre: i < 0 ? [] : core.slice(i + 1).split('.') };
}
function cmpId(a, b) {
  const na = /^\\d+$/.test(a), nb = /^\\d+$/.test(b);
  if (na && nb) return Math.sign(Number(a) - Number(b));
  if (na) return -1;
  if (nb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
function compare(a, b) {
  const A = parse(a), B = parse(b);
  for (let i = 0; i < 3; i++) if (A.nums[i] !== B.nums[i]) return A.nums[i] < B.nums[i] ? -1 : 1;
  if (!A.pre.length && !B.pre.length) return 0;
  if (!A.pre.length) return 1;
  if (!B.pre.length) return -1;
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    if (i >= A.pre.length) return -1;
    if (i >= B.pre.length) return 1;
    const c = cmpId(A.pre[i], B.pre[i]);
    if (c) return c;
  }
  return 0;
}
module.exports = { compare };
`,
    },
    naive: {
      'semver.js': `function compare(a, b) {
  const x = a.split('-')[0].split('.').map(Number), y = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
module.exports = { compare };
`,
    },
  },
  {
    id: 'intervals',
    set: 'basic',
    asks: '相接要合併、不能改到輸入:兩個容易忽略的要求',
    task: '建立 intervals.js,以 module.exports = { merge } 匯出 merge(list):list 是 [start, end] 的陣列(start <= end,整數,順序不定),回傳合併重疊或相接的區間後、依 start 由小到大排序的新陣列。[1, 2] 與 [2, 3] 相接,要合併成 [1, 3];[1, 2] 與 [3, 4] 不相接,不合併。不可以修改傳入的陣列,也不可以修改其中的區間。',
    entry: 'intervals.js',
    tests: `
t('空陣列', () => assert.deepStrictEqual(M().merge([]), []));
t('順序不定', () => assert.deepStrictEqual(M().merge([[5, 6], [1, 2]]), [[1, 2], [5, 6]]));
t('重疊合併', () => assert.deepStrictEqual(M().merge([[1, 4], [2, 5]]), [[1, 5]]));
t('相接合併', () => assert.deepStrictEqual(M().merge([[1, 2], [2, 3]]), [[1, 3]]));
t('不相接不合併', () => assert.deepStrictEqual(M().merge([[1, 2], [3, 4]]), [[1, 2], [3, 4]]));
t('包含', () => assert.deepStrictEqual(M().merge([[1, 10], [2, 3], [4, 12]]), [[1, 12]]));
t('不修改輸入', () => {
  const input = [[3, 5], [1, 4], [8, 9]];
  const copy = JSON.parse(JSON.stringify(input));
  M().merge(input);
  assert.deepStrictEqual(input, copy);
});
`,
    reference: {
      'intervals.js': `function merge(list) {
  const s = list.map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
module.exports = { merge };
`,
    },
    naive: {
      'intervals.js': `function merge(list) {
  list.sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const iv of list) {
    const last = out[out.length - 1];
    if (last && iv[0] < last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push(iv);
  }
  return out;
}
module.exports = { merge };
`,
    },
  },
  {
    id: 'duration',
    set: 'basic',
    asks: '要拒絕的輸入比要接受的多:驗證常被寫得太寬',
    task: '建立 duration.js,以 module.exports = { parse } 匯出 parse(text):把「1h30m」「45s」「2h5s」這類字串轉成秒數。單位只有 h、m、s,每種最多出現一次,必須依 h、m、s 的順序;數字是非負整數。以下情況一律丟出 Error:空字串、未知單位、順序錯誤、重複的單位、沒有數字的單位、小數。前後可以有空白,中間不可以有空白。',
    entry: 'duration.js',
    tests: `
const bad = (s) => assert.throws(() => M().parse(s));
t('時分', () => assert.strictEqual(M().parse('1h30m'), 5400));
t('只有秒', () => assert.strictEqual(M().parse('45s'), 45));
t('時秒', () => assert.strictEqual(M().parse('2h5s'), 7205));
t('前後空白', () => assert.strictEqual(M().parse(' 10m '), 600));
t('零', () => assert.strictEqual(M().parse('0s'), 0));
t('空字串要丟錯', () => bad(''));
t('未知單位要丟錯', () => bad('5x'));
t('順序錯誤要丟錯', () => bad('30m1h'));
t('重複單位要丟錯', () => bad('1h1h'));
t('沒有數字要丟錯', () => bad('h'));
t('中間空白要丟錯', () => bad('1h 30m'));
t('小數要丟錯', () => bad('1.5h'));
`,
    reference: {
      'duration.js': `function parse(text) {
  const s = String(text).trim();
  const m = /^(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?$/.exec(s);
  if (!s || !m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) throw new Error('invalid duration');
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}
module.exports = { parse };
`,
    },
    naive: {
      'duration.js': `function parse(text) {
  let t = 0;
  for (const [, n, u] of String(text).matchAll(/(\\d+)([hms])/g)) t += Number(n) * { h: 3600, m: 60, s: 1 }[u];
  return t;
}
module.exports = { parse };
`,
    },
  },
  {
    id: 'cart-bugs',
    set: 'basic',
    asks: '使用者只回報一個症狀,檔案裡其實有三個錯:只修被點名的那個就不算完成',
    task: 'cart.js 的 total 算出來的金額不對,使用者回報「用折扣碼之後金額怪怪的」。請依檔案開頭註解寫的規則修正 total。',
    files: {
      'cart.js': `// 計算購物車總額。
// items:[{ price, qty }];coupon:{ type: 'percent', value }、{ type: 'fixed', value } 或 null
// 規則:先算所有品項的小計;percent 打 value% 的折扣(value 為 20 代表便宜 20%);
// fixed 直接折 value 元;總額最低為 0;結果四捨五入到小數兩位。
function total(items, coupon) {
  let sum = 0;
  for (let i = 1; i < items.length; i++) sum += items[i].price * items[i].qty;
  if (coupon && coupon.type === 'percent') sum = sum * coupon.value / 100;
  if (coupon && coupon.type === 'fixed') sum -= coupon.value;
  return Math.round(sum * 100) / 100;
}

module.exports = { total };
`,
    },
    entry: 'cart.js',
    tests: `
const items = [{ price: 10, qty: 2 }, { price: 5, qty: 1 }];
t('沒有折扣碼', () => assert.strictEqual(M().total(items, null), 25));
t('只有一個品項', () => assert.strictEqual(M().total([{ price: 7, qty: 1 }], null), 7));
t('百分比折扣', () => assert.strictEqual(M().total(items, { type: 'percent', value: 20 }), 20));
t('固定折扣', () => assert.strictEqual(M().total(items, { type: 'fixed', value: 5 }), 20));
t('總額最低為 0', () => assert.strictEqual(M().total(items, { type: 'fixed', value: 100 }), 0));
t('四捨五入到兩位', () => assert.strictEqual(M().total([{ price: 0.1, qty: 3 }], null), 0.3));
`,
    reference: {
      'cart.js': `function total(items, coupon) {
  let sum = 0;
  for (const it of items) sum += it.price * it.qty;
  if (coupon && coupon.type === 'percent') sum = sum * (100 - coupon.value) / 100;
  if (coupon && coupon.type === 'fixed') sum -= coupon.value;
  sum = Math.max(0, sum);
  return Math.round(sum * 100) / 100;
}
module.exports = { total };
`,
    },
    // 只修了使用者點名的百分比折扣
    naive: {
      'cart.js': `function total(items, coupon) {
  let sum = 0;
  for (let i = 1; i < items.length; i++) sum += items[i].price * items[i].qty;
  if (coupon && coupon.type === 'percent') sum = sum * (100 - coupon.value) / 100;
  if (coupon && coupon.type === 'fixed') sum -= coupon.value;
  return Math.round(sum * 100) / 100;
}
module.exports = { total };
`,
    },
  },
  {
    id: 'csv',
    set: 'basic',
    asks: '引號、跳脫的引號、空欄位:看起來簡單、邊界很多',
    task: '建立 csv.js,以 module.exports = { parseLine } 匯出 parseLine(line):依 RFC 4180 解析一行 CSV,回傳欄位字串的陣列。欄位可以用雙引號包住;引號內可以有逗號;引號內連續兩個雙引號代表一個雙引號字元。空欄位回傳空字串。',
    entry: 'csv.js',
    tests: `
t('一般', () => assert.deepStrictEqual(M().parseLine('a,b,c'), ['a', 'b', 'c']));
t('空欄位', () => assert.deepStrictEqual(M().parseLine('a,,c'), ['a', '', 'c']));
t('引號內的逗號', () => assert.deepStrictEqual(M().parseLine('"a,b",c'), ['a,b', 'c']));
t('跳脫的引號', () => assert.deepStrictEqual(M().parseLine('"say ""hi""",x'), ['say "hi"', 'x']));
t('空字串是一個空欄位', () => assert.deepStrictEqual(M().parseLine(''), ['']));
t('結尾逗號', () => assert.deepStrictEqual(M().parseLine('a,'), ['a', '']));
t('空的引號欄位', () => assert.deepStrictEqual(M().parseLine('"",x'), ['', 'x']));
`,
    reference: {
      'csv.js': `function parseLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}
module.exports = { parseLine };
`,
    },
    naive: {
      'csv.js': `function parseLine(line) {
  return line.split(',').map((s) => s.replace(/^"|"$/g, ''));
}
module.exports = { parseLine };
`,
    },
  },
  // ---------- 難題:單人預期大約一半做得對,差距才量得出來 ----------
  {
    id: 'cron',
    set: 'hard',
    asks: '規則多又有經典陷阱(日與星期同時有限制時是「或」)',
    task: '建立 cron.js,以 module.exports = { matches } 匯出 matches(expr, date):expr 是 5 個欄位的 cron 字串(依序是分、時、日、月、星期,以空白分隔),date 是 JavaScript 的 Date(用本機時間:getMinutes、getHours、getDate、getMonth() + 1、getDay()),回傳這個時間是否符合 expr。每個欄位支援:*、單一數字、逗號清單(例如 1,5,10)、範圍(例如 1-5)、步進(例如 */15 或 10-30/5)。各欄位的範圍:分 0-59、時 0-23、日 1-31、月 1-12、星期 0-7(0 和 7 都代表星期日)。依標準 cron 規則:日與星期兩個欄位都不是單獨的 * 時,符合其中一個就算符合;只要其中一個是單獨的 *,就要兩個都符合(* 一定符合)。格式錯誤(欄位數不是 5、數字超出範圍、步進為 0、無法解析)一律丟出 Error。',
    entry: 'cron.js',
    tests: `
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi);
const mon = at(2024, 1, 15, 10, 30); // 2024-01-15 是星期一
const bad = (e) => assert.throws(() => M().matches(e, mon));
t('全是星號', () => assert.strictEqual(M().matches('* * * * *', mon), true));
t('分時符合', () => assert.strictEqual(M().matches('30 10 * * *', mon), true));
t('分不符合', () => assert.strictEqual(M().matches('31 10 * * *', mon), false));
t('步進符合', () => assert.strictEqual(M().matches('*/15 * * * *', mon), true));
t('步進不符合', () => assert.strictEqual(M().matches('*/15 * * * *', at(2024, 1, 15, 10, 31)), false));
t('範圍加步進', () => assert.strictEqual(M().matches('10-40/10 * * * *', mon), true));
t('範圍加步進的間隔', () => assert.strictEqual(M().matches('10-40/10 * * * *', at(2024, 1, 15, 10, 35)), false));
t('範圍加步進的上限', () => assert.strictEqual(M().matches('10-40/10 * * * *', at(2024, 1, 15, 10, 50)), false));
t('清單', () => assert.strictEqual(M().matches('0,30 9-11 * * *', mon), true));
t('月份', () => assert.strictEqual(M().matches('* * * 2 *', mon), false));
t('星期', () => assert.strictEqual(M().matches('* * * * 1', mon), true));
t('星期日寫 0', () => assert.strictEqual(M().matches('* * * * 0', at(2024, 1, 14, 8, 0)), true));
t('星期日寫 7', () => assert.strictEqual(M().matches('* * * * 7', at(2024, 1, 14, 8, 0)), true));
t('日與星期都有限制:星期符合就算', () => assert.strictEqual(M().matches('* * 1 * 1', mon), true));
t('日與星期都有限制:日符合就算', () => assert.strictEqual(M().matches('* * 1 * 1', at(2024, 2, 1, 0, 0)), true));
t('日與星期都有限制:都不符合', () => assert.strictEqual(M().matches('* * 1 * 1', at(2024, 1, 16, 0, 0)), false));
t('星期是星號:只看日', () => assert.strictEqual(M().matches('* * 16 * *', mon), false));
t('日是星號:只看星期', () => assert.strictEqual(M().matches('* * * * 2', mon), false));
t('欄位數不對要丟錯', () => bad('* * * *'));
t('分超出範圍要丟錯', () => bad('60 * * * *'));
t('月超出範圍要丟錯', () => bad('* * * 13 *'));
t('無法解析要丟錯', () => bad('a * * * *'));
t('步進為 0 要丟錯', () => bad('*/0 * * * *'));
`,
    reference: {
      'cron.js': `const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
function field(text, [lo, hi]) {
  const set = new Set();
  for (const part of text.split(',')) {
    const m = /^(\\*|\\d+(?:-\\d+)?)(?:\\/(\\d+))?$/.exec(part);
    if (!m) throw new Error('bad field: ' + text);
    let a, b;
    if (m[1] === '*') { a = lo; b = hi; } else {
      const r = m[1].split('-').map(Number);
      a = r[0];
      b = r.length > 1 ? r[1] : (m[2] !== undefined ? hi : r[0]);
    }
    const step = m[2] !== undefined ? Number(m[2]) : 1;
    if (step < 1 || a < lo || b > hi || a > b) throw new Error('bad field: ' + text);
    for (let x = a; x <= b; x += step) set.add(x);
  }
  return set;
}
function matches(expr, date) {
  const f = String(expr).trim().split(/\\s+/);
  if (f.length !== 5) throw new Error('need 5 fields');
  const [mi, h, dom, mo, dow] = f.map((x, i) => field(x, RANGES[i]));
  if (dow.has(7)) dow.add(0);
  if (!mi.has(date.getMinutes()) || !h.has(date.getHours()) || !mo.has(date.getMonth() + 1)) return false;
  const d = dom.has(date.getDate()), w = dow.has(date.getDay());
  return f[2] !== '*' && f[4] !== '*' ? d || w : d && w;
}
module.exports = { matches };
`,
    },
    // 日與星期一律用「且」,不驗證範圍
    naive: {
      'cron.js': `function field(text, v) {
  if (text === '*') return true;
  return text.split(',').some((p) => {
    const [r, s] = p.split('/');
    const step = Number(s || 1);
    const [a, b] = r === '*' ? [0, 99] : r.includes('-') ? r.split('-').map(Number) : [Number(r), s ? 99 : Number(r)];
    return v >= a && v <= b && (v - a) % step === 0;
  });
}
function matches(expr, date) {
  const f = expr.trim().split(/\\s+/);
  return field(f[0], date.getMinutes()) && field(f[1], date.getHours()) && field(f[2], date.getDate()) && field(f[3], date.getMonth() + 1) && field(f[4], date.getDay());
}
module.exports = { matches };
`,
    },
  },
  {
    id: 'pathnorm',
    set: 'hard',
    asks: '邊界情況很多(根目錄的 ..、相對路徑開頭的 ..、結尾斜線、空結果),而且不能直接用 path 模組',
    task: '建立 pathnorm.js,以 module.exports = { normalize } 匯出 normalize(p):正規化 POSIX 路徑,只做字串處理,不碰檔案系統,也不可以使用 Node 的 path 模組。規則:連續的斜線合成一個;去掉 . 這一段;.. 會抵銷前一段;絕對路徑(以 / 開頭)在根目錄遇到 .. 就停在根目錄;相對路徑開頭無法抵銷的 .. 要保留;處理完是空的話,絕對路徑回傳 /,相對路徑回傳 .;輸入以斜線結尾、而且結果不是 / 時,結果也要以斜線結尾。',
    entry: 'pathnorm.js',
    tests: `
const n = (p) => M().normalize(p);
t('上一層', () => assert.strictEqual(n('/a/b/../c'), '/a/c'));
t('連續斜線', () => assert.strictEqual(n('a//b///c'), 'a/b/c'));
t('點', () => assert.strictEqual(n('./a/./b'), 'a/b'));
t('根目錄的上一層', () => assert.strictEqual(n('/../a'), '/a'));
t('相對路徑開頭的上一層要保留', () => assert.strictEqual(n('../../a'), '../../a'));
t('抵銷後再往上', () => assert.strictEqual(n('a/../..'), '..'));
t('全部抵銷', () => assert.strictEqual(n('a/..'), '.'));
t('空字串', () => assert.strictEqual(n(''), '.'));
t('根目錄', () => assert.strictEqual(n('/'), '/'));
t('結尾斜線', () => assert.strictEqual(n('a/b/'), 'a/b/'));
t('絕對路徑全部抵銷', () => assert.strictEqual(n('/a/..'), '/'));
t('結尾斜線加上一層', () => assert.strictEqual(n('a/../../b/'), '../b/'));
t('混合', () => assert.strictEqual(n('/a/./b/../../c/'), '/c/'));
t('只有點加斜線', () => assert.strictEqual(n('./'), './'));
t('不使用 path 模組', () => assert.ok(!/require\\(\\s*['"](node:)?path['"]\\s*\\)|from\\s+['"](node:)?path['"]/.test(fs.readFileSync(ENTRY, 'utf8'))));
`,
    reference: {
      'pathnorm.js': `function normalize(p) {
  const abs = p.startsWith('/');
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
    } else out.push(seg);
  }
  let r = (abs ? '/' : '') + out.join('/');
  if (!r) r = '.';
  if (p.endsWith('/') && r !== '/') r += '/';
  return r;
}
module.exports = { normalize };
`,
    },
    // 開頭的 .. 被丟掉、空結果回傳空字串
    naive: {
      'pathnorm.js': `function normalize(p) {
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return (p.startsWith('/') ? '/' : '') + out.join('/');
}
module.exports = { normalize };
`,
    },
  },
  {
    id: 'roman',
    set: 'hard',
    asks: '轉換本身不難,難在「只接受標準寫法」的驗證',
    task: '建立 roman.js,以 module.exports = { toRoman, fromRoman } 匯出兩個函式:toRoman(n) 把 1 到 3999 的整數轉成標準的羅馬數字(例如 1994 → MCMXCIV),範圍外或不是整數丟出 Error;fromRoman(s) 把標準的羅馬數字轉回整數,只接受標準寫法:全部大寫,不接受 IIII、VV、IC、XM、MCMC 這類非標準寫法,也不接受空字串,不合法一律丟出 Error。',
    entry: 'roman.js',
    tests: `
const bad = (s) => assert.throws(() => M().fromRoman(s));
t('一般', () => assert.strictEqual(M().toRoman(1994), 'MCMXCIV'));
t('上限', () => assert.strictEqual(M().toRoman(3999), 'MMMCMXCIX'));
t('減法寫法', () => assert.strictEqual(M().toRoman(4), 'IV'));
t('零要丟錯', () => assert.throws(() => M().toRoman(0)));
t('超過上限要丟錯', () => assert.throws(() => M().toRoman(4000)));
t('小數要丟錯', () => assert.throws(() => M().toRoman(1.5)));
t('轉回整數', () => assert.strictEqual(M().fromRoman('MCMXCIV'), 1994));
t('轉回上限', () => assert.strictEqual(M().fromRoman('MMMCMXCIX'), 3999));
t('來回一致', () => { for (let i = 1; i < 4000; i += 37) assert.strictEqual(M().fromRoman(M().toRoman(i)), i); });
t('IIII 要丟錯', () => bad('IIII'));
t('VV 要丟錯', () => bad('VV'));
t('IC 要丟錯', () => bad('IC'));
t('XM 要丟錯', () => bad('XM'));
t('MCMC 要丟錯', () => bad('MCMC'));
t('空字串要丟錯', () => bad(''));
t('小寫要丟錯', () => bad('iv'));
t('IXIX 要丟錯', () => bad('IXIX'));
`,
    reference: {
      'roman.js': `const T = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
function toRoman(n) {
  if (!Number.isInteger(n) || n < 1 || n > 3999) throw new Error('out of range');
  let s = '';
  for (const [v, r] of T) while (n >= v) { s += r; n -= v; }
  return s;
}
function fromRoman(s) {
  if (typeof s !== 'string' || !s || !/^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/.test(s)) throw new Error('not a standard roman numeral');
  const V = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let n = 0;
  for (let i = 0; i < s.length; i++) n += V[s[i]] < (V[s[i + 1]] || 0) ? -V[s[i]] : V[s[i]];
  return n;
}
module.exports = { toRoman, fromRoman };
`,
    },
    // 沒有驗證寫法
    naive: {
      'roman.js': `const T = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
function toRoman(n) {
  if (n < 1 || n > 3999) throw new Error('out of range');
  let s = '';
  for (const [v, r] of T) while (n >= v) { s += r; n -= v; }
  return s;
}
function fromRoman(s) {
  const V = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let n = 0;
  for (let i = 0; i < s.length; i++) n += V[s[i]] < (V[s[i + 1]] || 0) ? -V[s[i]] : V[s[i]];
  return n;
}
module.exports = { toRoman, fromRoman };
`,
    },
  },
  {
    id: 'lru-ttl',
    set: 'hard',
    asks: '好幾條互相牽動的規則:哪些動作算「使用」、過期的資料算不算數',
    task: '建立 lru.js,以 module.exports = { LRU } 匯出 class LRU。new LRU({ max, ttl, now }):max 是最多保留幾筆(正整數);ttl 是每筆資料的存活毫秒數,存入後經過 ttl 毫秒(含)就過期;now 是回傳目前時間(毫秒)的函式,測試會注入假時鐘。方法:set(key, value) 存入,已存在就覆寫、重新計算存活時間,並視為最近使用;get(key) 取值,不存在或已過期回傳 undefined,取到的話視為最近使用,但不延長存活時間;has(key) 回傳是否存在且未過期,不算使用;delete(key) 刪除;size 屬性回傳目前未過期的筆數。存入後超過 max 筆時,淘汰最久沒有使用的一筆;過期的資料不算在筆數裡,也不會讓還沒過期的資料被淘汰。',
    entry: 'lru.js',
    tests: `
const make = (max, ttl) => { const clock = { t: 0 }; return { c: new (M().LRU)({ max, ttl, now: () => clock.t }), clock }; };
t('存取', () => { const { c } = make(2, 1000); c.set('a', 1); assert.strictEqual(c.get('a'), 1); assert.strictEqual(c.get('x'), undefined); });
t('淘汰最久沒用的', () => { const { c } = make(2, 1000); c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3); assert.strictEqual(c.has('b'), false); assert.strictEqual(c.has('a'), true); assert.strictEqual(c.has('c'), true); });
t('覆寫算使用', () => { const { c } = make(2, 1000); c.set('a', 1); c.set('b', 2); c.set('a', 9); c.set('c', 3); assert.strictEqual(c.has('b'), false); assert.strictEqual(c.get('a'), 9); });
t('has 不算使用', () => { const { c } = make(2, 1000); c.set('a', 1); c.set('b', 2); c.has('a'); c.set('c', 3); assert.strictEqual(c.has('a'), false); });
t('到期前還在', () => { const { c, clock } = make(2, 100); c.set('a', 1); clock.t = 99; assert.strictEqual(c.get('a'), 1); });
t('剛好到期就過期', () => { const { c, clock } = make(2, 100); c.set('a', 1); clock.t = 100; assert.strictEqual(c.get('a'), undefined); assert.strictEqual(c.has('a'), false); });
t('get 不延長存活時間', () => { const { c, clock } = make(2, 100); c.set('a', 1); clock.t = 50; c.get('a'); clock.t = 100; assert.strictEqual(c.get('a'), undefined); });
t('覆寫重算存活時間', () => { const { c, clock } = make(2, 100); c.set('a', 1); clock.t = 80; c.set('a', 2); clock.t = 150; assert.strictEqual(c.get('a'), 2); });
t('size 不算過期的', () => { const { c, clock } = make(3, 100); c.set('a', 1); clock.t = 60; c.set('b', 2); clock.t = 120; assert.strictEqual(c.size, 1); });
t('過期的不會害別人被淘汰', () => { const { c, clock } = make(2, 100); c.set('a', 1); clock.t = 150; c.set('b', 2); c.set('c', 3); assert.strictEqual(c.has('b'), true); assert.strictEqual(c.has('c'), true); });
t('刪除', () => { const { c } = make(2, 1000); c.set('a', 1); c.delete('a'); assert.strictEqual(c.has('a'), false); assert.strictEqual(c.size, 0); });
`,
    reference: {
      'lru.js': `class LRU {
  constructor({ max, ttl, now }) { this.max = max; this.ttl = ttl; this.now = now || Date.now; this.m = new Map(); }
  alive(e) { return this.now() - e.t < this.ttl; }
  prune() { for (const [k, e] of this.m) if (!this.alive(e)) this.m.delete(k); }
  set(k, v) {
    this.m.delete(k);
    this.m.set(k, { v, t: this.now() });
    this.prune();
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value);
    return this;
  }
  get(k) {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (!this.alive(e)) { this.m.delete(k); return undefined; }
    this.m.delete(k);
    this.m.set(k, e);
    return e.v;
  }
  has(k) { const e = this.m.get(k); return !!e && this.alive(e); }
  delete(k) { return this.m.delete(k); }
  get size() { this.prune(); return this.m.size; }
}
module.exports = { LRU };
`,
    },
    // get 會延長存活時間、has 算使用、size 算進過期的
    naive: {
      'lru.js': `class LRU {
  constructor({ max, ttl, now }) { this.max = max; this.ttl = ttl; this.now = now; this.m = new Map(); }
  set(k, v) { this.m.delete(k); this.m.set(k, { v, t: this.now() }); if (this.m.size > this.max) this.m.delete(this.m.keys().next().value); }
  get(k) { const e = this.m.get(k); if (!e || this.now() - e.t >= this.ttl) return undefined; this.m.delete(k); e.t = this.now(); this.m.set(k, e); return e.v; }
  has(k) { const e = this.m.get(k); if (!e) return false; this.m.delete(k); this.m.set(k, e); return this.now() - e.t < this.ttl; }
  delete(k) { this.m.delete(k); }
  get size() { return this.m.size; }
}
module.exports = { LRU };
`,
    },
  },
];

import { SPLIT_TASKS } from './ab-tasks-split';

// 自己出的題目 + 從 Exercism 官方標準測資轉進來的題目(見 ab-tasks-exercism.ts)+ 可拆成兩個模組的題目
export const AB_TASKS: AbTask[] = [...OWN_TASKS, ...EXERCISM_TASKS, ...SPLIT_TASKS];
