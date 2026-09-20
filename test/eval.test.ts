'use strict';

// 審查評測(eval/)本身的檢查:題目真的在量它說要量的東西、計分規則、結果檔只有數字。
// 評測要跑真的模型,這裡不跑;這裡確保題目與計分沒有悄悄壞掉。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

test('單人 vs 圓桌的題目:參考解全過、常見錯解至少錯一項、原始檔(要修的題)不會全過', () => {
  const { AB_TASKS } = require('../eval/ab-tasks');
  const { runHiddenTests, materialize } = require('../eval/hidden-tests');
  const ids = AB_TASKS.map((t: any) => t.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  for (const task of AB_TASKS) {
    const ref = runHiddenTests(materialize(task.reference), task);
    assert.ok(ref.total > 0 && ref.pass === ref.total, `${task.id} 參考解 ${ref.pass}/${ref.total}`);
    const naive = runHiddenTests(materialize(task.naive), task);
    assert.ok(naive.pass < naive.total, `${task.id} 錯解竟然全過`);
    if (task.files) {
      const orig = runHiddenTests(materialize(task.files), task);
      assert.ok(orig.pass < orig.total, `${task.id} 原始檔竟然全過`);
    }
  }
});

test('隱藏測試:模組載不起來或檔案不存在時每一項各自失敗、並記下原因;無窮迴圈會逾時', () => {
  const { runHiddenTests, materialize } = require('../eval/hidden-tests');
  const task = { id: 'x', entry: 'm.js', tests: "t('a', () => assert.ok(M().ok));\nt('b', () => assert.ok(M().ok));" };
  const broken = runHiddenTests(materialize({ 'm.js': 'syntax error (' }), task);
  assert.strictEqual(broken.pass, 0);
  assert.strictEqual(broken.total, 2);
  assert.ok(broken.loadError, '載不起來要說出原因,才分得出「邏輯錯」和「檔案壞了」');
  assert.deepStrictEqual(runHiddenTests(materialize({ 'other.js': '' }), task), { pass: 0, total: 2, missing: true });
  assert.deepStrictEqual(runHiddenTests(materialize({ 'm.js': 'module.exports = { ok: true };' }), task), { pass: 2, total: 2 });
  const hang = runHiddenTests(materialize({ 'm.js': 'while (true) {}' }), task, 1500);
  assert.strictEqual(hang.pass, 0);
  assert.ok(hang.error);
});

test('單人 vs 圓桌的彙總:執行回合失敗照樣計分,app 沒跑完的不計', () => {
  const { summarize } = require('../eval/ab');
  const run = (o: any) => ({ pass: 5, total: 5, seconds: 10, inputTokens: 0, outputTokens: 0, repaired: false, execFailed: false, error: false, ...o });
  const s = summarize([run({}), run({ pass: 2, execFailed: true, seconds: 30 }), run({ error: true, pass: 0 })]);
  assert.deepStrictEqual(s, { runs: 3, errors: 1, allPass: 1, passRate: 0.7, execFailed: 1, avgSeconds: 20, avgTokens: 0 });
});

test('統計:Wilson 信賴區間、Fisher 精確檢定與所需次數跟教科書的數字一致', () => {
  const { wilson, fisherExact, runsNeeded } = require('../eval/stats');
  const near = (x: number, y: number, eps = 0.002) => assert.ok(Math.abs(x - y) < eps, `${x} ≠ ${y}`);
  const [lo0, hi0] = wilson(0, 10);
  near(lo0, 0); near(hi0, 0.2775);
  const [lo, hi] = wilson(12, 15);
  near(lo, 0.5481); near(hi, 0.9295);
  // 經典的「女士品茶」:[[3,1],[1,3]] 雙尾 p = 0.4857
  near(fisherExact(3, 1, 1, 3), 0.4857);
  near(fisherExact(12, 3, 11, 3), 1);
  near(fisherExact(10, 0, 0, 10), 0.0000108, 1e-6);
  // 80% → 95% 每組約要 76 次(常態近似)
  assert.ok(Math.abs(runsNeeded(0.8, 0.95) - 76) <= 2, String(runsNeeded(0.8, 0.95)));
  assert.strictEqual(runsNeeded(0.5, 0.5), Infinity);
});

test('分層置換檢定:明顯的差距 p 小、沒有差距 p 大、只在同一題裡交換、結果可重現', () => {
  const { stratifiedPermutation } = require('../eval/stats');
  const big = stratifiedPermutation([{ a: [0, 0, 0, 0, 0, 0], b: [1, 1, 1, 1, 1, 1] }, { a: [0.1, 0.2, 0.1, 0.2, 0.1], b: [0.9, 1, 0.9, 1, 0.9] }]);
  assert.ok(big.diff > 0.8 && big.p < 0.01, JSON.stringify(big));
  const none = stratifiedPermutation([{ a: [0.5, 0.7, 0.6], b: [0.6, 0.5, 0.7] }]);
  assert.ok(Math.abs(none.diff) < 1e-9 && none.p > 0.9, JSON.stringify(none));
  // 題目難度差很多、但每題兩組一樣:不能因為混在一起算就出現差距
  const strat = stratifiedPermutation([{ a: [0, 0, 0], b: [0, 0, 0] }, { a: [1, 1, 1], b: [1, 1, 1] }]);
  assert.ok(strat.p > 0.9, JSON.stringify(strat));
  assert.deepStrictEqual(stratifiedPermutation([{ a: [0, 1, 0], b: [1, 1, 0] }], 2000, 7), stratifiedPermutation([{ a: [0, 1, 0], b: [1, 1, 0] }], 2000, 7));
});

test('實驗流水帳:中斷後接著跑,不同程式版本的紀錄不採用,壞掉的最後一行丟掉', () => {
  const { readJournal, appendJournal, remaining, staleCount } = require('../eval/journal');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-journal-'));
  const file = path.join(dir, 'runs.jsonl');
  assert.deepStrictEqual(readJournal(file), [], '還沒有檔案時是空的');
  assert.strictEqual(remaining([], 'cron', 'solo', 'abc', 8), 8);
  for (let i = 0; i < 3; i++) appendJournal(file, { task: 'cron', condition: 'solo', commit: 'abc', run: { pass: i } });
  appendJournal(file, { task: 'cron', condition: 'roundtable', commit: 'abc', run: { pass: 9 } });
  appendJournal(file, { task: 'cron', condition: 'solo', commit: 'old', run: { pass: 0 } });
  fs.appendFileSync(file, '{"task": "cron", "conditio');  // 中斷時寫到一半的那一行
  const entries = readJournal(file);
  assert.strictEqual(entries.length, 5, '壞掉的那一行丟掉,其餘照常');
  assert.strictEqual(remaining(entries, 'cron', 'solo', 'abc', 8), 5, '已經跑過 3 次,還要 5 次');
  assert.strictEqual(remaining(entries, 'cron', 'roundtable', 'abc', 8), 7);
  assert.strictEqual(remaining(entries, 'pathnorm', 'solo', 'abc', 8), 8, '別題不算');
  assert.strictEqual(remaining(entries, 'cron', 'solo', 'new', 8), 8, '換了程式版本就重新開始');
  assert.strictEqual(staleCount(entries, 'abc'), 1, '別的版本有幾次要說出來');
  fs.rmSync(dir, { recursive: true, force: true });
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} eval tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
