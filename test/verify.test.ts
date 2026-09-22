'use strict';

// 自動驗證本身:語法檢查與驗證指令。這是 app 自己跑出來的事實,不是模型的意見,
// 所以它的判斷必須保守——檢查跑不起來時不能反過來說使用者的檔案壞了。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { verifyChanges, verifyNotes, verificationRevision, SYNTAX_MAX_FILES } = require('../src/verify');

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
  assert.deepStrictEqual(r.unchecked, [{ file: 'notes.txt', reason: 'unsupported' }]);
  assert.strictEqual(r.scopeKnown, true);
  assert.ok(r.checkedAt > 0);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.ran, true);
  // 訊息裡不留絕對路徑:這段會進對話紀錄與匯出
  assert.ok(!r.syntax.some((s: any) => s.error.includes(dir)), r.syntax.map((s: any) => s.error).join('|'));
  assert.match(verifyNotes(r, 'zh-Hant'), /自動語法檢查沒過[\s\S]*bad\.js[\s\S]*bad\.json/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('使用者環境裡的 NODE_OPTIONS 不能讓檢查反咬使用者的檔案', async () => {
  // app 會把使用者登入 shell 的環境整份匯進來(main.ts importShellEnv),
  // 其中的 NODE_OPTIONS 只要有一個這顆 Node 不認得的參數,檢查子行程就以結束代碼 9 收場。
  // 以前那會被當成「每一個改動的 .js 都有語法錯誤」。
  const dir = dirWith({ 'good.js': 'module.exports = { a: 1 };\n', 'bad.js': 'function x( { return 1 }\n' });
  const before = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--this-flag-does-not-exist';
  try {
    const r = await verifyChanges(dir, ['good.js', 'bad.js'], '');
    assert.deepStrictEqual(r.syntax.map((s: any) => s.file), ['bad.js'], '好的檔案不能被誣賴,壞的還是要抓到');
  } finally {
    if (before === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before;
  }
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
  assert.strictEqual((await verifyChanges(dir, null, '')).scopeKnown, false);
  fs.mkdirSync(path.join(dir, 'directory.json'));
  const unavailable = await verifyChanges(dir, ['directory.json'], '');
  assert.strictEqual(unavailable.ran, false);
  assert.deepStrictEqual(unavailable.syntax, []);
  assert.deepStrictEqual(unavailable.unchecked, [{ file: 'directory.json', reason: 'unavailable' }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('驗證指令:成功、失敗、指令不存在都照實回報', async () => {
  const dir = dirWith({ 'a.js': 'module.exports = 1;\n' });
  const ok = await verifyChanges(dir, ['a.js'], 'exit 0');
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.gates.map((g: any) => [g.command, g.ok]), [['exit 0', true]]);
  assert.strictEqual(ok.command, undefined, '全過時沒有「失敗的那道」');
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
  assert.strictEqual(r.unchecked.length, 10);
  assert.ok(r.unchecked.every((item: any) => item.reason === 'limit'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('停止後不啟動後續驗證指令,證據不得標為目前版本', async () => {
  const dir = dirWith({ 'a.js': 'module.exports = 1;\n' });
  try {
    let cancelled = false;
    const result = await verifyChanges(dir, ['a.js'], 'exit 0\necho unsafe > later.txt', 'en', () => { cancelled = true; }, () => cancelled);
    assert.strictEqual(result.freshness, 'unknown');
    assert.deepStrictEqual(result.skippedCommands, ['echo unsafe > later.txt']);
    assert.strictEqual(fs.existsSync(path.join(dir, 'later.txt')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('驗證指紋涵蓋內容、新增刪除與依賴原始碼,指令改檔不得算最新證據', async () => {
  const dir = dirWith({ 'a.js': 'module.exports = 1;\n', 'dependency.txt': 'one' });
  const first = await verifyChanges(dir, ['a.js'], 'exit 0');
  assert.strictEqual(first.freshness, 'current');
  assert.strictEqual(first.revision, await verificationRevision(dir));
  const stamp = fs.statSync(path.join(dir, 'dependency.txt'));
  fs.writeFileSync(path.join(dir, 'dependency.txt'), 'two');
  fs.utimesSync(path.join(dir, 'dependency.txt'), stamp.atime, stamp.mtime);
  assert.notStrictEqual(first.revision, await verificationRevision(dir), 'same-size edits with restored timestamps still invalidate evidence');
  const changed = await verificationRevision(dir);
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new');
  assert.notStrictEqual(changed, await verificationRevision(dir));
  fs.unlinkSync(path.join(dir, 'new.txt'));
  assert.strictEqual(changed, await verificationRevision(dir));
  const mutation = await verifyChanges(dir, ['a.js'], 'echo changed > dependency.txt');
  assert.strictEqual(mutation.ok, true);
  assert.strictEqual(mutation.freshness, 'stale');
  assert.strictEqual(await verificationRevision(dir, 1), null, 'bounded hashing must not claim a partial revision');
  fs.symlinkSync('a.js', path.join(dir, 'link.js'));
  assert.strictEqual(await verificationRevision(dir), null, 'symlinks outside the scope cannot be treated as verified');
  const unknown = await verifyChanges(dir, ['a.js'], '');
  assert.strictEqual(unknown.freshness, 'unknown');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('多道門檻:依序跑,一道沒過就停,並說出是哪一道、前面哪幾道過了', async () => {
  const dir = dirWith({ 'a.js': 'module.exports = 1;\n' });
  const r = await verifyChanges(dir, [], "echo lint-ok\necho 型別錯了 >&2; exit 2\necho 不該跑到 > ran.txt");
  assert.deepStrictEqual(r.gates.map((g: any) => [g.command, g.ok]), [['echo lint-ok', true], ['echo 型別錯了 >&2; exit 2', false]]);
  assert.strictEqual(r.command.command, 'echo 型別錯了 >&2; exit 2', '失敗的那道要指名');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(fs.existsSync(path.join(dir, 'ran.txt')), false, '沒過就停,後面的不跑');
  assert.deepStrictEqual(r.skippedCommands, ['echo 不該跑到 > ran.txt']);
  const notes = verifyNotes(r, 'zh-Hant');
  assert.match(notes, /型別錯了/);
  assert.match(notes, /在它之前這幾道都通過了.*echo lint-ok/s);
  // 空行與前後空白不算一道
  const spaced = await verifyChanges(dir, [], '\n  exit 0  \n\n');
  assert.deepStrictEqual(spaced.gates.map((g: any) => g.command), ['exit 0']);
  fs.rmSync(dir, { recursive: true, force: true });
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} verify tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
