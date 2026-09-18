'use strict';

// 主程序產生、會直接顯示給使用者的訊息要跟著介面語言。
//
// 這裡每條路徑都真的跑一次英文,不是只檢查字典裡有沒有那個鍵——
// 字典有鍵、呼叫端卻忘了傳 locale,是這類遷移最常見的漏網之魚,只有實跑抓得到。
// 同時確認沒給 locale 時仍是中文,既有行為不能被改壞。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { formatTimeout, runProcess, checkCli } = require('../src/adapters/process');
const { Registry } = require('../src/adapters/registry');
const { builtinAdapters } = require('../src/adapters/builtin');
const { describeCursorTool } = require('../src/adapters/cursor');
const { validateCliSpec } = require('../src/adapters/cli-adapter');
const { validateOpenAISpec } = require('../src/adapters/openai-adapter');
const { validateCommon } = require('../src/adapters/spec');
const { addAttachments, newConversationId } = require('../src/attachments');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });
const MISSING = 'definitely-not-a-real-command-rt';

const ctx = (extra: any = {}) => ({
  prompt: 'p', cwd: os.tmpdir(), sessionId: null,
  onText: () => {}, onThinking: () => {}, onActivity: () => {}, onSession: () => {}, onProc: () => {},
  ...extra,
});

test('逾時時間用分鐘表示,且英文有正確的單複數', () => {
  assert.strictEqual(formatTimeout(20 * 60 * 1000), '20 分鐘');
  assert.strictEqual(formatTimeout(20 * 60 * 1000, 'en'), '20 minutes');
  assert.strictEqual(formatTimeout(60 * 1000, 'en'), '1 minute');
  assert.strictEqual(formatTimeout(90 * 1000, 'en'), '1 min 30 s');
  assert.strictEqual(formatTimeout(1000, 'en'), '1 second');
  assert.strictEqual(formatTimeout(45 * 1000), '45 秒');
});

test('CLI 逾時訊息跟著語言', async () => {
  const res = await runProcess('sleep', ['5'], { timeoutMs: 150, killGraceMs: 300, locale: 'en' });
  assert.strictEqual(res.timedOut, true);
  assert.match(res.error, /^Timed out \(/);
  assert.match(res.stderr, /sent SIGTERM/);
  const zh = await runProcess('sleep', ['5'], { timeoutMs: 150, killGraceMs: 300 });
  assert.match(zh.error, /^執行逾時/, '沒給 locale 時維持中文');
});

test('找不到指令的訊息跟著語言', async () => {
  assert.match((await checkCli(MISSING, undefined, 'en')).error, new RegExp(`Command not found: ${MISSING}`));
  assert.match((await checkCli(MISSING)).error, new RegExp(`找不到指令 ${MISSING}`));
});

// 健康檢查沒有 RunContext,語言要由 registry 帶進 check()。這條最容易漏接。
test('設定畫面的健康檢查錯誤跟著介面語言', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-i18n-reg-'));
  fs.writeFileSync(path.join(dir, 'missing.json'), JSON.stringify({ id: 'missing', type: 'cli', bin: MISSING }));
  const en = await new Registry({ userDir: dir, getLocale: () => 'en' }).checkAll();
  assert.match(en.missing.error, /Command not found/);
  const zh = await new Registry({ userDir: dir, getLocale: () => 'zh-Hant' }).checkAll();
  assert.match(zh.missing.error, /找不到指令/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('擴充載入失敗的原因跟著介面語言', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-i18n-load-'));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
  fs.writeFileSync(path.join(dir, 'badtype.json'), JSON.stringify({ id: 'x', type: 'nope' }));
  const reg = new Registry({ userDir: dir, getLocale: () => 'en' });
  const errors = reg.entries.map((e: any) => e.error).join(' | ');
  assert.match(errors, /Invalid JSON/);
  assert.match(errors, /type must be "cli" or "openai"/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('自訂指令成員的錯誤跟著語言', async () => {
  const custom = builtinAdapters.find((a: any) => a.id === 'custom');
  const en = await custom.run({ name: 'x', customCommand: '' }, ctx({ locale: 'en' }));
  assert.match(en.error, /No custom command has been set/);
  const zh = await custom.run({ name: 'x', customCommand: '' }, ctx());
  assert.match(zh.error, /尚未設定自訂指令/);
});

test('工具動作標題跟著語言', () => {
  assert.strictEqual(describeCursorTool('readToolCall', { path: 'a.ts' }, 'en'), 'Read file: a.ts');
  assert.strictEqual(describeCursorTool('shellToolCall', { command: 'ls' }, 'en'), 'Run command: ls');
  assert.strictEqual(describeCursorTool('readToolCall', { path: 'a.ts' }), '讀取檔案:a.ts', '預設維持中文');
});

// 拖檔案被拒時,原因會直接顯示在輸入框。這是英文使用者最常碰到的一句錯誤。
test('附件被拒的原因跟著語言', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-i18n-att-'));
  const id = newConversationId();
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]);
  const en = addAttachments(dir, id, [
    { name: 'a.zip', data: Buffer.from('x') },
    { name: 'empty.txt', data: Buffer.alloc(0) },
    { name: 'fake.txt', data: elf },
  ], { locale: 'en' });
  const reasons = en.errors.map((e: any) => e.error);
  assert.match(reasons[0], /Unsupported file type ".zip"/);
  assert.match(reasons[0], /\.png, \.jpg/, '英文清單用逗號分隔');
  assert.match(reasons[1], /The file is empty/);
  assert.match(reasons[2], /looks like an ELF executable/);
  const zh = addAttachments(dir, id, [{ name: 'a.zip', data: Buffer.from('x') }]);
  assert.match(zh.errors[0].error, /不支援的檔案類型「\.zip」/, '預設維持中文');
  assert.match(zh.errors[0].error, /\.png、\.jpg/, '中文清單用頓號');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('擴充設定的驗證錯誤跟著語言,清單用對應語言的連接詞', () => {
  const common: string[] = [];
  validateCommon({ id: '!bad', label: 5 }, common, 'en');
  assert.ok(common.some((e) => /^id must be 1–64/.test(e)));
  assert.ok(common.includes('label must be a string'));

  const cli: string[] = [];
  validateCliSpec({ bin: 'x', input: 'wat', env: [] }, cli, 'en');
  assert.ok(cli.includes('input must be stdin, arg, file or none'), cli.join(' | '));
  assert.ok(cli.includes('env must be an object'));

  const api: string[] = [];
  validateOpenAISpec({ baseUrl: 'ftp://x', supportsEdit: true, modelFilter: '(' }, api, 'en');
  assert.ok(api.includes('baseUrl must be a URL starting with http:// or https://'));
  assert.ok(api.includes('fileTools.enabled=true must also be set explicitly when supportsEdit=true'));
  assert.ok(api.some((e) => /^modelFilter is not a valid regular expression/.test(e)));

  // 沒給 locale 時維持中文,既有測試與訊息都不能變
  const zh: string[] = [];
  validateCliSpec({ bin: 'x', input: 'wat' }, zh);
  assert.ok(zh.includes('input 必須是 stdin、arg、file 或 none'), zh.join(' | '));
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    await fn();
    passed++;
    console.log('ok -', name);
  }
  console.log(`\n${passed}/${tests.length} i18n runtime tests passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
