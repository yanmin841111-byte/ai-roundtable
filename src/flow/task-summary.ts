// 任務結果卡:純文字版(匯出、歷史紀錄)與從紀錄還原
import { tx, joinNames } from '../text';
import type { TextLocale } from '../text';
import { formatTimeout } from '../adapters/process';
import type { TaskSummary } from '../ipc-types';

// 結果卡的純文字版:匯出成 Markdown、重開歷史紀錄時用
export const TASK_SUMMARY_FILES = 30;
export function taskSummaryText(summary: TaskSummary, locale: TextLocale): string {
  const members = summary.members.map((m) => tx(locale, 'sys.taskSummary.member', {
    name: m.name,
    outcome: tx(locale, `sys.taskOutcome.${m.outcome}`),
    reviewers: m.reviewers.length ? tx(locale, 'sys.taskSummary.reviewedBy', { names: joinNames(locale, m.reviewers) }) : '',
  }));
  const files = summary.files.map((f) => tx(locale, 'sys.taskSummary.file', { path: f.path, added: f.added, removed: f.removed }));
  if (summary.moreFiles > 0) files.push(tx(locale, 'git.more', { n: summary.moreFiles }));
  const u = summary.usage;
  const usage = u.turnsWithUsage
    ? tx(locale, 'sys.taskSummary.usage', { input: u.inputTokens.toLocaleString('en-US'), output: u.outputTokens.toLocaleString('en-US') }) + (u.costUsd != null ? ` · $${u.costUsd.toFixed(3)}` : '')
    : '';
  const verify = [summary.verify ? tx(locale, `sys.taskSummary.verify.${summary.verify}`) : '', summary.testsTouched ? tx(locale, 'sys.taskSummary.testsTouched') : ''].filter(Boolean).join(' · ');
  return [
    tx(locale, 'sys.taskSummary.title', { duration: formatTimeout(summary.endedAt - summary.startedAt, locale) }) + (usage ? ` · ${usage}` : '') + (verify ? ` · ${verify}` : ''),
    // 修復把事情弄糟時要講成一句人話:「驗證沒過」看不出是誰在哪一步弄壞的
    summary.repairBroke ? tx(locale, 'sys.taskSummary.repairBroke') : '',
    summary.rollback ? tx(locale, summary.rollback.status === 'complete'
      ? summary.rollback.scope === 'repair' ? 'sys.taskSummary.rollbackRepair' : 'sys.taskSummary.rollbackTask'
      : summary.rollback.status === 'partial' ? 'sys.taskSummary.rollbackPartial' : 'sys.taskSummary.rollbackUnavailable') : '',
    members.join('\n'),
    files.length ? `${tx(locale, 'sys.taskSummary.files', { n: summary.files.length + summary.moreFiles })}\n${files.join('\n')}` : tx(locale, 'sys.taskSummary.noFiles'),
  ].filter(Boolean).join('\n\n');
}


// 結果卡:形狀不對就不顯示卡片(純文字版照樣在 text 裡)
const TASK_OUTCOMES = new Set(['approved', 'repaired', 'unresolved', 'unreviewed', 'failed']);
const FILE_STATUSES = new Set(['added', 'modified', 'deleted', 'renamed']);
export function restoreTaskSummary(raw: any): TaskSummary | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.members) || !Array.isArray(raw.files) || !raw.usage || typeof raw.usage !== 'object') return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const members = raw.members
    .filter((m: any) => m && typeof m.name === 'string' && m.name && TASK_OUTCOMES.has(m.outcome))
    .map((m: any) => ({ name: m.name, ...(typeof m.color === 'string' ? { color: m.color } : {}), outcome: m.outcome, reviewers: Array.isArray(m.reviewers) ? m.reviewers.filter((r: unknown) => typeof r === 'string') : [] }));
  const files = raw.files
    .filter((f: any) => f && typeof f.path === 'string' && f.path && FILE_STATUSES.has(f.status))
    .slice(0, TASK_SUMMARY_FILES)
    .map((f: any) => ({ path: f.path, status: f.status, added: num(f.added), removed: num(f.removed) }));
  return {
    startedAt: num(raw.startedAt),
    endedAt: num(raw.endedAt),
    members,
    files,
    moreFiles: num(raw.moreFiles),
    ...(raw.verify === 'passed' || raw.verify === 'failed' || raw.verify === 'none' ? { verify: raw.verify } : {}),
    ...(raw.testsTouched === true ? { testsTouched: true } : {}),
    ...(raw.repairBroke === true ? { repairBroke: true } : {}),
    ...((raw.rollback?.scope === 'task' || raw.rollback?.scope === 'repair')
      && ['complete', 'partial', 'unavailable'].includes(raw.rollback.status)
      ? { rollback: { scope: raw.rollback.scope, status: raw.rollback.status } } : {}),
    usage: {
      inputTokens: num(raw.usage.inputTokens),
      outputTokens: num(raw.usage.outputTokens),
      costUsd: typeof raw.usage.costUsd === 'number' && raw.usage.costUsd >= 0 ? raw.usage.costUsd : null,
      turns: num(raw.usage.turns),
      turnsWithUsage: num(raw.usage.turnsWithUsage),
    },
  };
}
