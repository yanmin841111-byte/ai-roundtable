// 從 Exercism 官方標準測資(MIT)長出來的題目。測資不是我們寫的,邊界案例是社群累積的,
// 難度也經過很多人校準——自己出題時「我對規格的誤解同時進到題目與測試」的風險在這裡不存在。
// 測資更新方式見 eval/import-exercism.ts;跑實驗時讀的是版控裡的 JSON,離線可重現。
import fs from 'fs';
import path from 'path';
import type { AbTask } from './ab-tasks';

interface Case { description: string; property: string; input: Record<string, unknown>; expected: unknown }

const DATA: Record<string, { source: string; cases: Case[] }> =
  JSON.parse(fs.readFileSync(path.join(__dirname, 'exercism-data.json'), 'utf8'));

// 把標準測資轉成隱藏測試。args 指定輸入欄位的順序(標準測資是物件,函式是位置參數)。
// 有些題目的測資含多個 property(例如 forth 另有一個 evaluateBoth),只取指定的那一個。
function testsFrom(id: string, fn: string, args: string[]): string {
  const cases = DATA[id].cases.filter((c) => c.property === fn);
  if (!cases.length) throw new Error(`${id}:沒有案例`);
  return cases.map((c) => {
    const call = `M().${fn}(${args.map((a) => JSON.stringify(c.input[a])).join(', ')})`;
    const expected = c.expected as any;
    const body = expected && typeof expected === 'object' && 'error' in expected
      ? `assert.throws(() => ${call})`
      : `assert.deepStrictEqual(${call}, ${JSON.stringify(expected)})`;
    return `t(${JSON.stringify(c.description)}, () => ${body});`;
  }).join('\n');
}

export const EXERCISM_TASKS: AbTask[] = [
  {
    id: 'book-store',
    set: 'hard',
    asks: '貪心分組會漏掉「5+3 拆成 4+4 更便宜」那一步,而且只有少數幾個購物籃看得出來',
    task: '建立 book-store.js,以 module.exports = { total } 匯出 total(basket):basket 是陣列,每個元素是 1 到 5 的整數,代表買了系列中的第幾本書(可以重複)。單本售價 800(單位是分)。同一組裡書本各不相同時有折扣:2 本不同打 95 折、3 本不同打 9 折、4 本不同打 8 折、5 本不同打 75 折;同一本書不能放進同一組兩次。把整籃書分成幾組,回傳「所有分法之中最便宜的那個總價」,單位是分,必須是整數。空陣列回傳 0。不可使用任何外部套件。',
    entry: 'book-store.js',
    tests: testsFrom('book-store', 'total', ['basket']),
    reference: {
      'book-store.js': `'use strict';
const PRICE = [0, 800, 1520, 2160, 2560, 3000];
function total(basket) {
  const counts = [0, 0, 0, 0, 0];
  for (const b of basket) counts[b - 1]++;
  const groups = [];
  for (;;) {
    const size = counts.filter((c) => c > 0).length;
    if (!size) break;
    for (let i = 0; i < 5; i++) if (counts[i] > 0) counts[i]--;
    groups.push(size);
  }
  // 5 人組 + 3 人組換成兩個 4 人組更便宜(3000 + 2160 > 2560 * 2)
  for (;;) {
    const five = groups.indexOf(5);
    const three = groups.indexOf(3);
    if (five < 0 || three < 0) break;
    groups[five] = 4;
    groups[three] = 4;
  }
  return groups.reduce((sum, size) => sum + PRICE[size], 0);
}
module.exports = { total };
`,
    },
    naive: {
      'book-store.js': `'use strict';
const PRICE = [0, 800, 1520, 2160, 2560, 3000];
function total(basket) {
  const counts = [0, 0, 0, 0, 0];
  for (const b of basket) counts[b - 1]++;
  let sum = 0;
  for (;;) {
    const size = counts.filter((c) => c > 0).length;
    if (!size) break;
    for (let i = 0; i < 5; i++) if (counts[i] > 0) counts[i]--;
    sum += PRICE[size];
  }
  return sum;
}
module.exports = { total };
`,
    },
  },
  {
    id: 'dominoes',
    set: 'hard',
    asks: '數字出現次數是偶數不代表接得起來:分成兩個獨立的環就接不起來',
    task: '建立 dominoes.js,以 module.exports = { canChain } 匯出 canChain(dominoes):dominoes 是陣列,每個元素是長度 2 的整數陣列,代表一張骨牌的兩半。判斷能不能把「全部」骨牌排成一條鏈:相鄰兩張相接的兩半數字要相同,而且整條鏈頭尾的兩個數字也要相同(首尾相接)。每張骨牌都可以翻面,每張都要用到且只能用一次;可能出現重複的骨牌。空陣列回傳 true。回傳布林值,不可使用任何外部套件。',
    entry: 'dominoes.js',
    tests: testsFrom('dominoes', 'canChain', ['dominoes']),
    reference: {
      'dominoes.js': `'use strict';
function canChain(dominoes) {
  if (!dominoes.length) return true;
  const used = new Array(dominoes.length).fill(false);
  const start = dominoes[0][0];
  used[0] = true;
  const walk = (open, placed) => {
    if (placed === dominoes.length) return open === start;
    for (let i = 0; i < dominoes.length; i++) {
      if (used[i]) continue;
      const [a, b] = dominoes[i];
      if (a === open || b === open) {
        used[i] = true;
        if (walk(a === open ? b : a, placed + 1)) return true;
        used[i] = false;
      }
    }
    return false;
  };
  return walk(dominoes[0][1], 1);
}
module.exports = { canChain };
`,
    },
    naive: {
      'dominoes.js': `'use strict';
// 只看每個數字出現幾次:都是偶數就說接得起來(漏掉「分成兩個獨立的環」)
function canChain(dominoes) {
  const seen = new Map();
  for (const [a, b] of dominoes) {
    seen.set(a, (seen.get(a) || 0) + 1);
    seen.set(b, (seen.get(b) || 0) + 1);
  }
  for (const count of seen.values()) if (count % 2 !== 0) return false;
  return true;
}
module.exports = { canChain };
`,
    },
  },
];

// forth 與 poker:案例數多(54 / 39),規則互相牽動,而且錯誤情況佔了不小的比例。
// 前面四題在 27B + 思考下都碰到天花板,這兩題是用來換取「可測空間」的。
EXERCISM_TASKS.push(
  {
    id: 'forth',
    set: 'hard',
    asks: '自訂詞、重新定義、大小寫不分:定義當下要把內容固定下來,晚綁定會讓舊定義跟著改變',
    task: '建立 forth.js,以 module.exports = { evaluate } 匯出 evaluate(instructions):instructions 是字串陣列,每個字串是一行 Forth 程式,依序執行,回傳結束時堆疊的內容(陣列,底部在前)。支援:整數(可為負);四則運算 + - * /(除法只取整數部分,往零捨去);堆疊操作 DUP(複製最上面一個)、DROP(丟掉最上面一個)、SWAP(交換最上面兩個)、OVER(把第二個複製到最上面)。自訂詞:一行寫成 `: 名稱 內容 ;`,之後出現該名稱就等於執行那串內容;名稱與所有內建詞都不分大小寫;重新定義只影響之後的用法,已經定義好的詞不受影響(定義當下就要把內容固定下來)。錯誤一律丟出 Error:堆疊空的時候做運算(empty stack)、只有一個值卻做需要兩個值的運算(only one value on the stack)、除以零(divide by zero)、用到沒有定義的詞(undefined operation)、把數字當成詞來定義(illegal operation)。不可使用任何外部套件。',
    entry: 'forth.js',
    tests: testsFrom('forth', 'evaluate', ['instructions']),
    reference: {
      'forth.js': `'use strict';
const NUM = /^-?\\d+$/;

function evaluate(instructions) {
  const stack = [];
  const words = new Map(); // 小寫名稱 -> 已展開的內容
  const need = (n) => {
    if (stack.length === 0) throw new Error('empty stack');
    if (stack.length < n) throw new Error('only one value on the stack');
  };
  const run = (token) => {
    const word = token.toLowerCase();
    if (words.has(word)) { for (const inner of words.get(word)) run(inner); return; }
    if (NUM.test(token)) { stack.push(Number(token)); return; }
    switch (word) {
      case '+': { need(2); const b = stack.pop(), a = stack.pop(); stack.push(a + b); return; }
      case '-': { need(2); const b = stack.pop(), a = stack.pop(); stack.push(a - b); return; }
      case '*': { need(2); const b = stack.pop(), a = stack.pop(); stack.push(a * b); return; }
      case '/': {
        need(2);
        const b = stack.pop(), a = stack.pop();
        if (b === 0) throw new Error('divide by zero');
        stack.push(Math.trunc(a / b));
        return;
      }
      case 'dup': { need(1); stack.push(stack[stack.length - 1]); return; }
      case 'drop': { need(1); stack.pop(); return; }
      case 'swap': { need(2); const b = stack.pop(), a = stack.pop(); stack.push(b, a); return; }
      case 'over': { need(2); stack.push(stack[stack.length - 2]); return; }
      default: throw new Error('undefined operation');
    }
  };
  for (const line of instructions) {
    const tokens = String(line).split(/\\s+/).filter(Boolean);
    if (tokens[0] === ':') {
      if (tokens[tokens.length - 1] !== ';') throw new Error('illegal operation');
      const name = tokens[1];
      if (name === undefined || NUM.test(name)) throw new Error('illegal operation');
      // 定義當下就展開:之後重新定義別的詞,不能回頭改變這個詞的行為
      const body = [];
      for (const token of tokens.slice(2, -1)) {
        const word = token.toLowerCase();
        if (words.has(word)) body.push(...words.get(word));
        else body.push(token);
      }
      words.set(name.toLowerCase(), body);
    } else {
      for (const token of tokens) run(token);
    }
  }
  return stack;
}
module.exports = { evaluate };
`,
    },
    naive: {
      'forth.js': `'use strict';
// 常見錯法:自訂詞存原始字串,執行時才查表(晚綁定)。
// 於是「先定義 foo,再用 foo 重新定義 foo」會變成無窮遞迴或拿到新的定義。
const NUM = /^-?\\d+$/;
function evaluate(instructions) {
  const stack = [];
  const words = new Map();
  const run = (token) => {
    const word = token.toLowerCase();
    if (words.has(word)) { for (const inner of words.get(word)) run(inner); return; }
    if (NUM.test(token)) { stack.push(Number(token)); return; }
    const b = stack.pop(), a = stack.pop();
    switch (word) {
      case '+': stack.push(a + b); return;
      case '-': stack.push(a - b); return;
      case '*': stack.push(a * b); return;
      case '/': stack.push(Math.trunc(a / b)); return;
      default: throw new Error('undefined operation');
    }
  };
  for (const line of instructions) {
    const tokens = String(line).split(/\\s+/).filter(Boolean);
    if (tokens[0] === ':') words.set(tokens[1].toLowerCase(), tokens.slice(2, -1));
    else for (const token of tokens) run(token);
  }
  return stack;
}
module.exports = { evaluate };
`,
    },
  },
);

EXERCISM_TASKS.push(
  {
    id: 'poker',
    set: 'hard',
    asks: '牌型比大小的規則多,而且 A 2 3 4 5 是最小的順子這個例外只有少數幾局看得出來',
    task: '建立 poker.js,以 module.exports = { bestHands } 匯出 bestHands(hands):hands 是字串陣列,每個字串是一手五張牌、以空白分隔,例如 "4S 5S 7H 8D JC"。每張牌是點數加花色:點數為 2-10、J、Q、K、A,花色為 S、H、D、C。回傳最強的那一手(陣列,裡面放原本那個字串);並列最強時全部回傳,順序照輸入的順序。牌型由強到弱:同花順、四條、葫蘆(三條加一對)、同花、順子、三條、兩對、一對、高牌。同牌型時依序比較:先比構成牌型的點數(例如四條比四張的點數、葫蘆先比三條)、再比剩下的散牌(由大到小)。A 可以當最大,也可以在 A 2 3 4 5 這個順子裡當最小——這時它是最小的順子,比 2 3 4 5 6 還小。不可使用任何外部套件。',
    entry: 'poker.js',
    tests: testsFrom('poker', 'bestHands', ['hands']),
    reference: {
      'poker.js': `'use strict';
const RANKS = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14 };

function parse(hand) {
  return hand.split(/\\s+/).filter(Boolean).map((card) => ({
    rank: RANKS[card.slice(0, -1).toUpperCase()],
    suit: card.slice(-1).toUpperCase(),
  }));
}

// 回傳可以直接比大小的陣列:[牌型, 依序的比較點數...]
function score(hand) {
  const cards = parse(hand);
  const bySuit = new Set(cards.map((c) => c.suit));
  const counts = new Map();
  for (const c of cards) counts.set(c.rank, (counts.get(c.rank) || 0) + 1);
  // 先比出現次數多的,同次數再比點數大的
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map(([, n]) => n).join('');
  const ordered = groups.map(([rank]) => rank);

  const flush = bySuit.size === 1;
  let straight = false;
  let straightHigh = 0;
  if (counts.size === 5) {
    const sorted = [...counts.keys()].sort((a, b) => a - b);
    if (sorted[4] - sorted[0] === 4) { straight = true; straightHigh = sorted[4]; }
    // A 2 3 4 5:A 當 1,最大的是 5
    else if (sorted.join(',') === '2,3,4,5,14') { straight = true; straightHigh = 5; }
  }

  if (straight && flush) return [8, straightHigh];
  if (shape === '41') return [7, ...ordered];
  if (shape === '32') return [6, ...ordered];
  if (flush) return [5, ...ordered];
  if (straight) return [4, straightHigh];
  if (shape === '311') return [3, ...ordered];
  if (shape === '221') return [2, ...ordered];
  if (shape === '2111') return [1, ...ordered];
  return [0, ...ordered];
}

function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function bestHands(hands) {
  let best = null;
  for (const hand of hands) {
    const s = score(hand);
    if (!best || compare(s, best) > 0) best = s;
  }
  return hands.filter((hand) => compare(score(hand), best) === 0);
}
module.exports = { bestHands };
`,
    },
    naive: {
      'poker.js': `'use strict';
// 常見錯法:忘記 A 2 3 4 5 這個例外,A 一律當 14,於是那一手不算順子(或被當成最大的順子)
const RANKS = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14 };
function score(hand) {
  const cards = hand.split(/\\s+/).filter(Boolean).map((c) => ({ rank: RANKS[c.slice(0, -1).toUpperCase()], suit: c.slice(-1) }));
  const counts = new Map();
  for (const c of cards) counts.set(c.rank, (counts.get(c.rank) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map(([, n]) => n).join('');
  const ordered = groups.map(([rank]) => rank);
  const flush = new Set(cards.map((c) => c.suit)).size === 1;
  const sorted = [...counts.keys()].sort((a, b) => a - b);
  const straight = counts.size === 5 && sorted[4] - sorted[0] === 4;
  if (straight && flush) return [8, sorted[4]];
  if (shape === '41') return [7, ...ordered];
  if (shape === '32') return [6, ...ordered];
  if (flush) return [5, ...ordered];
  if (straight) return [4, sorted[4]];
  if (shape === '311') return [3, ...ordered];
  if (shape === '221') return [2, ...ordered];
  if (shape === '2111') return [1, ...ordered];
  return [0, ...ordered];
}
const cmp = (a, b) => { for (let i = 0; i < 5; i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; };
function bestHands(hands) {
  let best = null;
  for (const h of hands) { const s = score(h); if (!best || cmp(s, best) > 0) best = s; }
  return hands.filter((h) => cmp(score(h), best) === 0);
}
module.exports = { bestHands };
`,
    },
  },
);
