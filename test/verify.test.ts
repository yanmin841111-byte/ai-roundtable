'use strict';

// 自動驗證本身:語法檢查與驗證指令。這是 app 自己跑出來的事實,不是模型的意見,
// 所以它的判斷必須保守——檢查跑不起來時不能反過來說使用者的檔案壞了。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { verifyChanges, verifyNotes, SYNTAX_MAX_FILES } = require('../src/verify');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

function dirWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-verify-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

test('語法檢查:壞的 js 與 json 抓得到,好的不誤報,非程式檔不檢查', async () => {
  const dir = dirWith({
    'good.js': 'module.exports = { a: 1 };\n',
    'bad.js': 'function x( { return 1 }\n',
    'good.json': '{"a": 1}',
    'bad.json': '{oops',
    'notes.txt': 'function x( {',
    'nested/deep.mjs': 'export const a = 1;\n',
  });
  const r = await verifyChanges(dir, ['good.js', 'bad.js', 'good.json', 'bad.json', 'notes.txt', 'nested/deep.mjs'], '');
  assert.deepStrictEqual(r.syntax.map((s: any) => s.file).sort(), ['bad.js', 'bad.json']);
  assert.strictEqual(r.checked, 5, '.txt 不算');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.ran, true);
  // 訊息裡不留絕對路徑:這段會進對話紀錄與匯出
  assert.ok(!r.syntax.some((s: any) => s.error.includes(dir)), r.syntax.map((s: any) => s.error).join('|'));
  assert.match(verifyNotes(r, 'zh-Hant'), /自動語法檢查沒過[\s\S]*bad\.js[\s\S]*bad\.json/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('刪掉的檔案不算壞掉;沒有可檢查的東西就是「沒有驗證」', async () => {
  const dir = dirWith({ 'a.txt': 'x' });
  const gone = await verifyChanges(dir, ['deleted.js'], '');
  assert.deepStrictEqual(gone.syntax, []);
  assert.strictEqual(gone.checked, 0);
  assert.strictEqual(gone.ran, false, '沒有檢查到任何東西,不能說「通過」');
  assert.strictEqual(verifyNotes(gone, 'zh-Hant'), null);
  assert.strictEqual((await verifyChanges(dir, null, '')).ran, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('驗證指令:成功、失敗、指令不存在都照實回報', async () => {
  const dir = dirWith({ 'a.js': 'module.exports = 1;\n' });
  const ok = await verifyChanges(dir, ['a.js'], 'exit 0');
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.command.ok, true);
  const bad = await verifyChanges(dir, ['a.js'], 'echo 壞了 >&2; exit 3');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.command.code, 3);
  assert.match(bad.command.output, /壞了/);
  assert.match(verifyNotes(bad, 'zh-Hant'), /驗證指令失敗/);
  // 指令不存在:使用者設了卻沒跑到,不能當成通過
  const missing = await verifyChanges(dir, ['a.js'], 'definitely-not-a-real-command-xyz');
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.command.code, 127, 'shell 找不到指令時是 127');
  // 「找不到指令」和「指令跑了但沒過」要分得開:前者要改的是設定,不是程式碼
  assert.strictEqual(missing.command.notFound, true);
  assert.strictEqual(bad.command.notFound, undefined, '跑得動但失敗的指令不算找不到');
  assert.match(verifyNotes(missing, 'zh-Hant'), /找不到.*驗證指令/);
  assert.match(verifyNotes(missing, 'en'), /was not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('驗證指令在工作目錄裡執行,輸出會截斷', async () => {
  const dir = dirWith({ 'mark.txt': 'here' });
  const r = await verifyChanges(dir, [], 'cat mark.txt; exit 1');
  assert.match(r.command.output, /here/);
  const big = await verifyChanges(dir, [], 'node -e "console.log(\'x\'.repeat(20000))"; exit 1');
  assert.ok(big.command.output.length < 5000, String(big.command.output.length));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('檔案很多時只檢查前面幾十個,不會把整個工作目錄跑一遍', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < SYNTAX_MAX_FILES + 10; i++) files[`f${i}.js`] = 'module.exports = 1;\n';
  const dir = dirWith(files);
  const r = await verifyChanges(dir, Object.keys(files), '');
  assert.strictEqual(r.checked, SYNTAX_MAX_FILES);
  fs.rmSync(dir, { recursive: true, force: true });
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} verify tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
