'use strict';

// 審查評測(eval/)本身的檢查:題目真的在量它說要量的東西、計分規則、結果檔只有數字。
// 評測要跑真的模型,這裡不跑;這裡確保題目與計分沒有悄悄壞掉。

const assert = require('assert');
const { CASES } = require('../eval/cases');
const { judged, scoreCase, buildResult, resultFileName } = require('../eval/score');
const { REVIEW_INLINE_FILES } = require('../src/flow/review');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

test('題目 id 不重複;每題都說明要回答的問題;兩種預期都有', () => {
  const ids = CASES.map((c: any) => c.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  for (const c of CASES) assert.ok(c.asks && c.task && c.report, c.id);
  assert.ok(CASES.some((c: any) => c.expected === 'pass') && CASES.some((c: any) => c.expected === 'issues'));
});

test('「超過附上上限」那題:寫錯的檔案真的排在附上的檔案之外', () => {
  const c = CASES.find((x: any) => x.id === 'bug-beyond-inline-limit');
  const files = Object.keys(c.writes);
  assert.ok(files.length > REVIEW_INLINE_FILES, `要比上限 ${REVIEW_INLINE_FILES} 多`);
  const buggy = files[files.length - 1];
  assert.ok(/xs\.reduce\(\(m, x\) => \(x < m/.test(c.writes[buggy]), '寫錯的是最後一個檔案');
  // 審查時「回報提到的檔案排前面」:寫錯的那個沒被提到,才會排在最後、落在上限之外
  assert.ok(!c.report.includes(buggy), '回報沒有提到寫錯的檔案');
});

test('「跨檔案」與「只分析」兩題:問題不在改動裡', () => {
  const cross = CASES.find((x: any) => x.id === 'cross-file');
  assert.ok(cross.files['app.js'].includes('calcTotal') && !cross.writes['app.js'], '呼叫端沒跟著改');
  const analysis = CASES.find((x: any) => x.id === 'analysis-only');
  assert.ok(!analysis.writes || !Object.keys(analysis.writes).length, '只分析的題目不寫檔');
});

test('計分:該抓的沒放行才算對;失敗的回合不計分', () => {
  const run = (o: any) => ({ passed: false, repaired: false, readFile: false, error: false, ...o });
  assert.strictEqual(judged('issues', run({ passed: false })), true);
  assert.strictEqual(judged('issues', run({ passed: true })), false);
  assert.strictEqual(judged('pass', run({ passed: true })), true);
  const s = scoreCase({ id: 'x', expected: 'issues' }, [run({}), run({ passed: true }), run({ error: true }), run({ readFile: true })]);
  assert.deepStrictEqual(s, { expected: 'issues', runs: 4, correct: 2, errors: 1, readFile: 1 });
});

test('結果檔只有數字與模型資訊,沒有對話內容;檔名安全', () => {
  const r = buildResult({ date: '2026-09-19', version: '0.1.0', commit: 'abc1234', cli: 'ollama', model: 'qwen3.8:27b-mlx', runsPerCase: 3 },
    { a: { expected: 'issues', runs: 3, correct: 2, errors: 1, readFile: 2 }, b: { expected: 'pass', runs: 3, correct: 3, errors: 0, readFile: 3 } });
  assert.deepStrictEqual(r.total, { correct: 5, scored: 5, errors: 1 });
  assert.deepStrictEqual(Object.keys(r).sort(), ['app', 'cases', 'date', 'reviewer', 'runsPerCase', 'schema', 'total']);
  for (const s of Object.values(r.cases) as any[]) assert.deepStrictEqual(Object.keys(s).sort(), ['correct', 'errors', 'expected', 'readFile', 'runs']);
  assert.strictEqual(resultFileName(r), '2026-09-19-ollama-qwen3.8-27b-mlx.json');
  assert.strictEqual(resultFileName({ ...r, reviewer: { cli: 'openrouter', model: 'openai/gpt-5 ../x' } }), '2026-09-19-openrouter-openai-gpt-5-..-x.json');
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} eval tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
