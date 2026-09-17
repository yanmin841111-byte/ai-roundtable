'use strict';
// 內建 Claude Code / Codex CLI 轉接器測試:把假的 claude / codex 放進 PATH,
// 重播實測的 stream-json 事件,驗證參數組合、串流解析與錯誤處理。
// CLI 一改輸出格式,這裡會先壞掉,而不是等到真的跑圓桌才發現。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-roundtable-builtin-'));
const binDir = path.join(tmp, 'bin');
fs.mkdirSync(binDir);
// 模型清單一律用內建清單:不讀開發機上真正的 CLI 快取
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.CODEX_HOME = path.join(tmp, 'codex');
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH || ''}`;

const { builtinAdapters } = require('../src/adapters/builtin');
// 測試只看 run 的回傳,欄位逐一斷言,型別用 any 即可
type Runnable = { run(agent: any, ctx: any): Promise<any> };
const claude: Runnable = builtinAdapters.find((a: any) => a.id === 'claude');
const codex: Runnable = builtinAdapters.find((a: any) => a.id === 'codex');

const tests: any[] = [];
const t = (name: any, fn: any) => tests.push({ name, fn });

// ---------- 假 CLI ----------
function writeFake(name: string, body: string) {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ args, stdin }));
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const mode = process.env.FAKE_MODE || 'ok';
${body}
});
`);
  fs.chmodSync(file, 0o755);
}

// Claude Code:claude -p --output-format stream-json --verbose --include-partial-messages
writeFake('claude', `
  if (mode === 'crash') { process.stderr.write('not logged in'); process.exit(2); }
  out({ type: 'system', subtype: 'init', session_id: 'c-sess-1' });
  if (mode === 'error') { out({ type: 'result', subtype: 'error', is_error: true, result: 'rate limited', usage: { input_tokens: 1, output_tokens: 0 } }); return; }
  if (mode === 'result-only') { out({ type: 'result', subtype: 'success', is_error: false, result: 'final only', usage: { input_tokens: 3, output_tokens: 2 } }); return; }
  out({ type: 'stream_event', event: { type: 'message_start' } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'think ' } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hard' } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls -la' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'file.txt' }], is_error: false }] } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/x/a.txt' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'not found', is_error: true }] } });
  // 第二則訊息:前面已有文字時要另起段落
  out({ type: 'stream_event', event: { type: 'message_start' } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done.' } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Hello\\n\\nDone.', total_cost_usd: 0.0123, usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 20 } });
`);

// Codex CLI:codex exec --json
writeFake('codex', `
  if (mode === 'crash') { process.stderr.write('auth expired'); process.exit(3); }
  out({ type: 'thread.started', thread_id: 'thr-9' });
  out({ type: 'item.started', item: { id: 'r1', type: 'reasoning', text: 'thinking' } });
  out({ type: 'item.started', item: { id: 'm1', type: 'agent_message', text: 'First' } });
  out({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'First part' } });
  out({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'npm test' } });
  out({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'npm test', exit_code: 1, aggregated_output: 'fail' } });
  out({ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ kind: 'add', path: 'a.txt' }, { kind: 'update', path: 'b.txt' }] } });
  out({ type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'Second' } });
  if (mode === 'fail') { out({ type: 'turn.failed', error: { message: 'context overflow' } }); return; }
  out({ type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 7 } });
`);

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

function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; process.env[k] = env[k]; }
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(env)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  });
}

const logFile = path.join(tmp, 'log.json');
const readLog = () => JSON.parse(fs.readFileSync(logFile, 'utf8'));
const activity = (log: any, id: string) => log.activities.filter((a: any) => a.id === id);

// ---------- Claude Code ----------
t('Claude:可改檔案時的參數、模型別名解析、系統提示、stdin', async () => {
  const { ctx, log } = makeCtx();
  const r = await withEnv({ FAKE_LOG: logFile }, () => claude.run({ model: 'opus', effort: 'high', canEdit: true }, ctx));
  const { args, stdin } = readLog();
  assert.deepStrictEqual(args.slice(0, 5), ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']);
  assert.ok(args.includes('--model') && args[args.indexOf('--model') + 1] === 'claude-opus-5', '別名 opus 要換成完整 id');
  assert.strictEqual(args[args.indexOf('--effort') + 1], 'high');
  assert.strictEqual(args[args.indexOf('--append-system-prompt') + 1], 'SYS');
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('--resume'));
  assert.strictEqual(stdin, 'hello');
  assert.strictEqual(r.error, null);
  assert.strictEqual(log.activities.some((a: any) => a.id === 'run-options'), false, '模型與強度都合法時不該有調整註記');
});

t('Claude:唯讀成員用 dontAsk + restricted;續接時帶 --resume', async () => {
  const { ctx } = makeCtx({ sessionId: 'prev-1', systemPrompt: '' });
  await withEnv({ FAKE_LOG: logFile }, () => claude.run({ model: '', effort: '', canEdit: false }, ctx));
  const { args } = readLog();
  assert.deepStrictEqual(args.slice(-3), ['--permission-mode', 'dontAsk', '--restricted']);
  assert.strictEqual(args[args.indexOf('--resume') + 1], 'prev-1');
  assert.ok(!args.includes('--model') && !args.includes('--effort') && !args.includes('--append-system-prompt'));
});

t('Claude:不支援強度的模型會略過強度並留下註記', async () => {
  const { ctx, log } = makeCtx();
  await withEnv({ FAKE_LOG: logFile }, () => claude.run({ model: 'haiku', effort: 'high', canEdit: true }, ctx));
  const { args } = readLog();
  assert.strictEqual(args[args.indexOf('--model') + 1], 'claude-haiku-4-5-20251001');
  assert.ok(!args.includes('--effort'));
  const note = activity(log, 'run-options')[0];
  assert.ok(note && note.kind === 'note' && note.title, '要用 note 告訴使用者強度被略過');
});

t('Claude:串流解析(文字、思考、段落、工具、session、usage)', async () => {
  const { ctx, log } = makeCtx();
  const r = await withEnv({ FAKE_LOG: logFile }, () => claude.run({ model: 'opus', effort: 'high', canEdit: true }, ctx));
  assert.deepStrictEqual(log.sessions, ['c-sess-1']);
  assert.strictEqual(r.sessionId, 'c-sess-1');
  assert.deepStrictEqual(log.texts, ['Hel', 'Hello', 'Hello\n\nDone.'], '文字逐段累積,第二則訊息前另起段落');
  assert.deepStrictEqual(log.thinking, ['think ', 'think hard']);
  assert.strictEqual(r.text, 'Hello\n\nDone.');
  assert.strictEqual(r.thinking, 'think hard');
  const bash = activity(log, 'tu1');
  assert.strictEqual(bash[0].status, 'running');
  assert.ok(bash[0].title.includes('ls -la'), bash[0].title);
  assert.ok(bash[0].detail.includes('ls -la'));
  assert.strictEqual(bash[1].status, 'done');
  assert.strictEqual(bash[1].result, 'file.txt');
  const read = activity(log, 'tu2');
  assert.ok(read[0].title.includes('/x/a.txt'));
  assert.strictEqual(read[1].status, 'error');
  assert.strictEqual(read[1].result, 'not found');
  assert.deepStrictEqual(r.usage, { total_cost_usd: 0.0123, input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 20 });
});

t('Claude:沒有串流文字時退回 result 的內容', async () => {
  const { ctx, log } = makeCtx();
  const r = await withEnv({ FAKE_LOG: logFile, FAKE_MODE: 'result-only' }, () => claude.run({ model: '', effort: '', canEdit: true }, ctx));
  assert.strictEqual(r.text, 'final only');
  assert.deepStrictEqual(log.texts, ['final only']);
  assert.strictEqual(r.error, null);
});

t('Claude:result is_error 變成錯誤;CLI 非零結束且沒輸出時回報結束代碼', async () => {
  const { ctx } = makeCtx();
  const bad = await withEnv({ FAKE_LOG: logFile, FAKE_MODE: 'error' }, () => claude.run({ model: '', effort: '', canEdit: true }, ctx));
  assert.strictEqual(bad.error, 'rate limited');
  assert.strictEqual(bad.sessionId, 'c-sess-1', '出錯也要保留 session,下一回合才能續接');
  const crash = await withEnv({ FAKE_LOG: logFile, FAKE_MODE: 'crash' }, () => claude.run({ model: '', effort: '', canEdit: true }, ctx));
  assert.match(crash.error, /結束代碼 2/);
  assert.match(crash.error, /not logged in/);
  assert.strictEqual(crash.text, '');
});

// ---------- Codex CLI ----------
t('Codex:第一回合的參數、沙箱、系統提示併入 stdin', async () => {
  const { ctx } = makeCtx();
  const r = await withEnv({ FAKE_LOG: logFile }, () => codex.run({ model: 'gpt-5.6-sol', effort: 'ultra', canEdit: true }, ctx));
  const { args, stdin } = readLog();
  assert.deepStrictEqual(args.slice(0, 6), ['exec', '-', '-C', tmp, '-s', 'workspace-write']);
  assert.ok(args.includes('--json') && args.includes('--skip-git-repo-check'));
  assert.strictEqual(args[args.indexOf('-m') + 1], 'gpt-5.6-sol');
  assert.ok(args.includes('model_reasoning_effort="ultra"'));
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(!args.some((a: any) => a.startsWith('sandbox_mode=')), '第一回合用 -s,不用 -c sandbox_mode');
  assert.strictEqual(stdin, 'SYS\n\n---\n\nhello', 'Codex 沒有系統提示參數,要併進第一則訊息');
  assert.strictEqual(r.error, null);
});

t('Codex:續接回合用 resume,唯讀時不帶 approval_policy,系統提示不重送', async () => {
  const { ctx } = makeCtx({ sessionId: 'thr-old' });
  await withEnv({ FAKE_LOG: logFile }, () => codex.run({ model: '', effort: '', canEdit: false }, ctx));
  const { args, stdin } = readLog();
  assert.deepStrictEqual(args.slice(0, 4), ['exec', 'resume', 'thr-old', '-']);
  assert.ok(args.includes('sandbox_mode="read-only"'));
  assert.ok(!args.includes('approval_policy="never"'));
  assert.ok(!args.includes('-m'));
  assert.strictEqual(stdin, 'hello');
});

t('Codex:模型不支援的強度會降到最接近的等級並留下註記', async () => {
  const { ctx, log } = makeCtx();
  await withEnv({ FAKE_LOG: logFile }, () => codex.run({ model: 'gpt-5.6-luna', effort: 'ultra', canEdit: true }, ctx));
  const { args } = readLog();
  const effortArg = args.find((a: any) => a.startsWith('model_reasoning_effort='));
  assert.ok(effortArg && effortArg !== 'model_reasoning_effort="ultra"', effortArg);
  assert.ok(activity(log, 'run-options').length === 1);
});

t('Codex:事件解析(thread、訊息更新、思考、指令、檔案變更、usage)', async () => {
  const { ctx, log } = makeCtx();
  const r = await withEnv({ FAKE_LOG: logFile }, () => codex.run({ model: '', effort: '', canEdit: true }, ctx));
  assert.deepStrictEqual(log.sessions, ['thr-9']);
  assert.strictEqual(r.sessionId, 'thr-9');
  assert.deepStrictEqual(log.texts, ['First', 'First part', 'First part\n\nSecond'], '同一則 item 的更新要取代,不同 item 依順序串接');
  assert.deepStrictEqual(log.thinking, ['thinking']);
  assert.strictEqual(r.text, 'First part\n\nSecond');
  assert.strictEqual(r.thinking, 'thinking');
  const cmd = activity(log, 'c1');
  assert.strictEqual(cmd[0].status, 'running');
  assert.ok(cmd[0].title.includes('npm test'));
  assert.strictEqual(cmd[1].status, 'error', 'exit_code 非 0 要標成 error');
  assert.strictEqual(cmd[1].result, 'fail');
  const files = activity(log, 'f1')[0];
  assert.strictEqual(files.status, 'done');
  assert.ok(files.title.includes('2'), files.title);
  assert.strictEqual(files.detail, 'add a.txt\nupdate b.txt');
  assert.deepStrictEqual(r.usage, { input_tokens: 50, cached_input_tokens: 10, output_tokens: 7 });
  assert.strictEqual(r.error, null);
});

t('Codex:turn.failed 的訊息成為錯誤,但已產生的文字保留', async () => {
  const { ctx } = makeCtx();
  const r = await withEnv({ FAKE_LOG: logFile, FAKE_MODE: 'fail' }, () => codex.run({ model: '', effort: '', canEdit: true }, ctx));
  assert.strictEqual(r.error, 'context overflow');
  assert.strictEqual(r.text, 'First part\n\nSecond');
  assert.strictEqual(r.usage, null);
});

t('Codex:CLI 非零結束且沒輸出時回報結束代碼與 stderr', async () => {
  const { ctx } = makeCtx();
  const r = await withEnv({ FAKE_LOG: logFile, FAKE_MODE: 'crash' }, () => codex.run({ model: '', effort: '', canEdit: true }, ctx));
  assert.match(r.error, /結束代碼 3/);
  assert.match(r.error, /auth expired/);
  assert.strictEqual(r.text, '');
});

t('找不到指令時回報無法啟動,而不是丟例外', async () => {
  const { ctx } = makeCtx();
  const r = await withEnv({ FAKE_LOG: logFile, PATH: path.join(tmp, 'nowhere') }, () => claude.run({ model: '', effort: '', canEdit: true }, ctx));
  assert.match(r.error, /無法啟動 claude/);
});

(async () => {
  let n = 0;
  for (const { name, fn } of tests) {
    await fn();
    n++;
    console.log('ok -', name);
  }
  console.log(`${n} 項測試全部通過`);
})().catch((error: any) => {
  console.error(error);
  process.exit(1);
});
