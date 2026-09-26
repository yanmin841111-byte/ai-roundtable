'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cancelInstall, commandLine, execute, findExecutable, hasInstaller, installMethods, runInstall } = require('../src/cli-install');
const { fixFromStatus } = require('../src/adapters/registry');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

const tools = (overrides = {}) => ({ brew: '/opt/homebrew/bin/brew', winget: 'C:\\winget.exe', npm: '/usr/bin/npm', nodeMajor: 22, official: true, ...overrides });
const methods = (cli: string, platform: string, overrides = {}) => installMethods(cli, platform, tools(overrides)).map((method: any) => method.tool);

test('依系統選擇安裝方式,套件管理工具優先', () => {
  assert.deepStrictEqual(methods('copilot', 'darwin'), ['brew', 'official', 'npm']);
  assert.deepStrictEqual(methods('copilot', 'win32'), ['winget', 'npm']);
  assert.deepStrictEqual(methods('claude', 'win32'), ['winget', 'official', 'npm']);
  assert.deepStrictEqual(methods('cursor', 'linux'), ['official']);
  assert.strictEqual(installMethods('copilot', 'darwin', tools())[0].command, 'brew install --cask copilot-cli');
  assert.strictEqual(installMethods('copilot', 'darwin', tools())[0].recommended, true);
});

test('只列出這台電腦現在能用的方式', () => {
  assert.deepStrictEqual(methods('claude', 'linux', { brew: undefined, nodeMajor: 20 }), ['official']);
  assert.deepStrictEqual(methods('codex', 'darwin', { brew: undefined, official: false, nodeMajor: 18 }), ['npm']);
  assert.deepStrictEqual(methods('copilot', 'win32', { winget: undefined, npm: undefined }), []);
  assert.strictEqual(hasInstaller('copilot', 'win32'), true);
  assert.strictEqual(hasInstaller('custom', 'darwin'), false);
});

test('各系統使用正確的執行方式', () => {
  const [brew, script] = installMethods('copilot', 'darwin', tools());
  const recipe = (cli: string, platform: string, tool: string) => ({ ...installMethods(cli, platform, tools()).find((method: any) => method.tool === tool), tool, args: tool === 'npm' ? ['install', '-g', '@github/copilot'] : undefined });
  assert.deepStrictEqual(commandLine({ ...brew, args: ['install', '--cask', 'copilot-cli'] }, 'darwin', tools()), { bin: '/opt/homebrew/bin/brew', args: ['install', '--cask', 'copilot-cli'] });
  assert.deepStrictEqual(commandLine(script, 'linux', tools()), { bin: '/bin/sh', args: ['-c', script.command] });
  assert.deepStrictEqual(commandLine(recipe('cursor', 'win32', 'official'), 'win32', tools()).args.slice(0, 4), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command']);
  assert.deepStrictEqual(commandLine(recipe('copilot', 'win32', 'npm'), 'win32', tools()), { bin: 'cmd.exe', args: ['/d', '/s', '/c', 'npm install -g @github/copilot'] });
});

test('沒有安裝方式時不啟動任何行程', async () => {
  const output: string[] = [];
  assert.deepStrictEqual(await runInstall('copilot', 'rm -rf /', (line: string) => output.push(line)), { ok: false, reason: 'unavailable' });
  assert.deepStrictEqual(await runInstall('unknown', 'brew', (line: string) => output.push(line)), { ok: false, reason: 'unavailable' });
  assert.deepStrictEqual(output, []);
});

test('安裝輸出去掉終端控制碼,並拆開進度列', async () => {
  const output: string[] = [];
  const code = "process.stdout.write('\\x1b[32mdone\\x1b[0m\\n'); process.stderr.write('50%\\r100%\\n')";
  assert.deepStrictEqual(await execute(process.execPath, ['-e', code], (line: string) => output.push(line)), { ok: true, code: 0 });
  assert.deepStrictEqual(output.sort(), ['100%', '50%', 'done']);
});

test('失敗與取消分開回報', async () => {
  assert.deepStrictEqual(await execute(process.execPath, ['-e', 'process.exit(3)'], () => {}), { ok: false, reason: 'failed', code: 3, detail: undefined });
  const running = execute(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], () => {});
  await new Promise((resolve) => setTimeout(resolve, 200));
  cancelInstall();
  assert.deepStrictEqual(await running, { ok: false, reason: 'canceled' });
});

test('只替內建 CLI 提供安裝動作,並保留官方說明', () => {
  const missing = { ok: false, state: 'missing' };
  assert.deepStrictEqual(fixFromStatus({ id: 'claude', origin: 'builtin', docsUrl: 'https://example.com/claude' }, missing), { install: 'claude', url: 'https://example.com/claude' });
  assert.deepStrictEqual(fixFromStatus({ id: 'claude', origin: 'user', docsUrl: 'https://example.com/claude' }, missing), { url: 'https://example.com/claude' });
});

test('在 PATH 中找可執行檔', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-install-'));
  const file = path.join(dir, 'tool');
  fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
  assert.strictEqual(findExecutable('tool', { PATH: dir }, 'darwin'), file);
  assert.strictEqual(findExecutable('missing', { PATH: dir }, 'darwin'), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} CLI install tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
