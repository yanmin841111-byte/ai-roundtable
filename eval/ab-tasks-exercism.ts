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
function testsFrom(id: string, fn: string, args: string[]): string {
  const cases = DATA[id].cases;
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
