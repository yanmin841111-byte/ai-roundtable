'use strict';

// 審查評測:真的模型當審查者,跑一組固定題目,輸出分數。
//
//   npm run eval                          # 每題 3 次,用本機 Ollama 的 qwen3.8:27b-mlx
//   npm run eval -- --runs 10 --save      # 每題 10 次,結果寫進 eval/results/
//   npm run eval -- --cases cross-file    # 只跑某幾題(逗號分隔)
//   EVAL_MODEL=gemma3:27b npm run eval    # 換模型
//
// 換審查者的 CLI:EVAL_CLI=claude EVAL_ADAPTER= npm run eval(內建 CLI 不需要複製 adapter)。
// 付費的 CLI 或 API 每跑一次都會花錢,請先想好次數。
//
// 這是評測,不是回歸測試:模型輸出每次不同,單次結果只是一個樣本。
// 每一次都是一個全新的 app、全新的拋棄式工作目錄,不碰使用者的設定與這個 repo。

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { runApp, REPO_ROOT } from '../test/harness/app';
import { scriptedMember } from '../test/harness/fixtures';
import { CASES } from './cases';
import type { EvalCase } from './cases';
import { scoreCase, buildResult, resultFileName } from './score';
import type { RunOutcome, CaseScore } from './score';
// 判定審查結論用跟產品完全相同的規則(第一版只看字串裡有沒有 [NO_ISSUES],把「[NO_ISSUES] 不可宣告」誤判成放行)
const { hasMarker } = require('../src/shared');

const REVIEWER = '審查者';
const CLI = process.env.EVAL_CLI || 'ollama';
const MODEL = process.env.EVAL_MODEL ?? 'qwen3.8:27b-mlx';
const ADAPTER = process.env.EVAL_ADAPTER ?? 'ollama-api';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? '' : null;
}

async function runOnce(c: EvalCase, n: number): Promise<RunOutcome> {
  const r = await runApp({
    members: [
      scriptedMember({
        id: 'exec', name: '執行者', canEdit: true,
        plan: { summary: c.task, assignments: [{ agent: 'A1', task: c.task }] },
        writes: c.writes || {},
        report: c.report,
      }),
      { id: 'reviewer', name: REVIEWER, cli: CLI, model: MODEL, persona: '仔細的審查者。', canEdit: false },
    ],
    adapters: ADAPTER ? [`installed:${ADAPTER}`] : [],
    files: c.files,
    git: true,
    constants: { reviewer: REVIEWER, task: c.task, paths: [...Object.keys(c.files || {}), ...Object.keys(c.writes || {})] },
    timeoutMs: 20 * 60 * 1000,
    scenario: async (H: any) => {
      const g: any = globalThis;
      await g.ready();
      const msgs = await g.send(H.task, 'divide');
      const review = msgs.find((m: any) => m.kind === 'agent' && m.agentName === H.reviewer && m.phase && m.phase.code === 'review');
      if (!review) return { found: false };
      const touched = (review.activities || []).some((a: any) => H.paths.some((p: string) => `${a.title || ''} ${a.detail || ''}`.includes(p)));
      // 產品實際的決定:有沒有進修復回合。這就是寫錯的東西會不會被放行
      const repaired = msgs.some((m: any) => m.kind === 'agent' && m.phase && m.phase.code === 'repair');
      return { found: true, text: String(review.text || ''), error: review.error || null, readFile: touched, repaired };
    },
  });
  r.cleanup();
  const v = r.value || {};
  const error = !r.ok || !v.found || !!v.error || !String(v.text || '').trim();
  const passed = !error && hasMarker(v.text, 'NO_ISSUES');
  const verdict = error ? `失敗(${r.error || v.error || '沒有審查'})` : passed ? '沒問題' : '有問題';
  console.log(`  ${c.id} #${n}:${verdict} · 讀檔:${v.readFile ? '是' : '否'} · 修復:${v.repaired ? '是' : '否'} · ${(r.elapsedMs / 1000).toFixed(0)}s`);
  // 審查內容只印在本機終端機,不進結果檔
  if (process.env.EVAL_VERBOSE && v.text) console.log(`    ${String(v.text).slice(0, 400).replace(/\n/g, ' ')}`);
  return { passed, repaired: !!v.repaired, readFile: !!v.readFile, error };
}

// 跑的是哪一版程式。工作目錄有沒提交的改動時加上 -dirty:那份分數量的不是這個 commit。
// 在開始前就記下來,跑完才寫的結果檔不會把自己算成改動
function currentCommit(): string {
  try {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    return git('rev-parse', '--short', 'HEAD') + (git('status', '--porcelain', '--', '.', ':(exclude)eval/results') ? '-dirty' : '');
  } catch { return ''; }
}

// 本機日期(toISOString 是 UTC,晚上跑會記成前一天)
function localDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function main() {
  const codeCommit = currentCommit();
  const runs = Math.max(1, Number(arg('runs') || 3));
  const only = (arg('cases') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = only.filter((id) => !CASES.some((c) => c.id === id));
  if (unknown.length) throw new Error(`沒有這些題目:${unknown.join(', ')}(可用:${CASES.map((c) => c.id).join(', ')})`);
  const cases = only.length ? CASES.filter((c) => only.includes(c.id)) : CASES;
  console.log(`審查者:${CLI}${MODEL ? ` / ${MODEL}` : ''} · ${cases.length} 題 × ${runs} 次`);

  const scores: Record<string, CaseScore> = {};
  for (const c of cases) {
    console.log(`\n[${c.id}] ${c.asks}(應該:${c.expected === 'issues' ? '抓出問題' : '放行'})`);
    const outcomes: RunOutcome[] = [];
    for (let i = 1; i <= runs; i++) outcomes.push(await runOnce(c, i));
    scores[c.id] = scoreCase(c, outcomes);
  }

  const version = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
  const result = buildResult({ date: localDate(), version, commit: codeCommit, cli: CLI, model: MODEL, runsPerCase: runs }, scores);

  console.log('\n========== 結果 ==========');
  for (const [id, s] of Object.entries(scores)) {
    console.log(`${id.padEnd(26)} ${s.correct}/${s.runs - s.errors} 判對${s.errors ? ` · ${s.errors} 次失敗不計` : ''} · 有讀檔 ${s.readFile} 次`);
  }
  console.log(`${'合計'.padEnd(24)} ${result.total.correct}/${result.total.scored}`);

  if (arg('save') !== null) {
    const file = path.join(__dirname, 'results', resultFileName(result));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
    console.log(`\n結果已存到 ${path.relative(REPO_ROOT, file)}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
