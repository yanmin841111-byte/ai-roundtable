'use strict';
// Cursor CLI 轉接器測試:用假的 cursor-agent 重播實測的 stream-json 事件順序。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCursorAdapter, parseCursorModels, describeCursorTool } = require('../src/adapters/cursor');
const { builtinAdapters } = require('../src/adapters/builtin');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-roundtable-cursor-'));
const tests: any[] = [];
const t = (name: any, fn: any) => tests.push({ name, fn });

// 假 CLI:把參數與 stdin 寫到 FAKE_LOG,再依 FAKE_MODE 輸出事件
const fakeBin = path.join(tmp, 'cursor-agent');
fs.writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--list-models') {
  process.stdout.write('Available models\\n\\nauto - Auto (default)\\ncomposer-2.5-fast - Composer 2.5 Fast\\nclaude-opus-5-thinking-high - Claude Opus 5 1M Thinking\\n');
  process.exit(0);
}
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ args, stdin }));
  const sid = 'sess-42';
  const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: sid }) + '\\n');
  if (process.env.FAKE_MODE === 'fail') { process.stderr.write('not logged in'); process.exit(1); }
  if (process.env.FAKE_MODE === 'error') { out({ type: 'result', subtype: 'error', is_error: true, result: 'quota exceeded' }); return; }
  out({ type: 'system', subtype: 'init', cwd: process.cwd() });
  out({ type: 'thinking', subtype: 'delta', text: 'plan ', timestamp_ms: 1 });
  out({ type: 'thinking', subtype: 'delta', text: 'it', timestamp_ms: 1 });
  out({ type: 'thinking', subtype: 'completed', timestamp_ms: 1 });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Running ' }] }, timestamp_ms: 2 });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the command.' }] }, timestamp_ms: 2 });
  // 實測:完整段落的重送有時也帶 timestamp_ms
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Running the command.' }] }, timestamp_ms: 2 });
  out({ type: 'tool_call', subtype: 'started', call_id: 't1', tool_call: { shellToolCall: { args: { command: 'echo hi > out.txt' } } } });
  out({ type: 'tool_call', subtype: 'completed', call_id: 't1', tool_call: { shellToolCall: { args: { command: 'echo hi > out.txt' }, result: { success: { exitCode: 0, stdout: 'ok', stderr: '' } } } } });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Running the command.' }] } });
  out({ type: 'tool_call', subtype: 'started', call_id: 't2', tool_call: { readToolCall: { args: { path: '/x/note.txt' } } } });
  out({ type: 'tool_call', subtype: 'completed', call_id: 't2', tool_call: { readToolCall: { args: { path: '/x/note.txt' }, result: { error: { error: 'File not found' } } } } });
  out({ type: 'thinking', subtype: 'delta', text: 'again', timestamp_ms: 3 });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'do' }] }, timestamp_ms: 4 });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ne' }] }, timestamp_ms: 4 });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Running the command.\\ndone', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0 } });
});
`);
fs.chmodSync(fakeBin, 0o755);

function makeCtx(extra: any = {}) {
  const log: any = { texts: [], thinking: [], activities: [], sessions: [] };
  const ctx = {
    prompt: 'hello', systemPrompt: 'SYS', sessionId: null, cwd: tmp, timeoutMs: 15000,
    onText: (x: any) => log.texts.push(x),
    onThinking: (x: any) => log.thinking.push(x),
    onActivity: (a: any) => log.activities.push(a),
    onSession: (id: any) => log.sessions.push(id),
    onProc: () => {},
    ...extra,
  };
  return { ctx, log };
}

function withEnv(env: any, fn: any) {
  const prev: Record<string, any> = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; process.env[k] = env[k]; }
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(env)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  });
}

const logFile = path.join(tmp, 'log.json');
const readLog = () => JSON.parse(fs.readFileSync(logFile, 'utf8'));

t('內建清單包含 Cursor CLI', () => {
  const cursor = builtinAdapters.find((a: any) => a.id === 'cursor');
  assert.ok(cursor);
  assert.strictEqual(cursor.bin, 'cursor-agent');
  assert.strictEqual(cursor.supportsResume, true);
  assert.strictEqual(cursor.usageShape, 'cursor');
});

t('解析 --list-models 輸出', () => {
  const models = parseCursorModels('Available models\n\n\x1b[1mauto - Auto (default)\x1b[0m\ngpt-5.2 - GPT-5.2\ngpt-5.2 - dup\nLoading...\n');
  assert.deepStrictEqual(models.map((m: any) => m.id), ['auto', 'gpt-5.2']);
  assert.strictEqual(models[0].label, 'Auto');
  assert.strictEqual(models[0].description, 'Cursor 預設模型');
  assert.deepStrictEqual(models[1].efforts, []);
});

t('工具標題', () => {
  assert.strictEqual(describeCursorTool('shellToolCall', { command: 'ls' }), '執行指令:ls');
  assert.strictEqual(describeCursorTool('globToolCall', { globPattern: '**/a' }), '搜尋檔名:**/a');
  assert.strictEqual(describeCursorTool('mcpToolCall', {}), '工具:mcp');
});

t('第一回合:唯讀參數、角色設定接在提示詞前、段落與工具事件', () => withEnv({ FAKE_LOG: logFile, FAKE_MODE: 'ok' }, async () => {
  const adapter = createCursorAdapter({ bin: fakeBin });
  const { ctx, log } = makeCtx();
  const r = await adapter.run({ model: 'composer-2.5-fast', canEdit: false }, ctx);
  const { args, stdin } = readLog();
  assert.deepStrictEqual(args.slice(0, 4), ['-p', '--output-format', 'stream-json', '--stream-partial-output']);
  assert.ok(args.includes('--trust'));
  assert.strictEqual(args[args.indexOf('--workspace') + 1], tmp);
  assert.strictEqual(args[args.indexOf('--model') + 1], 'composer-2.5-fast');
  assert.strictEqual(args[args.indexOf('--mode') + 1], 'ask');
  assert.ok(!args.includes('--force'));
  assert.ok(!args.includes('--resume'));
  assert.strictEqual(stdin, 'SYS\n\n---\n\nhello');

  assert.strictEqual(r.error, null);
  assert.strictEqual(r.text, 'Running the command.\ndone', '最終以 result 為準');
  assert.ok(log.texts.includes('Running the command.\n\ndone'), '串流時完整段落取代片段、工具後的重送略過,不能重複');
  assert.strictEqual(r.thinking, 'plan it\n\nagain');
  assert.strictEqual(r.sessionId, 'sess-42');
  assert.deepStrictEqual(log.sessions, ['sess-42']);
  assert.deepStrictEqual(r.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0 });
  assert.ok(log.texts.includes('Running the command.'), '串流中要能看到片段');
  assert.ok(log.texts.every((x: any) => x.split('Running the command.').length <= 2), '不能把片段與完整段落疊在一起');

  const shell = log.activities.filter((a: any) => a.id === 't1');
  assert.strictEqual(shell[0].status, 'running');
  assert.strictEqual(shell[0].title, '執行指令:echo hi > out.txt');
  assert.strictEqual(shell[1].status, 'done');
  assert.strictEqual(shell[1].result, 'ok');
  const read = log.activities.filter((a: any) => a.id === 't2');
  assert.strictEqual(read[1].status, 'error');
  assert.strictEqual(read[1].result, 'File not found');
}));

t('續接回合:帶 --resume、--force,不再送角色設定;強度會提示略過', () => withEnv({ FAKE_LOG: logFile, FAKE_MODE: 'ok' }, async () => {
  const adapter = createCursorAdapter({ bin: fakeBin });
  const { ctx, log } = makeCtx({ sessionId: 'sess-42' });
  await adapter.run({ model: '', effort: 'high', canEdit: true }, ctx);
  const { args, stdin } = readLog();
  assert.strictEqual(args[args.indexOf('--resume') + 1], 'sess-42');
  assert.ok(args.includes('--force'));
  assert.ok(!args.includes('--mode'));
  assert.ok(!args.includes('--model'));
  assert.strictEqual(stdin, 'hello');
  assert.ok(log.activities.some((a: any) => a.kind === 'note' && /high/.test(a.title)));
  assert.deepStrictEqual(log.sessions, [], 'session id 沒變時不重複回報');
}));

t('錯誤:result is_error 與非零結束代碼', () => withEnv({ FAKE_LOG: logFile }, async () => {
  const adapter = createCursorAdapter({ bin: fakeBin });
  process.env.FAKE_MODE = 'error';
  assert.strictEqual((await adapter.run({}, makeCtx().ctx)).error, 'quota exceeded');
  process.env.FAKE_MODE = 'fail';
  assert.ok(/結束代碼 1[\s\S]*not logged in/.test((await adapter.run({}, makeCtx().ctx)).error));
  const missing = createCursorAdapter({ bin: path.join(tmp, 'nope') });
  assert.ok(/無法啟動/.test((await missing.run({}, makeCtx().ctx)).error));
}));

t('模型清單:讀取前是 loading,讀取後來自 CLI;找不到指令時回報錯誤', async () => {
  const adapter = createCursorAdapter({ bin: fakeBin });
  assert.strictEqual(adapter.listModels().source, 'loading');
  await adapter.refreshModels();
  const listed = adapter.listModels();
  assert.strictEqual(listed.source, 'cli');
  assert.deepStrictEqual(listed.models.map((m: any) => m.id), ['auto', 'composer-2.5-fast', 'claude-opus-5-thinking-high']);

  const missing = createCursorAdapter({ bin: path.join(tmp, 'nope') });
  await missing.refreshModels();
  const failed = missing.listModels();
  assert.strictEqual(failed.source, 'error');
  assert.ok(failed.error);
  assert.deepStrictEqual(failed.models.map((m: any) => m.id), ['auto']);
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log('ok -', name);
    } catch (e: any) {
      console.log('FAIL -', name);
      console.log(e);
      process.exitCode = 1;
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed}/${tests.length} tests passed`);
})();
