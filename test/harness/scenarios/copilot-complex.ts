import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Script } from 'node:vm';
import { report, runApp } from '../app';
import { liveRunPassed, saveLiveEvidence } from './copilot-live';

const TASK = `Build a dependency-aware workflow scheduling library and JSON CLI from scratch in this project.
Use Node.js CommonJS and the standard library only. Implement real reusable logic in multiple modules under src/, plus cli.js. Do not execute real jobs: this is a deterministic virtual-time simulation.

API: require('./src/scheduler').schedule(tasks, options = {}) returns exactly { tasks: [{ id, start, finish, status }], makespan }.
Input task: { id, duration, dependsOn = [], priority = 0, resources = {}, fail = false }.
Options: { concurrency = 2, capacities = {} }.
IDs are unique nonempty strings (including ordinary object-property names). Duration and concurrency are positive safe integers. Priority is a safe integer (negative allowed). dependsOn is an array of unique existing IDs. Resources and capacities are plain objects mapping resource names to positive safe integers; every requested resource must be declared and each request must fit its capacity. fail must be boolean. Reject malformed tasks/options, duplicate IDs/dependencies, unknown dependencies, self-dependencies and any cycle with an Error. Validate the entire graph even if a cycle is disconnected. An empty task list is valid with makespan 0. Never mutate inputs.

At virtual time 0 and each completion time, finish ALL jobs ending at that time and release their resources BEFORE starting anything. A task is ready only after all dependencies succeeded. Fill free concurrency slots greedily: consider ready tasks by descending priority, then original input order. If one does not fit available resources, skip it and consider later candidates. Running jobs are never preempted. No artificial delay when work fits. Integer durations define half-open intervals [start, finish). A job with fail=true still runs for its full duration, then fails. All direct/transitive dependents of a failed job are blocked and never run; independent branches continue. End when all tasks are succeeded, failed, or blocked.

Return tasks in ORIGINAL INPUT ORDER. Running tasks end with status succeeded or failed and integer start/finish. Blocked tasks have status blocked and start/finish null. makespan is the latest actual completion time, or 0 for empty input. The input must not be modified. Scheduling must be deterministic and handle at least 500 jobs efficiently.

CLI: node cli.js reads exactly one JSON document {tasks, options?} from stdin and prints exactly one JSON result plus newline on stdout. Invalid JSON or invalid scheduling input: nonzero exit, no stdout, a useful error on stderr, no uncaught stack trace. No network calls, package installations, shell execution, or external side effects. Provide examples/build.json with a nontrivial six-job workflow including CPU/memory capacities and a dependency join.

Only create or edit src/**, cli.js, and examples/**. package.json and test/public.test.js are fixed acceptance files: do not change or bypass them. Do not commit or push. Do not read outside the project. Hidden edge-case checks will run after completion, but are not available to you.
Plan concrete implementation tasks for the two writable members (core and integration), not implementation tasks for the read-only planner. The integrator must use the core author's API. Run npm test and the example CLI. Review the actual files and these requirements, not just the authors' reports. Do not ask the user questions: choose implementation details within this contract.`;

const PUBLIC_TESTS = String.raw`
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { schedule } = require('../src/scheduler');
assert.equal(typeof schedule, 'function', 'scheduler must export schedule');
test('empty workflow', () => assert.deepEqual(schedule([]), { tasks: [], makespan: 0 }));
test('priority, input order, concurrency and dependency join', () => {
  const tasks = [
    { id: 'slow', duration: 4 }, { id: 'fast', duration: 2, priority: 1 },
    { id: 'join', duration: 3, dependsOn: ['slow', 'fast'] },
  ];
  assert.deepEqual(schedule(tasks), { tasks: [
    { id: 'slow', start: 0, finish: 4, status: 'succeeded' },
    { id: 'fast', start: 0, finish: 2, status: 'succeeded' },
    { id: 'join', start: 4, finish: 7, status: 'succeeded' },
  ], makespan: 7 });
});
test('resource capacity serializes otherwise independent work', () => {
  const result = schedule([{ id: 'a', duration: 3, resources: { cpu: 2 } }, { id: 'b', duration: 2, resources: { cpu: 1 } }], { concurrency: 2, capacities: { cpu: 2 } });
  assert.deepEqual(result.tasks.map(task => [task.start, task.finish]), [[0, 3], [3, 5]]);
});
test('failures block descendants, not independent branches', () => {
  const result = schedule([{ id: 'bad', duration: 1, fail: true }, { id: 'child', duration: 1, dependsOn: ['bad'] }, { id: 'ok', duration: 3 }]);
  assert.deepEqual(result, { tasks: [
    { id: 'bad', start: 0, finish: 1, status: 'failed' },
    { id: 'child', start: null, finish: null, status: 'blocked' },
    { id: 'ok', start: 0, finish: 3, status: 'succeeded' },
  ], makespan: 3 });
});
test('invalid graphs and requests are rejected', () => {
  assert.throws(() => schedule([{ id: 'a', duration: 1, dependsOn: ['b'] }, { id: 'b', duration: 1, dependsOn: ['a'] }]));
  assert.throws(() => schedule([{ id: 'a', duration: 1, resources: { cpu: 3 } }], { capacities: { cpu: 2 } }));
  assert.throws(() => schedule([{ id: 'a', duration: 1, dependsOn: ['missing'] }]));
});
test('CLI is usable and invalid JSON is rejected cleanly', () => {
  const run = spawnSync(process.execPath, ['cli.js'], { input: JSON.stringify({ tasks: [{ id: 'cli', duration: 2 }] }), encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), schedule([{ id: 'cli', duration: 2 }]));
  const bad = spawnSync(process.execPath, ['cli.js'], { input: '{', encoding: 'utf8', timeout: 5000 });
  assert.notEqual(bad.status, 0);
  assert.equal(bad.stdout, '');
  assert.ok(bad.stderr.trim());
    assert.doesNotMatch(bad.stderr, /\n\s+at /);
});
`;

export const HIDDEN_TESTS = String.raw`
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const root = process.env.WORKFLOW_PROJECT;
const { schedule } = require(path.join(root, 'src/scheduler'));
assert.equal(typeof schedule, 'function', 'scheduler must export schedule');
const timings = result => result.tasks.map(task => [task.id, task.start, task.finish, task.status]);
test('single slot obeys priority then input order, not lexical ID', () => {
  const result = schedule([{ id: 'z', duration: 2 }, { id: 'a', duration: 1 }, { id: 'high', duration: 1, priority: 9 }], { concurrency: 1 });
  assert.deepEqual(timings(result), [['z', 1, 3, 'succeeded'], ['a', 3, 4, 'succeeded'], ['high', 0, 1, 'succeeded']]);
});
test('simultaneous completions are batched before choosing new work', () => {
  const result = schedule([
    { id: 'a', duration: 2 }, { id: 'b', duration: 2 },
    { id: 'low', duration: 1, dependsOn: ['a'] },
    { id: 'high', duration: 1, dependsOn: ['a', 'b'], priority: 10 },
    { id: 'mid', duration: 1, dependsOn: ['b'], priority: 5 },
  ]);
  assert.deepEqual(result.tasks.map(task => task.start), [0, 0, 3, 2, 2]);
  assert.equal(result.makespan, 4);
});
test('resource-blocked high-priority work does not stall a fitting job', () => {
  const result = schedule([
    { id: 'running', duration: 5, priority: 10, resources: { cpu: 2 } },
    { id: 'large', duration: 1, priority: 9, resources: { cpu: 2 } },
    { id: 'small', duration: 2, priority: 1, resources: { cpu: 1 } },
  ], { concurrency: 3, capacities: { cpu: 3 } });
  assert.deepEqual(result.tasks.map(task => task.start), [0, 5, 0]);
  assert.equal(result.makespan, 6);
});
test('all resource dimensions constrain scheduling', () => {
  const result = schedule([
    { id: 'a', duration: 3, resources: { cpu: 1, memory: 3 } },
    { id: 'b', duration: 1, resources: { cpu: 1, memory: 2 } },
    { id: 'c', duration: 2, resources: { cpu: 1, memory: 1 } },
  ], { concurrency: 3, capacities: { cpu: 3, memory: 4 } });
  assert.deepEqual(result.tasks.map(task => task.start), [0, 3, 0]);
});
test('out-of-order dependencies and transitive failures', () => {
  const result = schedule([
    { id: 'leaf', duration: 1, dependsOn: ['middle'] },
    { id: 'middle', duration: 1, dependsOn: ['bad'] },
    { id: 'bad', duration: 4, fail: true },
    { id: 'independent', duration: 6 },
  ]);
  assert.deepEqual(result.tasks.map(task => task.status), ['blocked', 'blocked', 'failed', 'succeeded']);
  assert.equal(result.tasks[0].start, null);
  assert.equal(result.tasks[1].finish, null);
  assert.equal(result.makespan, 6);
});
test('join stays blocked even if its successful dependency finishes later', () => {
  const result = schedule([{ id: 'bad', duration: 1, fail: true }, { id: 'good', duration: 9 }, { id: 'join', duration: 1, dependsOn: ['bad', 'good'] }]);
  assert.equal(result.tasks[2].status, 'blocked');
  assert.equal(result.makespan, 9);
});
test('special object-property IDs are ordinary task IDs', () => {
  const result = schedule([{ id: '__proto__', duration: 1 }, { id: 'constructor', duration: 2, dependsOn: ['__proto__'] }, { id: 'toString', duration: 1, dependsOn: ['constructor'] }]);
  assert.deepEqual(result.tasks.map(task => task.finish), [1, 3, 4]);
});
for (const name of ['__proto__', 'constructor', 'toString']) {
  test('declared resource capacity is enforced for ' + name, () => {
    const resources = Object.fromEntries([[name, 1]]);
    const tasks = [{ id: 'a', duration: 1, resources }, { id: 'b', duration: 1, resources }];
    const options = { capacities: resources, concurrency: 2 };
    const result = schedule(tasks, options);
    assert.deepEqual(timings(result), [['a', 0, 1, 'succeeded'], ['b', 1, 2, 'succeeded']]);
    assert.equal(result.makespan, 2);
    const cli = spawnSync(process.execPath, ['cli.js'], { cwd: root, input: JSON.stringify({ tasks, options }), encoding: 'utf8', timeout: 5000 });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), result);
  });
}
for (const field of ['resources', 'capacities']) {
  test('non-plain ' + field + ' maps are rejected', () => {
    for (const value of [new Date(), new Map(), new (class Resources { constructor() { this.cpu = 1; } })(), Object.create({ cpu: 1 })]) {
      assert.throws(() => field === 'resources'
        ? schedule([{ id: 'a', duration: 1, resources: value }], { capacities: { cpu: 1 } })
        : schedule([{ id: 'a', duration: 1 }], { capacities: value }));
    }
  });
}
test('frozen inputs and repeat calls are unchanged and deterministic', () => {
  const deepFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
  const tasks = deepFreeze([{ id: 'b', duration: 2, priority: -2, resources: { cpu: 1 } }, { id: 'a', duration: 1, priority: -1, dependsOn: [] }]);
  const options = deepFreeze({ concurrency: 1, capacities: { cpu: 1 } });
  const before = JSON.stringify({ tasks, options });
  assert.deepEqual(schedule(tasks, options), schedule(tasks, options));
  assert.equal(JSON.stringify({ tasks, options }), before);
  assert.equal(schedule(tasks, options).tasks[1].start, 0);
});
test('malformed task entries and scalar fields are rejected', () => {
  for (const tasks of [null, {}, [null], [42], [{ id: '', duration: 1 }], [{ id: 1, duration: 1 }], [{ id: 'a', duration: 0 }], [{ id: 'a', duration: 1.5 }], [{ id: 'a', duration: Infinity }], [{ id: 'a', duration: 1, priority: NaN }], [{ id: 'a', duration: 1, fail: 'yes' }]]) assert.throws(() => schedule(tasks), JSON.stringify(tasks));
});
test('malformed options and resource maps are rejected', () => {
  const tasks = [{ id: 'a', duration: 1 }];
  for (const options of [null, [], { concurrency: 0 }, { concurrency: 1.5 }, { concurrency: '2' }, { capacities: [] }, { capacities: { cpu: 0 } }]) assert.throws(() => schedule(tasks, options), JSON.stringify(options));
  for (const resources of [[], null, { cpu: -1 }, { cpu: 0 }, { cpu: 1.5 }, { unknown: 1 }, { toString: 1 }, { constructor: 1 }]) assert.throws(() => schedule([{ id: 'a', duration: 1, resources }], { capacities: { cpu: 2 } }), JSON.stringify(resources));
});
test('duplicate IDs and dependency lists are rejected', () => {
  assert.throws(() => schedule([{ id: 'a', duration: 1 }, { id: 'a', duration: 2 }]));
  for (const dependsOn of ['a', null, ['a', 'a'], [42]]) assert.throws(() => schedule([{ id: 'a', duration: 1 }, { id: 'b', duration: 1, dependsOn }]));
});
test('disconnected cycles and self-loops cannot hide behind runnable jobs', () => {
  assert.throws(() => schedule([{ id: 'ok', duration: 1 }, { id: 'a', duration: 1, dependsOn: ['b'] }, { id: 'b', duration: 1, dependsOn: ['a'] }]));
  assert.throws(() => schedule([{ id: 'a', duration: 1, dependsOn: ['a'] }]));
});
test('500-job chain advances by events, not individual time units', { timeout: 5000 }, () => {
  const tasks = Array.from({ length: 500 }, (_, index) => ({ id: 'job-' + index, duration: 1000000, dependsOn: index ? ['job-' + (index - 1)] : [] }));
  const result = schedule(tasks);
  assert.equal(result.makespan, 500000000);
  assert.equal(result.tasks[499].start, 499000000);
});
test('generated DAG schedules satisfy dependency, capacity and concurrency invariants', () => {
  for (let seed = 1; seed <= 12; seed++) {
    let state = seed;
    const random = limit => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; };
    const tasks = Array.from({ length: 30 }, (_, index) => ({ id: 'job-' + index, duration: 1 + random(6), priority: random(5) - 2, resources: { cpu: 1 + random(2), memory: 1 + random(3) }, dependsOn: index > 0 && random(2) ? ['job-' + random(index)] : [], fail: index % 11 === 7 }));
    const result = schedule(tasks, { concurrency: 4, capacities: { cpu: 4, memory: 5 } });
    assert.deepEqual(result.tasks.map(task => task.id), tasks.map(task => task.id));
    const byId = new Map(result.tasks.map(task => [task.id, task]));
    for (const task of tasks) {
      const actual = byId.get(task.id);
      const parents = task.dependsOn.map(id => byId.get(id));
      if (parents.some(parent => parent.status !== 'succeeded')) {
        assert.deepEqual([actual.status, actual.start, actual.finish], ['blocked', null, null]);
      } else {
        assert.equal(actual.status, task.fail ? 'failed' : 'succeeded');
        assert.equal(actual.finish - actual.start, task.duration);
        assert.ok(actual.start >= 0);
        assert.ok(parents.every(parent => parent.finish <= actual.start));
      }
    }
    const ran = result.tasks.filter(task => task.start !== null);
    assert.equal(result.makespan, Math.max(0, ...ran.map(task => task.finish)));
    for (const time of new Set(ran.flatMap(task => [task.start, task.finish]))) {
      const active = tasks.filter(task => { const actual = byId.get(task.id); return actual.start !== null && actual.start <= time && time < actual.finish; });
      assert.ok(active.length <= 4);
      assert.ok(active.reduce((sum, task) => sum + task.resources.cpu, 0) <= 4);
      assert.ok(active.reduce((sum, task) => sum + task.resources.memory, 0) <= 5);
    }
  }
});
test('CLI rejects invalid semantic input without stdout or a stack trace', () => {
  for (const input of ['null', '{}', '{"tasks":{}}', '{"tasks":[{"id":"a","duration":0}]}']) {
    const result = spawnSync(process.execPath, [path.join(root, 'cli.js')], { input, encoding: 'utf8', timeout: 5000 });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.trim());
     assert.doesNotMatch(result.stderr, /\n\s+at /);
  }
});
test('CLI output matches library, emits a newline and supports empty input tasks', () => {
  for (const tasks of [[], [{ id: 'a', duration: 2 }, { id: 'b', duration: 1, dependsOn: ['a'] }]]) {
    const result = spawnSync(process.execPath, [path.join(root, 'cli.js')], { input: JSON.stringify({ tasks, options: { concurrency: 1 } }), encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
      assert.ok(result.stdout.endsWith('\n'));
    assert.deepEqual(JSON.parse(result.stdout), schedule(tasks, { concurrency: 1 }));
  }
});
test('example is executable and implementation spans reusable modules', () => {
  const input = fs.readFileSync(path.join(root, 'examples/build.json'), 'utf8');
  const example = JSON.parse(input);
  assert.ok(example.tasks.length >= 6);
  assert.ok(example.tasks.some(task => task.dependsOn?.length >= 2));
  const resources = Object.keys(example.options.capacities);
  assert.ok(resources.length >= 2);
  assert.ok(resources.every(resource => example.options.capacities[resource] > 0 && example.tasks.some(task => task.resources?.[resource] > 0)));
  const result = spawnSync(process.execPath, [path.join(root, 'cli.js')], { input, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), schedule(example.tasks, example.options));
  assert.ok(fs.readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.js')).length >= 2);
});
`;

const FILES = {
  'package.json': JSON.stringify({ name: 'workflow-scheduler-trial', private: true, scripts: { test: 'node --test test/public.test.js' } }, null, 2) + '\n',
  'src/scheduler.js': 'module.exports = {};\n',
  'test/public.test.js': PUBLIC_TESTS,
};

function runChecks(workDir: string, file: string) {
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], {
    cwd: workDir, env: { ...process.env, WORKFLOW_PROJECT: workDir }, encoding: 'utf8', timeout: 30000,
  });
  return { passed: run.status === 0, status: run.status, signal: run.signal, stdout: run.stdout || '', stderr: run.stderr || '', error: run.error?.message };
}

async function main() {
  new Script(PUBLIC_TESTS);
  new Script(HIDDEN_TESTS);
  const recheckIndex = process.argv.indexOf('--recheck');
  if (recheckIndex !== -1) {
    assert.ok(process.argv[recheckIndex + 1], '--recheck requires an existing trial work directory');
    const workDir = fs.realpathSync(process.argv[recheckIndex + 1]);
    const trialDir = path.dirname(workDir);
    const original = JSON.parse(fs.readFileSync(path.join(trialDir, 'workflow-evidence.json'), 'utf8'));
    assert.equal(original.task, TASK);
    const testFile = path.join(trialDir, 'held-out.corrected.test.cjs');
    fs.writeFileSync(testFile, HIDDEN_TESTS);
    const checks = runChecks(workDir, testFile);
    fs.writeFileSync(path.join(trialDir, 'workflow-recheck.json'), JSON.stringify({
      note: 'Corrected an over-specific resource-name assertion. Implementation and original evidence are unchanged; original guard result still applies.',
      originalGuard: original.result?.guard, checks,
    }, null, 2));
    console.log(checks.stdout, checks.stderr);
    if (!checks.passed) process.exitCode = 1;
    return;
  }
  if (process.argv.includes('--dry-run')) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-spec-'));
    try {
      for (const [relative, content] of Object.entries(FILES)) {
        const file = path.join(workDir, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      }
      const baseline = runChecks(workDir, 'test/public.test.js');
      assert.equal(baseline.passed, false);
      assert.match(baseline.stdout, /scheduler must export schedule/);
      console.log('Specification scripts parse; public baseline fails as expected. No model calls.');
    } finally { fs.rmSync(workDir, { recursive: true, force: true }); }
    return;
  }
  if (process.env.COPILOT_LIVE !== '1') {
    console.log('Skipped: COPILOT_LIVE=1 is required to use Copilot quota.');
    return;
  }
  let initialHead = '';
  const result = await runApp({
    members: [
      { id: 'lead', name: 'Planner', cli: 'copilot', model: 'gpt-5-mini', canEdit: false, persona: 'Plan the implementation and review the actual result against the full contract. Assign implementation to the two writable members.' },
      { id: 'author', name: 'Core author', cli: 'copilot', model: 'claude-haiku-4.5', canEdit: true, persona: 'Implement the scheduler core, graph validation and reusable internal modules. Review the integration independently.' },
      { id: 'integrator', name: 'Integrator', cli: 'copilot', model: 'gpt-5.4-mini', canEdit: true, persona: 'Implement the CLI and example using the agreed scheduler API. Verify integration and independently review the scheduling algorithm.' },
    ],
    files: FILES,
    constants: { task: TASK, continuePlan: process.argv.includes('--continue-plan') },
    git: true,
    beforeLaunch: ({ workDir }) => { initialHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workDir, encoding: 'utf8' }).trim(); },
    settings: { leadAgentId: 'lead', mode: 'guarded', workStyle: 'code', discussionMode: 'independent-first', maxRounds: 3, verifyCommand: 'npm test', allowGitCommit: false, allowGitPush: false, uiLocale: 'zh-Hant' },
    timeoutMs: 30 * 60 * 1000,
    scenario: async (context) => {
      const harness: any = globalThis;
      await harness.ready();
      let messages = await harness.send(context.task, 'guarded');
      let planContinuations = 0;
      const blocked = messages.find((message: any) => message.planResumable);
      if (context.continuePlan && blocked) {
        const button = document.querySelector(`#timeline [data-msg-id="${blocked.id}"] .ts-plan-resume`) as HTMLButtonElement;
        harness.check(!!button, '計畫阻擋後可從結果卡續訂一次');
        button.click();
        await harness.waitFor(() => !button.isConnected, 30000, '續訂入口已消耗');
        await harness.waitIdle(20 * 60 * 1000);
        messages = (await harness.snapshot()).messages;
        planContinuations = 1;
      }
      const turns = messages.filter((message: any) => message.kind === 'agent');
      const summary = [...messages].reverse().find((message: any) => message.taskSummary)?.taskSummary;
      await harness.shot('copilot-workflow');
      return {
        planContinuations,
        errors: turns.filter((message: any) => message.error).map((message: any) => `${message.agentName}: ${message.error}`),
        phases: turns.map((message: any) => `${message.agentName}:${message.phase?.code || '-'}`),
        guard: summary?.guard, verify: summary?.verify,
        members: summary?.members?.map((member: any) => ({ name: member.name, outcome: member.outcome, files: member.files })),
        audits: harness.toolAudits(messages), messages,
      };
    },
  });
  const evidence = path.join(result.tmp, 'workflow-evidence.json');
  const hiddenFile = path.join(result.tmp, 'held-out.test.cjs');
  fs.writeFileSync(hiddenFile, HIDDEN_TESTS);
  const publicChecks = runChecks(result.workDir, 'test/public.test.js');
  const hiddenChecks = runChecks(result.workDir, hiddenFile);
  const protectedUnchanged = result.read('test/public.test.js') === FILES['test/public.test.js'] && result.read('package.json') === FILES['package.json'];
  const headUnchanged = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: result.workDir, encoding: 'utf8' }).trim() === initialHead;
  const passed = result.ok && liveRunPassed(result.value, publicChecks.passed && hiddenChecks.passed, protectedUnchanged, headUnchanged);
  saveLiveEvidence(result, 'workflow-evidence.json', { task: TASK, passed, elapsedMs: result.elapsedMs, result: result.value, publicChecks, hiddenChecks, protectedUnchanged, headUnchanged, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut, error: result.error });
  const { messages, audits, ...summary } = result.value || {};
  report('Copilot complex workflow trial', { ...result, value: { ...summary, turns: messages?.filter((message: any) => message.kind === 'agent').length, audits: audits?.length } });
  console.log(publicChecks.stdout, publicChecks.stderr);
  console.log(hiddenChecks.stdout, hiddenChecks.stderr);
  console.log(JSON.stringify({ passed, protectedUnchanged, headUnchanged, workDir: result.workDir, evidence, gitNumstat: result.numstat() }, null, 2));
  if (!passed) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });