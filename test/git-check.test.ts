'use strict';

// git 能不能用,以及不能用的時候 app 說什麼。
//
// macOS 有兩種常見的壞法,使用者都不會知道自己踩到了:沒裝開發者工具(任何 git 指令
// 都會彈出系統安裝視窗),或裝了 Xcode 卻沒同意授權(每個 git 指令都 exit 69)。
// 以前兩種都被講成「這個資料夾不是 git repo」,畫面叫人去 git init——照做也不會好。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifyGitError, gitAvailability, gitFixCommand, resetGitCheck } = require('../src/git-check');
const { collectChanges } = require('../src/diff');
const { workdirChanges } = require('../src/task-changes');
const { captureBaseline } = require('../src/task-changes');
const { snapshotDir } = require('../src/snapshot');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

test('分類:授權沒同意與沒安裝是兩回事,修復指令也不同', () => {
  // 實測訊息(macOS 26,裝了 Xcode 但沒同意授權):exit 69 + 這段文字
  assert.strictEqual(classifyGitError({ code: 69, message: "You have not agreed to the Xcode license agreements." }), 'license');
  assert.strictEqual(classifyGitError({ code: 1, message: 'Agreeing to the Xcode/iOS license requires admin privileges' }), 'license');
  assert.strictEqual(classifyGitError({ code: 'ENOENT', message: 'spawn git ENOENT' }), 'missing');
  assert.strictEqual(gitFixCommand('license'), 'sudo xcodebuild -license accept');
  assert.strictEqual(gitFixCommand('missing'), 'xcode-select --install');
});

test('探測這台機器:回答一定是可用、或帶著一個可照做的修復指令', async () => {
  resetGitCheck();
  const a = await gitAvailability();
  if (a.ok) { assert.strictEqual(a.issue, undefined); return; }
  assert.ok(a.issue === 'missing' || a.issue === 'license', `未知的分類:${a.issue}`);
  assert.ok(gitFixCommand(a.issue).length > 0);
  // 快取:第二次不再重新探測(沒裝開發者工具時,每探測一次就可能彈一個系統視窗)
  assert.deepStrictEqual(await gitAvailability(), a);
});

test('git 不能用時,說的是「git 不能用」而不是「這裡不是 repo」', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-gitcheck-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  const available = await gitAvailability();
  const result = await collectChanges(dir);
  assert.strictEqual(result.ok, false);
  if (available.ok) {
    // git 正常的機器:這個暫存目錄確實不是 repo
    assert.strictEqual(result.reason, 'not-a-repo');
  } else {
    assert.strictEqual(result.reason, 'git-unavailable');
    assert.strictEqual(result.issue, available.issue);
    assert.ok(result.fix && result.fix.command, '要給一行可以照做的指令');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('git 不能用也看得到改動:退回任務開始前的比對', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-gitfallback-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  const baseline = await captureBaseline(dir, await snapshotDir(dir));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  const result = await workdirChanges(dir, baseline);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.source, 'task');
  assert.deepStrictEqual(result.files.map((f: any) => [f.path, f.added, f.removed]), [['a.txt', 1, 0]]);
  fs.rmSync(dir, { recursive: true, force: true });
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} git check tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
