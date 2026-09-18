'use strict';

// CLI 登入狀態的判斷。
//
// 裝好了卻沒登入的 CLI,--version 一樣成功,以前設定畫面就亮綠燈。現在會問 CLI 本身。
// 這裡的輸入全部取自實測(未登入以空的 CLAUDE_CONFIG_DIR / CODEX_HOME 模擬)。
//
// 最重要的是「看不懂就回 null」:把已登入的人誤報成沒登入,會叫他去重新登入一個本來
// 就能用的東西,比沒偵測到更糟。舊版 CLI 沒有這個子指令時就是這種情況,而且在已經
// 支援的機器上跑 harness 是測不到的——只能靠這裡鎖住。

const assert = require('assert');
const { decideClaudeLogin, decideCodexLogin } = require('../src/adapters/builtin');
const { checkLogin } = require('../src/adapters/process');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

test('claude auth status:依實測輸出判斷已登入與未登入', () => {
  assert.strictEqual(decideClaudeLogin({ code: 0, stdout: '{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}' }), true);
  assert.strictEqual(decideClaudeLogin({ code: 1, stdout: '{\n  "loggedIn": false,\n  "authMethod": "none",\n  "apiProvider": "firstParty"\n}' }), false);
});

test('claude:舊版沒有 auth status 時(exit 1、stdout 空白)不可誤判成沒登入', () => {
  // 實測:claude auth <不存在的子指令> 回 exit 1,stdout 是空的——和「沒登入」同一個 exit code
  assert.strictEqual(decideClaudeLogin({ code: 1, stdout: '' }), null);
  assert.strictEqual(decideClaudeLogin({ code: 1, stdout: 'error: unknown command' }), null);
  assert.strictEqual(decideClaudeLogin({ code: 1, stdout: '{"somethingElse": true}' }), null, 'JSON 裡沒有 loggedIn:false 也不算沒登入');
});

test('codex login status:0 已登入、1 未登入、其他一律看不懂', () => {
  assert.strictEqual(decideCodexLogin({ code: 0, stdout: '' }), true);
  assert.strictEqual(decideCodexLogin({ code: 1, stdout: '' }), false);
  // 實測:codex login <不存在的子指令> 回 exit 2(clap 的用法錯誤)
  assert.strictEqual(decideCodexLogin({ code: 2, stdout: '' }), null);
  assert.strictEqual(decideCodexLogin({ code: null, stdout: '' }), null, '被訊號終止');
});

test('CLI 根本不存在時回 null,不是「沒登入」', async () => {
  assert.strictEqual(await checkLogin('definitely-not-a-real-cli-rt', ['auth', 'status'], () => false), null);
});

test('判斷函式丟例外時回 null,不讓健康檢查整個失敗', async () => {
  const r = await checkLogin('/bin/sh', ['-c', 'echo "{not json"; exit 1'], ({ stdout }: { stdout: string }) => JSON.parse(stdout));
  assert.strictEqual(r, null);
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    await fn();
    passed++;
    console.log('ok -', name);
  }
  console.log(`\n${passed}/${tests.length} CLI login tests passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
