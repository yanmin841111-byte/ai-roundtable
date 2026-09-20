'use strict';

// 單人 vs 圓桌:同一個模型、同一道題,「一個人做完」和「做完再給另一位審查、依意見修復」
// 各跑幾次,比較做對的比例、花的時間與 token。量的是交叉審查這一道關卡值不值得它的成本。
//
//   npm run eval:ab                         # 每題每種各 3 次
//   npm run eval:ab -- --runs 5 --save      # 結果寫進 eval/results/
//   npm run eval:ab -- --tasks semver,csv   # 只跑某幾題
//   npm run eval:ab -- --journal eval/results/run1.jsonl   # 每跑完一次記一行,中斷後同一個指令接著跑
//   EVAL_REVIEWER_CLI=claude npm run eval:ab  # 圓桌的審查者換成另一個模型(Claude Code,會用到訂閱額度)
//
// 兩種條件都在真的 app 裡跑(test/harness),只差在審查者是誰:
//   單人  主持人(腳本)把工作交給執行者;審查由腳本一律放行,不會進修復回合
//   圓桌  同樣的主持人與執行者,多一位同模型的成員:一起討論,並由它真的審查,有問題就進修復回合
// 主持人用腳本,是為了讓兩邊的分工完全相同,差別只剩「有沒有真的審查」。
//
// 模型寫的程式會在本機的子行程裡跑測試。預設用本機 Ollama,不花錢;換成付費模型前先想好次數。

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { runApp, REPO_ROOT } from '../test/harness/app';
import { scriptedMember } from '../test/harness/fixtures';
import { AB_TASKS } from './ab-tasks';
import type { AbTask } from './ab-tasks';
import { runHiddenTests } from './hidden-tests';
import { wilson, fisherExact, stratifiedPermutation } from './stats';
import { readJournal, appendJournal, remaining, staleCount } from './journal';

type Condition = 'solo' | 'roundtable';
const CLI = process.env.EVAL_CLI || 'ollama';
const MODEL = process.env.EVAL_MODEL ?? 'qwen3.8:27b-mlx';
const ADAPTER = process.env.EVAL_ADAPTER ?? 'ollama-api';
// 圓桌裡的審查者可以換成另一個模型(沒給就跟執行者一樣):同一個模型的盲點會重疊,
// 換一個模型審,才量得到「不同的眼睛」有沒有用
const REVIEWER_CLI = process.env.EVAL_REVIEWER_CLI || CLI;
const REVIEWER_MODEL = process.env.EVAL_REVIEWER_MODEL ?? (process.env.EVAL_REVIEWER_CLI ? '' : MODEL);
const REVIEWER_ADAPTER = process.env.EVAL_REVIEWER_ADAPTER ?? (process.env.EVAL_REVIEWER_CLI ? '' : ADAPTER);
const EXECUTOR = '執行者';

interface AbRun {
  pass: number;
  total: number;
  seconds: number;
  inputTokens: number;
  outputTokens: number;
  // 圓桌:審查有沒有要求修復
  repaired: boolean;
  // 執行回合回報失敗(例如工具呼叫往返超過上限)。照樣計分:檔案寫到哪裡就量到哪裡,
  // 這本來就是「交給它做」會得到的結果,排除掉反而會美化成績
  execFailed: boolean;
  // app 本身沒跑完(崩潰、逾時):量不到結果,不計分
  error: boolean;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? '' : null;
}

async function runOnce(task: AbTask, cond: Condition, n: number): Promise<AbRun> {
  const lead = scriptedMember({
    id: 'lead', name: '主持人',
    plan: { summary: task.task, assignments: [{ agent: EXECUTOR, task: task.task }] },
    // 單人條件下它就是審查者:一律放行,等於沒有審查
    review: '看過了,沒有問題。\n[NO_ISSUES]',
  });
  const executor = { id: 'exec', name: EXECUTOR, cli: CLI, model: MODEL, persona: '務實的工程師。先讀懂需求與既有程式,再動手。', canEdit: true };
  const reviewer = { id: 'rev', name: '審查者', cli: REVIEWER_CLI, model: REVIEWER_MODEL, persona: '仔細的審查者。逐條對照需求,實際讀檔確認。', canEdit: false };
  // 審查者由流程挑選:候選人依成員順序,真的審查者要排在主持人前面才會被選到
  const members = cond === 'solo' ? [lead, executor] : [reviewer, lead, executor];
  const r = await runApp({
    members,
    adapters: [...new Set([ADAPTER, cond === 'roundtable' ? REVIEWER_ADAPTER : ''].filter(Boolean))].map((a) => `installed:${a}`),
    files: task.files,
    git: true,
    settings: { leadAgentId: 'lead', maxRounds: 1 },
    constants: { task: task.task, executor: EXECUTOR },
    timeoutMs: 40 * 60 * 1000,
    scenario: async (H: any) => {
      const g: any = globalThis;
      await g.ready();
      const msgs = await g.send(H.task, 'divide');
      const turns = msgs.filter((m: any) => m.kind === 'agent' && m.usage);
      const sum = (k: string) => turns.reduce((s: number, m: any) => s + (Number(m.usage[k]) || 0), 0);
      const exec = msgs.find((m: any) => m.kind === 'agent' && m.agentName === H.executor && m.phase && m.phase.code === 'execute');
      return {
        transcript: msgs.map((m: any) => ({ who: m.agentName || m.kind, phase: m.phase && m.phase.code, tag: m.tag, error: m.error || null, text: String(m.text || '').slice(0, 1500), activities: (m.activities || []).map((a: any) => a.title) })),
        execError: !exec || !!exec.error,
        repaired: msgs.some((m: any) => m.kind === 'agent' && m.phase && m.phase.code === 'repair'),
        inputTokens: sum('inputTokens'),
        outputTokens: sum('outputTokens'),
      };
    },
  });
  const v = r.value || {};
  const score = runHiddenTests(r.workDir, task);
  // EVAL_KEEP_DIR:沒有全對的那幾次,把工作目錄留一份下來看(不含 .git)
  if (process.env.EVAL_KEEP_DIR && score.pass < score.total) {
    const keep = path.join(process.env.EVAL_KEEP_DIR, `${task.id}-${cond}-${n}-${Date.now()}`);
    fs.cpSync(r.workDir, keep, { recursive: true, filter: (src) => !src.split(path.sep).includes('.git') });
    fs.writeFileSync(path.join(keep, '_transcript.json'), JSON.stringify(v.transcript || [], null, 2));
  }
  r.cleanup();
  const error = !r.ok;
  const run: AbRun = {
    pass: score.pass, total: score.total, seconds: Math.round(r.elapsedMs / 1000),
    inputTokens: v.inputTokens || 0, outputTokens: v.outputTokens || 0, repaired: !!v.repaired, execFailed: !!v.execError, error,
  };
  const tokens = run.inputTokens + run.outputTokens ? ` · token ${run.inputTokens}/${run.outputTokens}` : '';
  console.log(`  ${task.id} ${cond === 'solo' ? '單人' : '圓桌'} #${n}:${error ? `沒跑完(${r.error})` : `${run.pass}/${run.total}`}`
    + `${run.execFailed ? ' · 執行回合失敗' : ''}${cond === 'roundtable' ? ` · 修復:${run.repaired ? '是' : '否'}` : ''} · ${run.seconds}s${tokens}${score.error ? ` · 測試:${score.error}` : ''}${score.missing ? ` · 檔案不存在:${task.entry}` : ''}${score.loadError ? ` · 載入失敗:${score.loadError}` : ''}`);
  return run;
}

export interface AbSummary {
  runs: number;
  errors: number;
  // 以下只算沒有失敗的回合
  allPass: number;
  passRate: number; // 通過的測試項目 / 全部項目
  execFailed: number;
  avgSeconds: number;
  avgTokens: number;
}

export function summarize(runs: AbRun[]): AbSummary {
  const ok = runs.filter((r) => !r.error);
  const avg = (f: (r: AbRun) => number) => (ok.length ? Math.round(ok.reduce((s, r) => s + f(r), 0) / ok.length) : 0);
  const items = ok.reduce((s, r) => s + r.total, 0);
  return {
    runs: runs.length,
    errors: runs.length - ok.length,
    allPass: ok.filter((r) => r.total > 0 && r.pass === r.total).length,
    execFailed: ok.filter((r) => r.execFailed).length,
    passRate: items ? Math.round((ok.reduce((s, r) => s + r.pass, 0) / items) * 1000) / 1000 : 0,
    avgSeconds: avg((r) => r.seconds),
    avgTokens: avg((r) => r.inputTokens + r.outputTokens),
  };
}

function localDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function currentCommit(): string {
  try {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    return git('rev-parse', '--short', 'HEAD') + (git('status', '--porcelain', '--', '.', ':(exclude)eval/results') ? '-dirty' : '');
  } catch { return ''; }
}

async function main() {
  const commit = currentCommit();
  const runs = Math.max(1, Number(arg('runs') || 3));
  const only = (arg('tasks') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = only.filter((id) => !AB_TASKS.some((t) => t.id === id));
  if (unknown.length) throw new Error(`沒有這些題目:${unknown.join(', ')}(可用:${AB_TASKS.map((t) => t.id).join(', ')})`);
  // 預設跑難題組:基本題對 27B 本機模型太容易,兩邊都接近滿分,量不出差別
  const set = arg('set') || 'hard';
  const tasks = only.length ? AB_TASKS.filter((t) => only.includes(t.id)) : set === 'all' ? AB_TASKS : AB_TASKS.filter((t) => t.set === set);
  if (!tasks.length) throw new Error(`沒有題目(--set 可用 hard、basic、all)`);
  // --conditions solo:只跑單人,用來校準題目難度(正式實驗前先確認單人大約一半做得對)
  const conditions = (arg('conditions') || 'solo,roundtable').split(',').map((s) => s.trim()).filter((c): c is Condition => c === 'solo' || c === 'roundtable');
  const reviewerLabel = `${REVIEWER_CLI}${REVIEWER_MODEL ? ` / ${REVIEWER_MODEL}` : ''}`;
  console.log(`執行者:${CLI}${MODEL ? ` / ${MODEL}` : ''} · 圓桌的審查者:${reviewerLabel} · ${tasks.length} 題 × ${conditions.length} 種 × ${runs} 次`);

  // 流水帳:中斷後用同一個 --journal 接著跑(見 journal.ts)
  const journalFile = arg('journal') || '';
  const journal = readJournal(journalFile);
  const stale = staleCount(journal, commit);
  if (journalFile) {
    console.log(`流水帳:${journalFile}(已有 ${journal.length - stale} 次可以沿用${stale ? `,另有 ${stale} 次是別的程式版本,不採用` : ''})`);
  }
  const results: Record<string, Record<Condition, AbSummary>> = {};
  // 每次的測試通過比例(主要指標),依題目分層
  const rates: Record<string, { a: number[]; b: number[] }> = {};
  const rateOf = (runs: AbRun[]) => runs.filter((r) => !r.error && r.total > 0).map((r) => r.pass / r.total);
  for (const task of tasks) {
    console.log(`\n[${task.id}] ${task.asks}`);
    const by: Record<Condition, AbRun[]> = { solo: [], roundtable: [] };
    // 沿用流水帳裡同一個程式版本的結果
    for (const cond of conditions) {
      // 只沿用到這次要求的次數為止:上次用 --runs 8 跑過,這次只要 3 次時不能拿 8 次來算
      for (const e of journal.filter((x) => x.task === task.id && x.condition === cond && x.commit === commit).slice(0, runs)) by[cond].push(e.run as unknown as AbRun);
      const left = remaining(journal, task.id, cond, commit, runs);
      if (left < runs) console.log(`  (沿用 ${runs - left} 次,還要跑 ${left} 次)`);
    }
    // 交錯執行:兩種條件輪流跑,本機模型的狀態(快取、溫度)對兩邊的影響才會平均
    for (let i = 1; i <= runs; i++) {
      for (const cond of conditions) {
        if (by[cond].length >= runs) continue;
        const run = await runOnce(task, cond, i);
        by[cond].push(run);
        appendJournal(journalFile, { task: task.id, condition: cond, commit, run: run as unknown as Record<string, unknown> });
      }
    }
    results[task.id] = { solo: summarize(by.solo), roundtable: summarize(by.roundtable) };
    rates[task.id] = { a: rateOf(by.solo), b: rateOf(by.roundtable) };
  }

  const all = (cond: Condition) => Object.values(results).map((r) => r[cond]);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  console.log('\n========== 結果(app 沒跑完的不計)==========');
  console.log(`${'題目'.padEnd(12)}${'單人:全對 / 測試通過 / 平均秒數'.padEnd(34)}圓桌:全對 / 測試通過 / 平均秒數`);
  const line = (s: AbSummary) => `${s.allPass}/${s.runs - s.errors} · ${pct(s.passRate)} · ${s.avgSeconds}s${s.avgTokens ? ` · ${s.avgTokens} token` : ''}${s.execFailed ? ` · 執行失敗 ${s.execFailed}` : ''}${s.errors ? ` · 沒跑完 ${s.errors}` : ''}`;
  for (const [id, r] of Object.entries(results)) console.log(`${id.padEnd(14)}${line(r.solo).padEnd(36)}${line(r.roundtable)}`);
  const totals = (cond: Condition) => {
    const s = all(cond);
    const scored = s.reduce((n, x) => n + x.runs - x.errors, 0);
    return { ok: s.reduce((n, x) => n + x.allPass, 0), scored };
  };
  const solo = totals('solo');
  const round = totals('roundtable');
  for (const [label, t] of [['單人', solo], ['圓桌', round]] as const) {
    const [lo, hi] = wilson(t.ok, t.scored);
    console.log(`${label}合計:全對 ${t.ok}/${t.scored}(${pct(t.scored ? t.ok / t.scored : 0)},95% 信賴區間 ${pct(lo)}–${pct(hi)})`);
  }
  // 差距是不是運氣:p 值大就代表這個差距用運氣就解釋得了,還不能下結論
  const verdict = (x: number) => (x < 0.05 ? '(差距顯著)' : '(不顯著:這個差距用運氣就解釋得了)');
  const perm = stratifiedPermutation(Object.values(rates));
  const p = fisherExact(solo.ok, solo.scored - solo.ok, round.ok, round.scored - round.ok);
  if (conditions.length === 2) {
    console.log(`主要指標 測試通過比例:圓桌 − 單人 = ${perm.diff >= 0 ? '+' : ''}${(perm.diff * 100).toFixed(1)} 個百分點,分層置換檢定 p = ${perm.p.toFixed(3)}${verdict(perm.p)}`);
    console.log(`次要指標 全對率:Fisher 精確檢定 p = ${p.toFixed(3)}${verdict(p)}`);
  }

  if (arg('save') !== null) {
    const file = path.join(__dirname, 'results', `${localDate()}-ab-${`${CLI}-${MODEL || 'default'}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}.json`);
    const out = { schema: 1, kind: 'ab', set, primary: { metric: 'passRate', diff: Math.round(perm.diff * 1000) / 1000, p: Math.round(perm.p * 1000) / 1000 }, secondary: { metric: 'allPass', p: Math.round(p * 1000) / 1000 }, date: localDate(), app: { version: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version, commit }, model: { cli: CLI, model: MODEL }, reviewer: { cli: REVIEWER_CLI, model: REVIEWER_MODEL }, runsPerCondition: runs, tasks: results };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
    console.log(`\n結果已存到 ${path.relative(REPO_ROOT, file)}`);
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exitCode = 1; });
