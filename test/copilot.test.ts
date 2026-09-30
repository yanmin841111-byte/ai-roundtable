import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { copilotArgs, createCopilotAdapter, parseCopilotModels } from '../src/adapters/copilot';
import { builtinAdapters } from '../src/adapters/builtin';
import type { AgentConfig, Activity, ChatMessage } from '../src/ipc-types';
import type { RunContext } from '../src/adapters/types';
import { liveRunPassed, saveLiveEvidence, unresolvedLiveErrors } from './harness/scenarios/copilot-live';
import { batchPlan, batchPassed, type BatchRecord } from './harness/scenarios/copilot-batch';

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

test('live acceptance requires approved guard, members, tests and unchanged Git history', () => {
  const value = { guard: { status: 'passed' }, verify: 'passed', errors: [], members: [{ outcome: 'approved' }] };
  assert.equal(liveRunPassed(value, true, true, true), true);
  for (const invalid of [undefined, {}, { ...value, guard: { status: 'blocked' } }, { ...value, verify: 'failed' }, { ...value, errors: ['timeout'] }, { ...value, members: [] }, { ...value, members: [{ outcome: 'unresolved' }] }]) {
    assert.equal(liveRunPassed(invalid, true, true, true), false);
  }
  assert.equal(liveRunPassed(value, false, true, true), false);
  assert.equal(liveRunPassed(value, true, false, true), false);
  assert.equal(liveRunPassed(value, true, true, false), false);
});

test('live acceptance retains history but recognizes only same-pair recovered review errors', () => {
  const failed: Partial<ChatMessage> = {
    kind: 'agent', agentId: 'reviewer', agentName: 'Reviewer', status: 'error', error: 'timeout',
    phase: { code: 'review' }, review: { target: 'Author', targetId: 'author', access: 'open', scope: 'listed', files: [], more: 0, omitted: [], unreadable: [] },
  };
  const recovered: Partial<ChatMessage> = { ...failed, status: 'done', error: undefined, text: '[NO_ISSUES]' };
  const messages = [failed, recovered];
  assert.deepEqual(unresolvedLiveErrors(messages), []);
  assert.equal(messages[0].error, 'timeout');
  const value = { guard: { status: 'passed' }, verify: 'passed', errors: ['historical timeout'], members: [{ outcome: 'approved' }], messages };
  assert.equal(liveRunPassed(value, true, true, true), true);
  for (const unresolved of [
    [failed],
    [failed, { ...recovered, agentId: 'other' }],
    [failed, { ...recovered, review: { ...failed.review!, targetId: 'other' } }],
    [failed, { ...recovered, text: '' }],
    [failed, recovered, failed],
    [{ ...failed, phase: { code: 'execute' } }, recovered],
    [{ ...failed, phase: { code: 'discuss' } }, recovered],
  ] as Array<Array<Partial<ChatMessage>>>) {
    assert.ok(unresolvedLiveErrors(unresolved).length);
    assert.equal(liveRunPassed({ ...value, messages: unresolved }, true, true, true), false);
  }
});

test('live evidence archives failed runs without overwriting history or copying user data', () => {
  const source = fs.mkdtempSync(path.join(tmp, 'evidence-'));
  const workDir = path.join(source, 'work');
  fs.mkdirSync(path.join(workDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(workDir, 'result.js'), 'incomplete');
  fs.writeFileSync(path.join(source, 'private-config.json'), 'not for archive');
  const shot = path.join(source, 'screen.png');
  fs.writeFileSync(shot, 'image fixture');
  const destination = path.join(tmp, 'archive');
  const result = { tmp: source, workDir, shots: { screen: shot } };
  const evidence = { passed: false, errors: ['review failed'] };
  saveLiveEvidence(result, 'live-evidence.json', evidence, destination);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination, 'live-evidence.json'), 'utf8')), evidence);
  assert.equal(fs.readFileSync(path.join(destination, 'work/result.js'), 'utf8'), 'incomplete');
  assert.equal(fs.existsSync(path.join(destination, 'work/.git')), false);
  assert.equal(fs.existsSync(path.join(destination, 'private-config.json')), false);
  assert.equal(fs.existsSync(path.join(destination, 'shots/screen.png')), true);
  assert.throws(() => saveLiveEvidence(result, 'live-evidence.json', { passed: true }, destination), /already exists/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(source, 'live-evidence.json'), 'utf8')), evidence);
});

test('live batch requires all 30 fixed attempts without omissions, duplicates or mixed versions', () => {
  const plan = batchPlan();
  assert.equal(plan.length, 30);
  for (const kind of ['pair', 'trio', 'complex']) assert.equal(plan.filter(attempt => attempt.kind === kind).length, 10);
  const records: BatchRecord[] = plan.map(attempt => ({ ...attempt, passed: true, evidencePassed: true, exitCode: 0, elapsedMs: 1, sourceHash: 'fixed' }));
  assert.equal(batchPassed(records, 'fixed'), true);
  assert.equal(batchPassed(records.slice(1), 'fixed'), false);
  assert.equal(batchPassed([...records, records[0]], 'fixed'), false);
  for (const changed of [
    { passed: false }, { evidencePassed: false }, { exitCode: 1 }, { exitCode: null },
    { sourceHash: 'changed' }, { id: records[1].id }, { kind: 'trio' as const },
  ]) assert.equal(batchPassed([{ ...records[0], ...changed }, ...records.slice(1)], 'fixed'), false);
});

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

test('reads every model from copilot help config and lists low-cost models first', () => {
  const models = parseCopilotModels(['  `logLevel`: log level.', '', '  `model`: AI model to use.', '    - "claude-sonnet-5"', '    - "gpt-5.4-mini"', '    - "claude-haiku-4.5"', '    - "gpt-5-mini"', '    - "gpt-5.5"', '', '  `contextTier`: tier.', '    - "default"'].join('\n'));
  assert.deepEqual(models.map(model => model.id), ['auto', 'gpt-5-mini', 'claude-haiku-4.5', 'gpt-5.4-mini', 'claude-sonnet-5', 'gpt-5.5']);
  assert.deepEqual(models.filter(model => model.lowCost).map(model => model.id), ['gpt-5-mini', 'claude-haiku-4.5', 'gpt-5.4-mini']);
  assert.deepEqual(models[0].efforts, []);
  assert.deepEqual(parseCopilotModels('no model section'), [models[0]]);
});

test('refreshModels replaces the fallback list with the CLI list without a model request', async () => {
  const bin = path.join(tmp, 'copilot-help');
  fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = help ] && [ "$2" = config ]; then printf '%s\\n' '  \`model\`: AI model.' '    - "claude-opus-5"' '    - "gpt-5-mini"'; fi\n`);
  fs.chmodSync(bin, 0o755);
  const adapter = createCopilotAdapter({ bin });
  await adapter.refreshModels!();
  assert.deepEqual(adapter.listModels!().models!.map(model => model.id), ['auto', 'gpt-5-mini', 'claude-opus-5']);
  assert.equal(adapter.listModels!().source, 'cli');
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

test('commits and pushes require separate explicit permissions', () => {
  for (const allowGit of [undefined, false, true]) for (const allowGitPush of [undefined, false, true]) {
    const args = copilotArgs({ canEdit: true, model: '', effort: '' }, { allowGit, allowGitPush });
    assert.ok(args.includes('--allow-all-tools'));
    assert.equal(args.includes('--deny-tool=shell(git commit)'), allowGit !== true);
    assert.equal(args.includes('--deny-tool=shell(git push)'), allowGitPush !== true);
  }
  assert.ok(copilotArgs({ canEdit: false, model: '', effort: '' }, {}).includes('--deny-tool=shell'));
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

test('the VS Code install shim does not count as an installed CLI', async () => {
  const shim = path.join(tmp, 'copilot-shim');
  fs.writeFileSync(shim, `#!/bin/sh\necho 'Cannot find GitHub Copilot CLI (https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli)' >&2\nprintf "Install GitHub Copilot CLI? ['y/N'] "\n`);
  fs.chmodSync(shim, 0o755);
  const result = await createCopilotAdapter({ bin: shim }).check!({ locale: 'en' });
  assert.equal(result.ok, false);
  assert.match(result.error!, /Command not found/);
  const vscodeDir = path.join(tmp, 'github.copilot-chat', 'copilotCli');
  fs.mkdirSync(vscodeDir, { recursive: true });
  const vscodeShim = path.join(vscodeDir, 'copilot');
  fs.writeFileSync(vscodeShim, '#!/bin/sh\nsleep 30\n');
  fs.chmodSync(vscodeShim, 0o755);
  const started = Date.now();
  assert.equal((await createCopilotAdapter({ bin: vscodeShim }).check!()).ok, false);
  assert.ok(Date.now() - started < 3000, 'the VS Code shim is rejected without waiting for its prompt');
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