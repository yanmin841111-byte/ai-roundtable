'use strict';

// 逾時的錯誤訊息要說出怎麼延長。只說「逾時」的話,使用者不知道這是可以改的。
// 擴充(API 與自訂 CLI)可以在設定裡調高;內建的 Claude Code、Codex 不能,就不能叫人去改一個不存在的設定。

const assert = require('assert');
const os = require('os');
const { createOpenAIAdapter } = require('../src/adapters/openai-adapter');
const { createCliAdapter } = require('../src/adapters/cli-adapter');
const builtin = require('../src/adapters/builtin');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });
const ctx = (extra: any = {}) => ({ prompt: 'hi', sessionId: null, cwd: os.tmpdir(), onText: () => {}, onThinking: () => {}, onActivity: () => {}, onSession: () => {}, onProc: () => {}, ...extra });

test('API 成員逾時:說出上限,並告訴使用者在哪裡調高', async () => {
  // 永遠不回應、直到被中止的端點
  const fetchImpl = (_u: string, init: any) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const adapter = createOpenAIAdapter({ id: 'slow', type: 'openai', baseUrl: 'http://local/v1', models: ['m'], stream: false, timeoutMs: 200 }, { fetchImpl });
  const en = await adapter.run({ name: 'Q', model: 'm' }, ctx({ locale: 'en' }));
  assert.match(en.error, /Time limit per turn/, en.error);
  const zh = await adapter.run({ name: 'Q', model: 'm' }, ctx({ locale: 'zh-Hant' }));
  assert.match(zh.error, /每回合逾時上限/, zh.error);
});

test('自訂 CLI 擴充逾時:一樣告訴使用者在哪裡調高', async () => {
  const adapter = createCliAdapter({ id: 'slowcli', type: 'cli', bin: process.execPath, args: ['-e', 'setTimeout(() => {}, 5000)'], timeoutMs: 300 });
  const r = await adapter.run({ model: '', effort: '', canEdit: false }, ctx({ locale: 'en' }));
  assert.match(r.error, /Time limit per turn/, r.error);
});

test('內建 CLI 逾時:不提擴充設定(它沒有這個設定可以調)', async () => {
  const custom = builtin.builtinAdapters.find((a: any) => a.id === 'custom');
  const r = await custom.run({ model: '', effort: '', canEdit: false, customCommand: 'sleep 5' }, ctx({ locale: 'en', timeoutMs: 300 }));
  assert.ok(r.error, '前提:真的逾時了');
  assert.doesNotMatch(r.error, /Time limit per turn/);
});

// 計時器最多只能設約 24.8 天,超過的值會被當成 1 ms:以前填了超大的上限,每個回合反而立刻逾時
test('逾時上限填了超過計時器上限的值:不會立刻逾時', async () => {
  const fetchImpl = async () => {
    await new Promise((r) => setTimeout(r, 50));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }) };
  };
  const adapter = createOpenAIAdapter({ id: 'big', type: 'openai', baseUrl: 'http://local/v1', models: ['m'], stream: false, timeoutMs: 40000 * 60000 }, { fetchImpl });
  const r = await adapter.run({ name: 'Q', model: 'm' }, ctx({ locale: 'en' }));
  assert.strictEqual(r.error || null, null, r.error);
  const cli = createCliAdapter({ id: 'bigcli', type: 'cli', bin: process.execPath, args: ['-e', 'setTimeout(() => process.stdout.write("ok"), 50)'], timeoutMs: 40000 * 60000 });
  const c = await cli.run({ model: '', effort: '', canEdit: false }, ctx({ locale: 'en' }));
  assert.strictEqual(c.error || null, null, c.error);
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} timeout hint tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
