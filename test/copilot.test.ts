import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createCopilotAdapter } from '../src/adapters/copilot';
import { builtinAdapters } from '../src/adapters/builtin';
import type { AgentConfig, Activity } from '../src/ipc-types';
import type { RunContext } from '../src/adapters/types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-copilot-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const fakeBin = path.join(tmp, 'copilot');
fs.writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require('fs');
if (process.argv.includes('--version')) { console.log('GitHub Copilot CLI fixture'); process.exit(0); }
let stdin = '';
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync('invocation.json', JSON.stringify({ args: process.argv.slice(2), stdin, cwd: process.cwd(), allowAll: process.env.COPILOT_ALLOW_ALL }));
  const script = JSON.parse(fs.readFileSync('events.json', 'utf8'));
  for (const event of script.events) console.log(typeof event === 'string' ? event : JSON.stringify(event));
  if (script.stderr) process.stderr.write(script.stderr);
  process.exitCode = script.code || 0;
  if (script.hang) setInterval(() => {}, 1000);
});
`);
fs.chmodSync(fakeBin, 0o755);

const agent = { cli: 'copilot', model: '', effort: '', canEdit: false } as AgentConfig;
const event = (type: string, data: unknown, extra = {}) => ({ type, data, ...extra });
async function run(events: unknown[], options: { code?: number; stderr?: string; hang?: boolean; sessionId?: string; canEdit?: boolean; timeoutMs?: number; cancel?: boolean } = {}) {
  const cwd = fs.mkdtempSync(path.join(tmp, 'turn-'));
  fs.writeFileSync(path.join(cwd, 'events.json'), JSON.stringify({ events, ...options }));
  const texts: string[] = [], thoughts: string[] = [], activities: Activity[] = [], sessions: string[] = [];
  const ctx: RunContext = {
    cwd, prompt: 'hello $(not-a-command)', systemPrompt: 'SYS', sessionId: options.sessionId,
    locale: 'en', timeoutMs: options.timeoutMs || 15000,
    onText: text => texts.push(text), onThinking: text => thoughts.push(text),
    onActivity: activity => activities.push(activity), onSession: id => sessions.push(id),
    onProc: child => { if (options.cancel) setTimeout(() => child.kill('SIGTERM'), 200); },
  };
  const result = await createCopilotAdapter({ bin: fakeBin }).run({ ...agent, canEdit: options.canEdit || false }, ctx);
  const invocation = JSON.parse(fs.readFileSync(path.join(cwd, 'invocation.json'), 'utf8'));
  return { result, invocation, texts, thoughts, activities, sessions };
}

test('registered as a built-in with safe attachment paths and a default model', () => {
  const adapter = builtinAdapters.find(entry => entry.id === 'copilot')!;
  assert.ok(adapter);
  assert.equal(adapter.bin, 'copilot');
  assert.equal(adapter.supportsResume, true);
  assert.equal(adapter.supportsEdit, true);
  assert.equal(adapter.capabilities?.attachmentsNeedCwd, true);
  assert.equal(adapter.usageShape, 'unknown');
  assert.equal(adapter.listModels!().models![0].id, 'auto');
  assert.equal(adapter.listModels!().source, 'builtin');
});

test('streamed messages and reasoning replace deltas by ID; child replies stay out of the main reply', async () => {
  const usage = { model: 'test-model', inputTokens: 100, outputTokens: 20, cost: 1 };
  const { result, invocation, texts, thoughts, activities, sessions } = await run([
    'startup noise', '{invalid json',
    event('session.start', { sessionId: 'session-1' }),
    event('assistant.reasoning_delta', { reasoningId: 'r1', deltaContent: 'Think' }),
    event('assistant.reasoning', { reasoningId: 'r1', content: 'Thinking' }),
    event('assistant.message_delta', { messageId: 'm1', deltaContent: 'Read' }, { id: 'delta-1' }),
    event('assistant.message_delta', { messageId: 'm1', deltaContent: 'Read' }, { id: 'delta-1' }),
    event('assistant.message', { messageId: 'm1', content: 'Reading.' }),
    event('tool.execution_start', { toolCallId: 'tool-1', toolName: 'view', arguments: { path: 'a.ts' } }),
    event('tool.execution_complete', { toolCallId: 'tool-1', success: true, result: { content: 'file content' } }),
    event('tool.execution_start', { toolCallId: 'tool-2', toolName: 'view' }),
    event('tool.execution_complete', { toolCallId: 'tool-2', success: false, error: { message: 'missing file' } }),
    event('assistant.message', { messageId: 'child-1', content: 'child reply' }, { agentId: 'child-agent' }),
    event('assistant.message', { messageId: 'child-2', content: 'legacy child reply', parentToolCallId: 'parent' }),
    event('assistant.usage', usage, { id: 'usage-1' }),
    event('assistant.usage', usage, { id: 'usage-1' }),
    event('assistant.usage', { model: 'test-model', outputTokens: 3 }),
    event('assistant.message', { messageId: 'm2', content: 'Done.' }),
    event('session.shutdown', { shutdownType: 'routine', modelMetrics: { cumulative: 9999 } }),
  ]);
  assert.equal(result.error, null);
  assert.equal(result.text, 'Reading.\n\nDone.');
  assert.equal(result.thinking, 'Thinking');
  assert.deepEqual(sessions, ['session-1']);
  assert.ok(texts.includes('Read'));
  assert.deepEqual(thoughts, ['Think', 'Thinking']);
  assert.deepEqual(result.usage, { requests: [usage, { model: 'test-model', outputTokens: 3 }] });
  assert.equal(activities[1].status, 'done');
  assert.equal(activities[3].status, 'error');
  assert.equal(activities[3].result, 'missing file');
  assert.equal(invocation.stdin, 'SYS\n\n---\n\nhello $(not-a-command)');
  assert.ok(!invocation.args.includes('-p'));
  assert.ok(invocation.args.includes('--available-tools=view,glob,grep'));
  assert.equal(invocation.allowAll, 'false');
});

test('a fresh session has an explicit UUID even when stdout omits session.start', async () => {
  const { result, invocation, sessions } = await run([
    event('assistant.message', { messageId: 'm1', content: 'hello' }),
    event('session.idle', {}),
  ]);
  const sessionId = invocation.args[invocation.args.indexOf('--session-id') + 1];
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(result.sessionId, sessionId);
  assert.deepEqual(sessions, [sessionId]);
  assert.equal(fs.realpathSync(invocation.args[invocation.args.indexOf('-C') + 1]), fs.realpathSync(invocation.cwd));
});

test('resume keeps the explicit session and omits the initial role prompt', async () => {
  const { result, invocation, sessions } = await run([
    event('session.resume', { eventCount: 10 }),
    event('assistant.message', { messageId: 'm1', content: 'continued' }),
    event('session.idle', {}),
  ], { sessionId: 'session-1', canEdit: true });
  assert.equal(result.error, null);
  assert.equal(result.sessionId, 'session-1');
  assert.deepEqual(sessions, []);
  assert.equal(invocation.stdin, 'hello $(not-a-command)');
  assert.equal(invocation.args[invocation.args.indexOf('--resume') + 1], 'session-1');
  assert.ok(!invocation.args.includes('--session-id'));
  assert.ok(invocation.args.includes('--allow-all-tools'));
});

test('authentication errors provide a login action; quota errors do not', async () => {
  const auth = await run([event('session.error', { errorType: 'authentication', message: 'expired' })]);
  assert.match(auth.result.error!, /copilot login/);
  assert.deepEqual(auth.result.fix, { command: 'copilot login' });
  const quota = await run([event('session.error', { errorType: 'quota', message: 'quota exceeded' })]);
  assert.equal(quota.result.error, 'quota exceeded');
  assert.equal(quota.result.fix, undefined);
});

test('partial replies do not hide nonzero exits or truncated streams', async () => {
  const partial = [event('assistant.message_delta', { messageId: 'm1', deltaContent: 'partial' })];
  const failed = await run(partial, { code: 1, stderr: 'connection lost' });
  assert.equal(failed.result.text, 'partial');
  assert.match(failed.result.error!, /connection lost/);
  assert.ok((await run(partial)).result.error);
  assert.ok((await run([event('session.idle', {})])).result.error);
});

test('timeout and cancellation stop the process and finish pending tool activities', async () => {
  const events = [event('tool.execution_start', { toolCallId: 'pending', toolName: 'view' })];
  const timedOut = await run(events, { hang: true, timeoutMs: 300 });
  assert.ok(timedOut.result.error);
  assert.equal(timedOut.activities.at(-1)?.status, 'error');
  const cancelled = await run(events, { hang: true, cancel: true });
  assert.ok(cancelled.result.error);
});

test('installation check uses the selected binary and reports missing commands', async () => {
  assert.equal((await createCopilotAdapter({ bin: fakeBin }).check!()).ok, true);
  assert.equal((await createCopilotAdapter({ bin: path.join(tmp, 'missing') }).check!()).ok, false);
});

test('live CLI: read-only tools, session resume and editing', { skip: process.env.COPILOT_LIVE !== '1', timeout: 180000 }, async () => {
  const cwd = fs.mkdtempSync(path.join(tmp, 'live-'));
  const marker = `copilot-${path.basename(cwd)}`;
  fs.writeFileSync(path.join(cwd, 'proof.txt'), marker);
  const adapter = createCopilotAdapter();
  const ctx: RunContext = {
    cwd, locale: 'en', timeoutMs: 80000,
    prompt: 'Read proof.txt with the view tool and report its exact contents. Also try to create blocked.txt with the same contents if a write tool is available. If not, just report the contents and that writing is unavailable. Do not delegate.',
    onText: () => {}, onThinking: () => {}, onActivity: () => {}, onSession: () => {}, onProc: () => {},
  };
  const first = await adapter.run({ ...agent, model: 'gpt-5.4-mini' }, ctx);
  assert.equal(first.error, null, JSON.stringify(first));
  assert.ok(first.text?.includes(marker), JSON.stringify(first));
  assert.ok(first.sessionId);
  assert.ok(!fs.existsSync(path.join(cwd, 'blocked.txt')));
  const second = await adapter.run({ ...agent, model: 'gpt-5.4-mini', canEdit: true }, {
    ...ctx, sessionId: first.sessionId,
    prompt: 'You can now edit files. Without reading proof.txt again, create result.txt containing the exact contents you read in the previous turn, then reply DONE. Do not delegate or run shell commands.',
  });
  assert.equal(second.error, null, JSON.stringify(second));
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(fs.readFileSync(path.join(cwd, 'result.txt'), 'utf8').trim(), marker);
});