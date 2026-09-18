'use strict';

const assert = require('assert');
const { parseAsk, stripAsk, findDiffFocus } = require('../src/shared');

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log('ok -', name);
};

test('parseAsk:保留標記前的 Qwen3 推理文字並解析全形標記', () => {
  const text = [
    '我先分析需求，以下需要使用者決定。',
    '【ASK】',
    '問題：要採用哪個模式？',
    '（a） 快速模式',
    '（b） 完整模式',
    '【/ASK】',
    '收到回答後繼續。',
  ].join('\n');
  assert.deepStrictEqual(parseAsk(text), {
    question: '要採用哪個模式？',
    options: [
      { id: 'a', label: '快速模式' },
      { id: 'b', label: '完整模式' },
    ],
    allowFree: true,
  });
  assert.strictEqual(stripAsk(text), '我先分析需求，以下需要使用者決定。\n收到回答後繼續。');
});

test('parseAsk:容忍缺少關閉標記、問題標籤與混排中文補充', () => {
  const text = [
    '前言',
    '[ASK]',
    '題目: Qwen3 要保留多少歷史？',
    '(a) 8 則',
    '速度較快，適合記憶體較小的電腦。',
    '2) 16 則',
    '脈絡較完整。',
  ].join('\n');
  const parsed = parseAsk(text);
  assert.strictEqual(parsed.question, 'Qwen3 要保留多少歷史？');
  assert.deepStrictEqual(parsed.options, [
    { id: 'a', label: '8 則', detail: '速度較快，適合記憶體較小的電腦。' },
    { id: 'b', label: '16 則', detail: '脈絡較完整。' },
  ]);
  assert.strictEqual(stripAsk(text), '前言');
});

test('parseAsk:選項超過上限時只保留前八個', () => {
  const choices = Array.from({ length: 12 }, (_, i) => `- 選項 ${i + 1}`).join('\n');
  const parsed = parseAsk(`[ASK]\n要選哪個？\n${choices}\n[/ASK]`);
  assert.strictEqual(parsed.options.length, 8);
  assert.deepStrictEqual(parsed.options.map((option: any) => option.id), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
});

test('parseAsk:沒有問題文字時回 null 且畸形輸入不拋錯', () => {
  assert.strictEqual(parseAsk('[ASK]\n- 選項 A\n- 選項 B\n[/ASK]'), null);
  for (const value of [null, undefined, 0, {}, [], Symbol('bad')]) {
    assert.doesNotThrow(() => parseAsk(value));
  }
});

// 審查訊息的檔名(相對於工作目錄)→ 改動清單裡的檔案(相對於 repo 根目錄)。只接受完全相符。
test('findDiffFocus:README.md 不會對到 docs/README.md;子資料夾要接上 prefix', () => {
  const paths = ['docs/README.md', 'README.md', 'package.json', 'web/package.json'];
  assert.strictEqual(findDiffFocus(paths, '', 'README.md'), 'README.md');
  assert.strictEqual(findDiffFocus(paths, 'web/', 'package.json'), 'web/package.json', '不是根目錄那個使用者自己的 package.json');
  assert.strictEqual(findDiffFocus(paths, '', 'debug.log'), null, '不在清單裡就回 null,介面會說明');
});

console.log(`\n${passed}/${passed} shared tests passed`);
