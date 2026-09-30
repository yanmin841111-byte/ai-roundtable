'use strict';

// 反例:把審查從「意見」變成 app 自己跑得出來的證據(見 src/counterexample.ts)。
//
// 這裡要守的是判定方向。反例的語意是反過來的——**失敗才代表問題被確認了**——
// 所以任何把「跑不起來」誤讀成「跑出問題」的路徑都會憑空造出一個不存在的 bug,
// 然後派人去修。實驗 5 的第一次就是被這種誤判作廢的(語法檢查在 app 裡變成執行檔案)。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseCounterexamples, stripCounterexamples, runCounterexample, runCounterexamples,
  classifyConfirmation, counterexampleNotes, counterexampleStatus, counterexamplePath, counterexampleRejection, parseCounterexampleVote,
  CE_SOURCE_MAX, CE_PREFIX,
} = require('../src/counterexample');
const { snapshotDir } = require('../src/snapshot');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

function dirWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ce-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const ce = (source: string, extra: Record<string, unknown> = {}) => ({
  id: 'r1-t1-1', reviewerId: 'r1', reviewerName: '審查者', targetId: 't1', title: '測試用', source, ...extra,
});

test('rejection requires distinct unanimous reviewers and an actual requirement quote', () => {
  const task = 'Reject requests above total capacity.';
  const text = JSON.stringify({ decision: 'withdraw_counterexample', expectationContradictsRequirement: true, requirement: task, reason: 'The example expects an oversized request to run.' });
  const votes = [{ reviewerId: 'one', text }, { reviewerId: 'two', text }];
  assert.strictEqual(counterexampleRejection(task, ['one', 'two'], votes)?.length, 2);
  for (const invalid of [
    votes.slice(0, 1), [...votes, votes[0]],
    [votes[0], { reviewerId: 'two', text, error: 'timeout' }],
    [votes[0], { reviewerId: 'two', text: '{}' }],
    [votes[0], { reviewerId: 'two', text: 'not JSON' }],
    [votes[0], { reviewerId: 'two', text: text.replace('withdraw_counterexample', 'retain_counterexample') }],
    [votes[0], { reviewerId: 'two', text: text.replace('withdraw_counterexample', 'reject') }],
    [votes[0], { reviewerId: 'two', text: text.replace('true', 'false') }],
    [votes[0], { reviewerId: 'two', text: text.replace('"expectationContradictsRequirement":true,', '') }],
    [votes[0], { reviewerId: 'two', text: text.replace(task, 'Invented requirement') }],
    [votes[0], { reviewerId: 'two', text: JSON.stringify({ decision: 'withdraw_counterexample', expectationContradictsRequirement: true, requirement: task, reason: '' }) }],
  ]) assert.strictEqual(counterexampleRejection(task, ['one', 'two'], invalid), undefined);
  assert.strictEqual(counterexampleRejection(task, ['one'], votes), undefined);
  assert.strictEqual(counterexampleRejection(task, ['one', 'one'], votes), undefined);
});

test('counterexample votes accept one JSON envelope but reject ambiguous or unsupported decisions', () => {
  const task = 'Reject invalid input.';
  const vote = { decision: 'withdraw_counterexample', expectationContradictsRequirement: true, requirement: task, reason: 'The probe expects invalid input to succeed.' };
  const text = JSON.stringify(vote);
  for (const envelope of [text, `\n\`\`\`json\n${text}\n\`\`\`\n`, `\`\`\`\r\n${text}\r\n\`\`\``]) {
    assert.deepStrictEqual(parseCounterexampleVote(task, envelope), vote);
    assert.strictEqual(counterexampleRejection(task, ['one', 'two'], [{ reviewerId: 'one', text }, { reviewerId: 'two', text: envelope }])?.length, 2);
  }
  for (const invalid of [
    `Explanation\n\`\`\`json\n${text}\n\`\`\``, `${text}\n${text}`,
    `\`\`\`json\n${text}\n\`\`\`\n\`\`\`json\n${text}\n\`\`\``,
    'null', '[]', '{}', JSON.stringify({ ...vote, requirement: 'Invented requirement' }),
    JSON.stringify({ ...vote, expectationContradictsRequirement: 'true' }),
    JSON.stringify({ ...vote, decision: 'retain_counterexample' }),
  ]) assert.strictEqual(parseCounterexampleVote(task, invalid), undefined);
  assert.ok(parseCounterexampleVote(task, JSON.stringify({ ...vote, decision: 'retain_counterexample', expectationContradictsRequirement: false })));
  assert.strictEqual(parseCounterexampleVote(task, JSON.stringify({ ...vote, decision: 'retain_counterexample', expectationContradictsRequirement: false, requirement: '' })), undefined);
  assert.ok(parseCounterexampleVote(task, JSON.stringify({ ...vote, decision: 'uncertain_counterexample', expectationContradictsRequirement: false, requirement: '' })));
});

test('rejected examples retain failures but cannot become repair gates or corpus entries', () => {
  const run = { ...ce('throw new Error("bad expectation")'), passed: false, code: 1, output: 'original failure', timedOut: false, rejection: ['one: reason', 'two: reason'] };
  assert.strictEqual(classifyConfirmation(run), 'rejected');
  assert.strictEqual(counterexampleNotes([run]), null);
  assert.deepStrictEqual(require('../src/ratchet').gatesFromCounterexamples([run]), []);
  assert.deepStrictEqual(require('../src/corpus').additions([run], 'task', []), []);
  assert.strictEqual(run.output, 'original failure');
  assert.strictEqual(run.passed, false);
});

test('pending assessments preserve evidence but never become repair gates or corpus entries', () => {
  const run = { ...ce('throw new Error("disputed")'), passed: false, code: 1, output: 'original failure', timedOut: false, assessmentPending: true };
  assert.strictEqual(classifyConfirmation(run), 'pending');
  assert.strictEqual(counterexampleNotes([run]), null);
  assert.deepStrictEqual(require('../src/ratchet').gatesFromCounterexamples([run]), []);
  assert.deepStrictEqual(require('../src/corpus').additions([run], 'task', []), []);
  assert.match(counterexampleStatus([run], 'en'), /unresolved requirement assessment/);
  assert.strictEqual(run.output, 'original failure');
  const { restoreTaskSummary, taskSummaryText } = require('../src/flow/task-summary');
  const summary = restoreTaskSummary({ members: [], files: [], usage: {}, counterexamples: [{ title: 'disputed', reviewer: 'Reviewer', confirmation: 'pending', output: run.output, afterRepair: 'failed' }] });
  assert.strictEqual(summary.counterexamples[0].confirmation, 'pending');
  assert.strictEqual(summary.counterexamples[0].afterRepair, undefined);
  assert.match(taskSummaryText(summary, 'en'), /Requirement assessment unresolved/);
});

test('解析:取出反例區塊、保留標題,並把過長、空的、沒收尾的丟掉並回報', () => {
  const text = [
    '這裡有問題。',
    '```counterexample 負數會溢位',
    "const assert = require('assert');",
    'assert.strictEqual(1, 2);',
    '```',
    '另外還有一個:',
    '```counterexample',
    'process.exit(1);',
    '```',
    '```counterexample 空的',
    '```',
    '```js',
    'console.log("這不是反例");',
    '```',
  ].join('\n');
  const r = parseCounterexamples(text);
  assert.strictEqual(r.blocks.length, 2);
  assert.strictEqual(r.blocks[0].title, '負數會溢位');
  assert.match(r.blocks[0].source, /assert\.strictEqual\(1, 2\)/);
  assert.strictEqual(r.blocks[1].title, '', '沒有標題就是空字串');
  // 一般的 ```js 區塊不是反例,不可以被誤抓
  assert.ok(!r.blocks.some((b: any) => /這不是反例/.test(b.source)));
  assert.deepStrictEqual(r.dropped, [{ title: '空的', reason: 'empty' }]);
});

test('解析:沒有收尾的區塊一律丟掉——半截腳本跑起來是語法錯誤,會被讀成「問題確認了」', () => {
  const r = parseCounterexamples('```counterexample 被截斷\nconst x = (');
  assert.deepStrictEqual(r.blocks, []);
  assert.deepStrictEqual(r.dropped, [{ title: '被截斷', reason: 'empty' }]);
});

test('解析:超過長度上限與超過數量上限的都不收,而且說得出是哪一個', () => {
  const long = 'x'.repeat(CE_SOURCE_MAX + 1);
  const many = ['a', 'b', 'c', 'd'].map((n) => `\`\`\`counterexample ${n}\nprocess.exit(1);\n\`\`\``).join('\n');
  assert.deepStrictEqual(parseCounterexamples(`\`\`\`counterexample 太長\n${long}\n\`\`\``).dropped, [{ title: '太長', reason: 'tooLong' }]);
  const r = parseCounterexamples(many);
  assert.strictEqual(r.blocks.length, 3);
  assert.deepStrictEqual(r.dropped, [{ title: 'd', reason: 'limit' }]);
});

test('stripCounterexamples:反例區塊從顯示用的文字裡拿掉,其餘原樣保留', () => {
  const text = '前面一句。\n```counterexample t\nprocess.exit(1);\n```\n後面一句。';
  assert.strictEqual(stripCounterexamples(text), '前面一句。\n後面一句。');
});

test('執行:失敗(非零)才算確認問題,通過算不成立——判定方向不能反', async () => {
  const dir = dirWith({ 'sum.js': 'module.exports = (a, b) => a + b;\n' });
  const bad = await runCounterexample(dir, ce("const assert = require('assert');\nassert.strictEqual(require('./sum.js')(1, 1), 3);\n"));
  assert.strictEqual(bad.passed, false);
  assert.strictEqual(classifyConfirmation(bad), 'confirmed', '真的跑出問題 = 確認');
  assert.match(bad.output, /Assertion|strictEqual/);

  const good = await runCounterexample(dir, ce("const assert = require('assert');\nassert.strictEqual(require('./sum.js')(1, 1), 2);\n"));
  assert.strictEqual(good.passed, true);
  assert.strictEqual(classifyConfirmation(good), 'unsubstantiated', '跑不出問題 = 不算確認,不拿去逼人修');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('執行:相對路徑以工作目錄最上層為準,ESM 寫法也跑得起來', async () => {
  const dir = dirWith({ 'mod.mjs': 'export const two = 2;\n' });
  const r = await runCounterexample(dir, ce("import { two } from './mod.mjs';\nimport assert from 'node:assert';\nassert.strictEqual(two, 3);\n"));
  assert.strictEqual(r.passed, false);
  assert.ok(!r.unusable, `ESM 應該跑得起來,但拿到:${r.output}`);
  assert.match(r.output, /Assertion|strictEqual/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('執行:跑完一定把腳本刪掉,而且快照本來就看不到它', async () => {
  const dir = dirWith({ 'a.js': 'module.exports = 1;\n' });
  const item = ce('process.exit(0);\n');
  const file = counterexamplePath(dir, item);
  assert.ok(path.basename(file).startsWith(CE_PREFIX));
  await runCounterexample(dir, item);
  assert.ok(!fs.existsSync(file), '反例腳本不可以留在工作目錄裡');
  // 就算留著(例如中途被殺),快照也不會把它算成成員的改動
  fs.writeFileSync(file, 'process.exit(0);\n');
  const snap = await snapshotDir(dir);
  assert.deepStrictEqual([...snap.keys()], ['a.js']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('invalid counterexample syntax is unusable, not a repair gate or corpus entry', async () => {
  const dir = dirWith({ 'a.js': 'module.exports = 1;\n' });
  for (const source of ['const broken = (;\n', '檢查 completedDeps 未使用\n', 'import assert from "node:assert";\nconst broken = (;\n']) {
    const item = ce(source);
    const broken = await runCounterexample(dir, item);
    assert.strictEqual(broken.passed, false);
    assert.strictEqual(classifyConfirmation(broken), 'unusable');
    assert.match(broken.output, /SyntaxError/);
    assert.strictEqual(counterexampleNotes([broken]), null);
    assert.deepStrictEqual(require('../src/ratchet').gatesFromCounterexamples([broken]), []);
    assert.deepStrictEqual(require('../src/corpus').additions([broken], 'task', []), []);
    assert.ok(!fs.existsSync(counterexamplePath(dir, item)));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('syntax checking does not execute the probe or hide syntax errors in the project', async () => {
  const dir = dirWith({ 'broken.cjs': 'const broken = (;\n', 'broken.mjs': 'export const broken = (;\n' });
  const once = await runCounterexample(dir, ce('require("node:fs").appendFileSync("executions.txt", "once\\n");'));
  assert.strictEqual(once.passed, true);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'executions.txt'), 'utf8'), 'once\n');
  for (const source of ['require("./broken.cjs");', 'import "./broken.mjs";']) {
    const broken = await runCounterexample(dir, ce(source));
    assert.strictEqual(classifyConfirmation(broken), 'confirmed');
    assert.match(broken.output, /SyntaxError/);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('執行:被停止時不算任何一種結論', async () => {
  const dir = dirWith({ 'a.js': 'module.exports = 1;\n' });
  const r = await runCounterexample(dir, ce('process.exit(1);\n'), 'zh-Hant', undefined, () => true);
  assert.strictEqual(r.unusable, true);
  assert.strictEqual(classifyConfirmation(r), 'unusable');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('批次執行:依序跑,結果一一對應', async () => {
  const dir = dirWith({ 'n.js': 'module.exports = 5;\n' });
  const runs = await runCounterexamples(dir, [
    ce("const assert = require('assert');\nassert.strictEqual(require('./n.js'), 5);\n", { id: 'a', title: '會過' }),
    ce("const assert = require('assert');\nassert.strictEqual(require('./n.js'), 6);\n", { id: 'b', title: '會失敗' }),
  ]);
  assert.deepStrictEqual(runs.map((r: any) => r.id), ['a', 'b']);
  assert.deepStrictEqual(runs.map((r: any) => classifyConfirmation(r)), ['unsubstantiated', 'confirmed']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('給模型看的文字:只列確認過的,而且附上原始碼與實際輸出', () => {
  const runs = [
    { ...ce('A'), id: 'a', title: '真的壞', passed: false, code: 1, output: 'boom', timedOut: false },
    { ...ce('B'), id: 'b', title: '不成立', passed: true, code: 0, output: '', timedOut: false },
  ];
  const notes = counterexampleNotes(runs);
  assert.match(notes, /真的壞/);
  assert.ok(!/不成立/.test(notes), '跑不出問題的不可以拿去逼人修');
  assert.match(notes, /boom/);
  assert.strictEqual(counterexampleNotes([runs[1]]), null, '沒有確認過的就沒有話要說');

  const status = counterexampleStatus(runs);
  assert.match(status, /真的壞/);
  assert.match(status, /不成立/, '複查者要看到全部的狀態');
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} counterexample tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
