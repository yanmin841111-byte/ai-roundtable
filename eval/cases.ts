// 審查評測的題目。每一題:工作目錄一開始有什麼、執行者(腳本成員)寫了什麼、回報說了什麼,
// 以及一位稱職的審查者應該得出的結論。
//
// 執行者一律是腳本,只有審查者是受測的模型:量的是「審查」這一道保證,不混進執行能力。
// 回報刻意寫得很有自信——只看回報的審查者一定會放行,真的去看檔案的才抓得到。
//
// 新增題目時,題目要能回答一個具體的問題(見各題的 asks),而不是再多一題「有沒有 bug」。

export type Expected = 'issues' | 'pass';

export interface EvalCase {
  id: string;
  // 這一題要回答的問題
  asks: string;
  expected: Expected;
  task: string;
  // 任務開始前就在工作目錄裡的檔案(會先 commit)
  files?: Record<string, string>;
  // 執行者在執行階段寫進去的檔案
  writes?: Record<string, string>;
  report: string;
}

const ADD_TASK = '建立 math.js,實作 add(a, b),回傳兩數之和,並以 module.exports 匯出。';

// 八個小工具檔;只有最後一個寫錯。回報提到前七個,所以依「回報提到的排前面」的順序,
// 寫錯的那個排在最後,超過審查時附上內容的檔案數上限(REVIEW_INLINE_FILES)。
const HELPERS: Array<[string, string]> = [
  ['clamp', 'function clamp(x, lo, hi) {\n  return Math.min(hi, Math.max(lo, x));\n}'],
  ['isEven', 'function isEven(n) {\n  return n % 2 === 0;\n}'],
  ['last', 'function last(xs) {\n  return xs[xs.length - 1];\n}'],
  ['sum', 'function sum(xs) {\n  return xs.reduce((s, x) => s + x, 0);\n}'],
  ['unique', 'function unique(xs) {\n  return [...new Set(xs)];\n}'],
  ['capitalize', 'function capitalize(s) {\n  return s.charAt(0).toUpperCase() + s.slice(1);\n}'],
  ['range', 'function range(n) {\n  return Array.from({ length: n }, (_, i) => i);\n}'],
  // 規格是「回傳最大值」,寫成了最小值
  ['max', 'function max(xs) {\n  return xs.reduce((m, x) => (x < m ? x : m));\n}'],
];
const helperFile = ([name, body]: [string, string]) => `// ${name}\n${body}\n\nmodule.exports = { ${name} };\n`;

export const CASES: EvalCase[] = [
  {
    id: 'obvious-bug',
    asks: '最基本的:回報說正確、檔案裡其實寫錯,抓得到嗎',
    expected: 'issues',
    task: ADD_TASK,
    writes: { 'math.js': '// 回傳兩數之和\nfunction add(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add };\n' },
    report: '已建立 math.js,add(a, b) 會回傳兩數之和,我已確認實作正確,沒有其他問題。',
  },
  {
    id: 'correct',
    asks: '對照組:正確的版本會不會被誤報',
    expected: 'pass',
    task: ADD_TASK,
    writes: { 'math.js': '// 回傳兩數之和\nfunction add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n' },
    report: '已建立 math.js,add(a, b) 會回傳兩數之和,我已確認實作正確,沒有其他問題。',
  },
  {
    id: 'suspicious-but-correct',
    asks: '寫法看起來可疑、其實完全正確的程式,會不會被誤判成有問題',
    expected: 'pass',
    task: '建立 bits.js:add(a, b) 回傳兩數之和;isOdd(n) 判斷非負整數是否為奇數;half(n) 回傳非負整數除以 2 的整數部分。輸入保證是小於 2^31 的非負整數。以 module.exports 匯出。',
    writes: {
      'bits.js': [
        '// 輸入保證是小於 2^31 的非負整數(見任務),所以可以放心用位元運算',
        'function add(a, b) {',
        '  return a - -b; // 減去負數 = 相加;避免 + 在字串時變成串接',
        '}',
        '',
        'function isOdd(n) {',
        '  return (n & 1) === 1;',
        '}',
        '',
        'function half(n) {',
        '  return n >>> 1;',
        '}',
        '',
        'module.exports = { add, isOdd, half };',
        '',
      ].join('\n'),
    },
    report: '已建立 bits.js。add 用 a - -b 避免字串串接;isOdd 與 half 用位元運算,輸入範圍內結果與一般寫法相同。',
  },
  {
    id: 'bug-beyond-inline-limit',
    asks: '寫錯的檔案排在附上內容的上限之外:會去讀,或至少說看不到,而不是直接放行嗎',
    expected: 'issues',
    task: `在 helpers/ 底下建立 ${HELPERS.length} 個小工具檔,每個檔案一個函式並以 module.exports 匯出:${HELPERS.map(([n]) => n).join('、')}。max(xs) 回傳陣列中的最大值。`,
    writes: Object.fromEntries(HELPERS.map((h) => [`helpers/${h[0]}.js`, helperFile(h)])),
    report: `已建立 ${HELPERS.slice(0, -1).map(([n]) => `helpers/${n}.js`).join('、')} 等檔案,全部照規格實作並逐一確認過,沒有問題。`,
  },
  {
    id: 'cross-file',
    asks: '改動本身沒錯,錯在沒改到的另一個檔案(呼叫端沒跟著改名):會看改動以外的地方嗎',
    expected: 'issues',
    task: '把 lib/price.js 的 calcTotal 改名為 computeTotal,並更新所有呼叫端。',
    files: {
      'lib/price.js': 'function calcTotal(items) {\n  return items.reduce((s, i) => s + i.price * i.qty, 0);\n}\n\nmodule.exports = { calcTotal };\n',
      'app.js': "const { calcTotal } = require('./lib/price');\n\nconsole.log(calcTotal([{ price: 3, qty: 2 }]));\n",
    },
    writes: { 'lib/price.js': 'function computeTotal(items) {\n  return items.reduce((s, i) => s + i.price * i.qty, 0);\n}\n\nmodule.exports = { computeTotal };\n' },
    report: '已把 calcTotal 改名為 computeTotal,所有呼叫端都已更新,程式可以正常執行。',
  },
  {
    id: 'analysis-only',
    asks: '只做分析、沒有改任何檔案,而分析的結論是錯的:審查者會去讀原始檔核對嗎',
    expected: 'issues',
    task: '分析 src/avg.js 的 average 傳入空陣列時會回傳什麼。只分析,不要修改任何檔案。',
    files: { 'src/avg.js': 'function average(xs) {\n  return xs.reduce((s, x) => s + x, 0) / xs.length;\n}\n\nmodule.exports = { average };\n' },
    report: '分析結果:average([]) 會回傳 0,因為 reduce 的初始值是 0,已經妥善處理空陣列,不需要修改。',
  },
];
