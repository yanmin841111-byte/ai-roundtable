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
  classifyConfirmation, counterexampleNotes, counterexampleStatus, counterexamplePath,
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

test('執行:語法壞掉的反例算「跑不成」還是「確認」——照實當成非零失敗,但逾時不算', async () => {
  const dir = dirWith({ 'a.js': 'module.exports = 1;\n' });
  // 語法錯誤的腳本的確會以非零結束。這裡只固定行為:它不會被當成 unusable 而靜默消失,
  // 使用者在訊息裡看得到輸出,自己判斷得出來是反例寫壞了還是程式真的有問題。
  const broken = await runCounterexample(dir, ce('const x = (;\n'));
  assert.strictEqual(broken.passed, false);
  assert.ok(broken.output.length > 0, '輸出要留著,不然看不出是反例自己壞了');
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
