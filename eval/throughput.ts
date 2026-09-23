'use strict';

// 多件獨立任務:同一批題目各放一個工作目錄,在同一個 app 裡一次送出。
// sequential 是同時上限 1(排隊一件件跑),concurrent 是上限 = 題數;其餘設定完全相同。
// 量整批完成時間(第一件送出到最後一件結束)與各題的隱藏測試通過比例。
//
//   npm run eval:throughput -- --dry-run --runs 4
//   npm run eval:throughput -- --approve-experiment --runs 4 --journal eval/results/x.journal --save

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { runApp, REPO_ROOT } from '../test/harness/app';
import type { HarnessMember } from '../test/harness/app';
import { scriptedMember } from '../test/harness/fixtures';
import { AB_TASKS } from './ab-tasks';
import type { AbTask } from './ab-tasks';
import { runHiddenTests } from './hidden-tests';
import { stratifiedPermutation } from './stats';
import { readJournal, appendJournal } from './journal';
import { positiveInteger } from './conditions';
import { currentCommit } from './ab';

const TEAM = (process.env.EVAL_TEAM || 'claude,codex').split(',').map((item) => item.trim()).filter(Boolean);
const CONDITIONS = ['sequential', 'concurrent'] as const;
type ThroughputCondition = typeof CONDITIONS[number];
const DEFAULT_TASKS = ['semver', 'intervals', 'duration', 'csv'];

interface BatchTask {
  id: string;
  cli: string;
  pass: number;
  total: number;
  failedTests?: string[];
  seconds: number | null;
  runSeconds: number | null;
  status: string;
  execFailed: boolean;
  inputTokens: number;
  outputTokens: number;
  usageComplete: boolean;
}

interface BatchRun {
  makespan: number;
  error: boolean;
  errorText?: string;
  tasks: BatchTask[];
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? '' : null;
}

const toAgent = (member: HarnessMember, index: number) => ({
  id: member.id, name: member.name, cli: member.cli, model: member.model || '', effort: '',
  persona: member.persona || '', color: ['#d97757', '#10a37f'][index % 2], canEdit: member.canEdit !== false,
  enabled: true, customCommand: member.customCommand || '',
});

function members(task: AbTask, cli: string): HarnessMember[] {
  const executor: HarnessMember = cli === 'scripted'
    ? scriptedMember({ id: 'exec', name: '執行者', canEdit: true, writes: task.reference, report: '完成', delayMs: 3000 })
    : { id: 'exec', name: '執行者', cli, model: '', persona: '務實的工程師。先讀懂需求與既有程式,再動手。', canEdit: true };
  return [
    scriptedMember({ id: 'lead', name: '主持人', plan: { summary: task.asks, assignments: [{ agent: '執行者', task: task.task }] }, review: '看過了,沒有問題。\n[NO_ISSUES]' }),
    executor,
  ];
}

export async function runBatch(tasks: AbTask[], condition: ThroughputCondition, launch: typeof runApp = runApp): Promise<BatchRun> {
  const items = tasks.map((task, i) => ({ id: task.id, dir: `work-${task.id}`, cli: TEAM[i % TEAM.length], task: task.task, agents: members(task, TEAM[i % TEAM.length]).map(toAgent) }));
  const r = await launch({
    members: members(tasks[0], items[0].cli),
    beforeLaunch: ({ tmp }) => {
      for (const item of items) {
        const dir = path.join(tmp, item.dir);
        fs.mkdirSync(dir, { recursive: true });
        const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
        git('init', '-q');
        git('-c', 'user.email=harness@example.com', '-c', 'user.name=harness', 'commit', '-qm', 'init', '--allow-empty');
      }
    },
    settings: { leadAgentId: 'lead', maxRounds: 1, maxParallelJobs: condition === 'sequential' ? 1 : items.length },
    constants: { items, limitMs: 110 * 60 * 1000 },
    timeoutMs: 120 * 60 * 1000,
    scenario: async (H: any) => {
      const g: any = globalThis;
      const api = (window as any).api;
      await g.ready();
      const base: string = (await api.getConfig()).settings.workDir;
      const root = base.slice(0, base.length - 'work'.length);
      const ids: string[] = [];
      const started = Date.now();
      for (const [i, item] of H.items.entries()) {
        if (i) {
          const before = api.jobs.current();
          g.$('#job-new').click();
          await g.waitFor(() => api.jobs.current() !== before, 5000, '開新任務');
        }
        ids.push(api.jobs.current());
        const cfg = await api.getConfig();
        cfg.settings.workDir = root + item.dir;
        cfg.agents = item.agents;
        await api.saveConfig(cfg);
        await api.send(item.task, 'divide');
      }
      const finished: Record<string, number> = {};
      const statuses: Record<string, string> = {};
      while (!ids.every((id) => finished[id])) {
        if (Date.now() - started > H.limitMs) throw new Error('批次在時限內沒有跑完');
        for (const job of (await api.jobs.list()).jobs) {
          if (ids.includes(job.id) && ['done', 'stopped', 'error'].includes(job.status) && !finished[job.id]) { finished[job.id] = Date.now(); statuses[job.id] = job.status; }
        }
        await g.w(1000);
      }
      const details = [];
      for (const id of ids) {
        await api.jobs.select(id);
        const msgs = (await api.snapshot()).messages;
        const user = msgs.find((m: any) => m.kind === 'user');
        const exec = msgs.find((m: any) => m.kind === 'agent' && m.agentName === '執行者' && m.phase && m.phase.code === 'execute');
        const measured = msgs.filter((m: any) => m.kind === 'agent' && m.cli !== 'custom');
        const sum = (k: string) => measured.reduce((s: number, m: any) => s + (Number(m.usage && m.usage[k]) || 0), 0);
        const userAt = user && user.ts ? new Date(user.ts).getTime() : NaN;
        details.push({
          seconds: Math.round((finished[id] - started) / 1000),
          runSeconds: Number.isFinite(userAt) ? Math.round((finished[id] - userAt) / 1000) : null,
          status: statuses[id],
          execFailed: !exec || !!exec.error,
          inputTokens: sum('inputTokens'),
          outputTokens: sum('outputTokens'),
          usageComplete: measured.length > 0 && measured.every((m: any) => typeof m.usage?.inputTokens === 'number' && typeof m.usage?.outputTokens === 'number'),
          transcript: msgs.map((m: any) => ({ who: m.agentName || m.kind, phase: m.phase && m.phase.code, error: m.error || null, text: String(m.text || '').slice(0, 1500) })),
        });
      }
      return { makespan: Math.round((Math.max(...Object.values(finished)) - started) / 1000), details };
    },
  });
  const v = r.value || {};
  const run: BatchRun = {
    makespan: typeof v.makespan === 'number' ? v.makespan : Math.round(r.elapsedMs / 1000),
    error: !r.ok,
    ...(r.ok ? {} : { errorText: String(r.error || 'app did not finish') }),
    tasks: items.map((item, i) => {
      const task = tasks[i];
      const detail = (v.details || [])[i] || {};
      const score = runHiddenTests(path.join(r.tmp, item.dir), task, 15000, true);
      return {
        id: item.id, cli: item.cli, pass: score.pass, total: score.total, failedTests: score.failedTests,
        seconds: detail.seconds ?? null, runSeconds: detail.runSeconds ?? null, status: detail.status || 'unknown',
        execFailed: detail.execFailed !== false, inputTokens: detail.inputTokens || 0, outputTokens: detail.outputTokens || 0,
        usageComplete: detail.usageComplete === true,
      };
    }),
  };
  try {
    if (process.env.EVAL_EVIDENCE_DIR) {
      const dir = path.join(process.env.EVAL_EVIDENCE_DIR, 'throughput');
      fs.mkdirSync(dir, { recursive: true });
      const files = Object.fromEntries(items.map((item) => [item.id, readTree(path.join(r.tmp, item.dir))]));
      fs.writeFileSync(path.join(dir, `${condition}-${Date.now()}.json`), JSON.stringify({ condition, run, transcripts: (v.details || []).map((d: any) => d.transcript), files, diagnostics: r.ok ? null : { error: r.error, stderr: r.stderr, exitCode: r.exitCode, timedOut: r.timedOut } }, null, 2));
    }
  } finally { r.cleanup(); }
  const line = run.tasks.map((t) => `${t.id}(${t.cli}) ${t.pass}/${t.total}${t.execFailed ? ' 執行失敗' : ''} · ${t.seconds ?? '?'}s`).join(' | ');
  console.log(`  ${condition}:${run.error ? `沒跑完(${run.errorText}) · ` : ''}整批 ${run.makespan}s · ${line}`);
  return run;
}

function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && fs.statSync(full).size <= 256 * 1024) out[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

async function main() {
  const flags = process.argv.slice(2);
  const switches = new Set(['--dry-run', '--save', '--approve-experiment']);
  const values = new Set(['--runs', '--tasks', '--journal']);
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (!switches.has(flag) && !values.has(flag)) throw new Error(`Invalid option: ${flag}`);
    if (values.has(flag) && (!flags[++index] || flags[index].startsWith('--'))) throw new Error(`Missing value: ${flag}`);
  }
  const runs = positiveInteger(arg('runs') ?? 4, 'runs');
  const ids = (arg('tasks') || DEFAULT_TASKS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  const tasks = ids.map((id) => AB_TASKS.find((task) => task.id === id));
  if (tasks.some((task) => !task) || tasks.some((task) => task!.files)) throw new Error('Tasks must exist and start from an empty directory');
  if (tasks.length < 2 || tasks.length > 6) throw new Error('Use 2 to 6 tasks (maxParallelJobs is capped at 6)');
  const commit = currentCommit();
  const specification = {
    version: 1, kind: 'throughput', conditions: CONDITIONS, runs, tasks: ids, team: TEAM,
    assignment: 'task i uses TEAM[i % TEAM.length]; scripted lead and scripted pass review; one discussion round',
    order: 'odd repetitions sequential first; even repetitions concurrent first',
  };
  const protocol = createHash('sha256').update(JSON.stringify({ specification, tasks })).digest('hex');
  if (arg('dry-run') !== null) { console.log(JSON.stringify({ commit, protocol, ...specification }, null, 2)); return; }
  if (!commit) throw new Error('Cannot identify the source version');
  if (arg('approve-experiment') === null) throw new Error('Inspect --dry-run, obtain approval and preregister before adding --approve-experiment');
  const journalFile = arg('journal') || '';
  const journal = readJournal(journalFile).filter((entry) => entry.commit === commit && entry.protocol === protocol);
  const by: Record<ThroughputCondition, BatchRun[]> = { sequential: [], concurrent: [] };
  for (const condition of CONDITIONS) by[condition] = journal.filter((entry) => entry.condition === condition).slice(0, runs).map((entry) => entry.run as unknown as BatchRun);
  console.log(`多件任務 ${ids.join(', ')} · ${TEAM.join(' / ')} · 每種 ${runs} 次${journalFile ? ` · 流水帳沿用 ${by.sequential.length + by.concurrent.length} 次` : ''}`);
  for (let i = 1; i <= runs; i++) {
    const order: ThroughputCondition[] = i % 2 ? ['sequential', 'concurrent'] : ['concurrent', 'sequential'];
    for (const condition of order) {
      if (by[condition].length >= i) continue;
      const run = await runBatch(tasks as AbTask[], condition);
      by[condition].push(run);
      appendJournal(journalFile, { task: 'batch', condition, commit, protocol, run: run as unknown as Record<string, unknown> });
    }
  }
  const ok = (condition: ThroughputCondition) => by[condition].filter((run) => !run.error);
  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
  const summary = Object.fromEntries(CONDITIONS.map((condition) => {
    const runsOk = ok(condition);
    const items = runsOk.flatMap((run) => run.tasks);
    return [condition, {
      batches: by[condition].length, errors: by[condition].length - runsOk.length,
      makespans: runsOk.map((run) => run.makespan), meanMakespan: mean(runsOk.map((run) => run.makespan)),
      allPass: items.filter((t) => t.pass === t.total).length, tasks: items.length,
      passRate: items.length ? Math.round(items.reduce((s, t) => s + t.pass, 0) / items.reduce((s, t) => s + t.total, 0) * 1000) / 1000 : null,
      execFailed: items.filter((t) => t.execFailed).length,
      meanRunSeconds: mean(items.map((t) => t.runSeconds).filter((x): x is number => x != null)),
      usageComplete: items.every((t) => t.usageComplete),
      tokens: items.every((t) => t.usageComplete) ? items.reduce((s, t) => s + t.inputTokens + t.outputTokens, 0) : null,
    }];
  }));
  const comparison = {
    makespan: stratifiedPermutation([{ a: ok('sequential').map((run) => run.makespan), b: ok('concurrent').map((run) => run.makespan) }]),
    passRate: stratifiedPermutation(ids.map((id) => ({
      a: ok('sequential').map((run) => run.tasks.find((t) => t.id === id)!).map((t) => t.pass / t.total),
      b: ok('concurrent').map((run) => run.tasks.find((t) => t.id === id)!).map((t) => t.pass / t.total),
    }))),
  };
  console.log('\n========== 結果(app 沒跑完的批次不計)==========');
  console.log(JSON.stringify({ summary, comparison }, null, 2));
  if (arg('save') !== null) {
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const file = path.join(__dirname, 'results', `${date}-throughput-${protocol.slice(0, 12)}-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({ schema: 1, kind: 'throughput', protocol, specification, date, app: { version: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version, commit }, summary, comparison, batches: by }, null, 2) + '\n');
    console.log(`\n結果已存到 ${path.relative(REPO_ROOT, file)}`);
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exitCode = 1; });
