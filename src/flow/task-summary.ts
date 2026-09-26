// 任務結果卡:純文字版(匯出、歷史紀錄)與從紀錄還原
import { tx, joinNames } from '../text';
import type { TextLocale } from '../text';
import { formatTimeout } from '../adapters/process';
import type { TaskSummary } from '../ipc-types';

// 結果卡的純文字版:匯出成 Markdown、重開歷史紀錄時用
export const TASK_SUMMARY_FILES = 30;
const TASK_COUNTEREXAMPLE_OUTPUT = 2000;
export function restoreVerification(raw: any): TaskSummary['verification'] {
  if (!raw || !Number.isInteger(raw.checked) || raw.checked < 0 || !Array.isArray(raw.syntax) || !Array.isArray(raw.gates)) return undefined;
  return {
    ...(typeof raw.revision === 'string' && /^[a-f0-9]{64}$/.test(raw.revision) ? { revision: raw.revision } : {}),
    freshness: raw.freshness === 'stale' ? 'stale' : 'unknown',
    checked: raw.checked,
    checkedFiles: Array.isArray(raw.checkedFiles) ? raw.checkedFiles.filter((file: unknown) => typeof file === 'string') : [],
    ...(typeof raw.checkedAt === 'number' && raw.checkedAt > 0 && Number.isFinite(new Date(raw.checkedAt).getTime()) ? { checkedAt: raw.checkedAt } : {}),
    scopeKnown: raw.scopeKnown === true,
    unchecked: Array.isArray(raw.unchecked) ? raw.unchecked.filter((item: any) => item && typeof item.file === 'string' && ['unsupported', 'limit', 'unavailable'].includes(item.reason)).map((item: any) => ({ file: item.file, reason: item.reason })) : [],
    skippedCommands: Array.isArray(raw.skippedCommands) ? raw.skippedCommands.filter((command: unknown) => typeof command === 'string') : [],
    syntax: raw.syntax.filter((item: any) => item && typeof item.file === 'string' && typeof item.error === 'string')
      .map((item: any) => ({ file: item.file, error: item.error })),
    gates: raw.gates.filter((gate: any) => gate && typeof gate.command === 'string' && typeof gate.ok === 'boolean' && typeof gate.output === 'string')
      .map((gate: any) => ({ command: gate.command, ok: gate.ok, code: Number.isInteger(gate.code) ? gate.code : null, output: gate.output, timedOut: gate.timedOut === true, ...(gate.notFound === true ? { notFound: true } : {}) })),
  };
}

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
    summary.guard ? tx(locale, `sys.guardSummary.${summary.guard.stage === 'plan' ? 'plan' : summary.guard.status}`, { n: summary.guard.reviewers, rounds: summary.guard.repairRounds }) : '',
    // 修復把事情弄糟時要講成一句人話:「驗證沒過」看不出是誰在哪一步弄壞的
    summary.repairBroke ? tx(locale, 'sys.taskSummary.repairBroke') : '',
    summary.rollback ? tx(locale, summary.rollback.status === 'complete'
      ? summary.rollback.scope === 'repair' ? 'sys.taskSummary.rollbackRepair' : 'sys.taskSummary.rollbackTask'
      : summary.rollback.status === 'partial' ? 'sys.taskSummary.rollbackPartial' : 'sys.taskSummary.rollbackUnavailable') : '',
    verificationText(summary, locale),
    counterexamplesText(summary, locale),
    ...(summary.verificationHistory || []).map((verification) => `${tx(locale, 'sys.taskSummary.previousVerification')}\n${verificationText({ ...summary, verification }, locale)}`),
    summary.reviewStale ? tx(locale, 'sys.taskSummary.reviewStale') : '',
    members.join('\n'),
    files.length ? `${tx(locale, 'sys.taskSummary.files', { n: summary.files.length + summary.moreFiles })}\n${files.join('\n')}` : tx(locale, 'sys.taskSummary.noFiles'),
  ].filter(Boolean).join('\n\n');
}

function counterexamplesText(summary: TaskSummary, locale: TextLocale): string {
  if (!summary.counterexamples) return tx(locale, 'sys.taskSummary.counterexamplesMissing');
  if (!summary.counterexamples.length) return tx(locale, 'sys.taskSummary.counterexamplesNone');
  const lines = [tx(locale, 'sys.taskSummary.counterexamples')];
  for (const item of summary.counterexamples) {
    const after = item.afterRepair ? tx(locale, `sys.taskSummary.counterexample.after.${item.afterRepair}`) : tx(locale, 'sys.taskSummary.counterexample.notRetested');
    lines.push(tx(locale, 'sys.taskSummary.counterexample.item', {
      reviewer: item.reviewer,
      title: item.title || tx(locale, 'ce.untitled'),
      confirmation: tx(locale, `sys.taskSummary.counterexample.${item.confirmation}`),
      after,
    }));
    if (item.output) lines.push(item.output.split('\n').map((line) => `    ${line}`).join('\n'));
    if (item.repairOutput) lines.push(item.repairOutput.split('\n').map((line) => `    ${line}`).join('\n'));
  }
  return lines.join('\n');
}

function verificationText(summary: TaskSummary, locale: TextLocale): string {
  const verification = summary.verification;
  if (!verification) return '';
  const lines = [tx(locale, 'sys.taskSummary.evidence', { n: verification.checked })];
  lines.push(tx(locale, `sys.taskSummary.freshness.${verification.freshness || 'unknown'}`));
  if (verification.checkedAt) lines.push(tx(locale, 'sys.taskSummary.checkedAt', { time: new Date(verification.checkedAt).toISOString() }));
  lines.push(...(verification.checkedFiles || []).map((file) => `  ${file}`));
  for (const failure of verification.syntax) lines.push(`${failure.file}: ${failure.error}`);
  for (const gate of verification.gates) {
    const outcome = gate.timedOut ? 'timeout' : gate.notFound ? 'unavailable' : gate.ok ? 'passed' : 'failed';
    lines.push(`${tx(locale, `sys.taskSummary.check.${outcome}`)}: ${gate.command} (${gate.code ?? '-'})`);
    if (gate.output) lines.push(gate.output.split('\n').map((line) => `    ${line}`).join('\n'));
  }
  if (!verification.gates.length) lines.push(tx(locale, 'sys.taskSummary.noCommands'));
  if (!verification.scopeKnown) lines.push(tx(locale, 'sys.taskSummary.unknownScope'));
  for (const item of verification.unchecked || []) lines.push(`${item.file}: ${tx(locale, `sys.taskSummary.check.${item.reason}`)}`);
  for (const command of verification.skippedCommands || []) lines.push(`${tx(locale, 'sys.taskSummary.check.skipped')}: ${command}`);
  return lines.join('\n');
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
  const verification = restoreVerification(raw.verification);
  const confirmations = new Set(['confirmed', 'unsubstantiated', 'unusable']);
  const afterRepairStatuses = new Set(['passed', 'failed', 'unusable']);
  const counterexamples = Array.isArray(raw.counterexamples) ? raw.counterexamples
    .filter((item: any) => item && typeof item.title === 'string' && typeof item.reviewer === 'string' && confirmations.has(item.confirmation) && typeof item.output === 'string')
    .map((item: any) => ({
      title: item.title,
      reviewer: item.reviewer,
      confirmation: item.confirmation,
      ...(afterRepairStatuses.has(item.afterRepair) ? { afterRepair: item.afterRepair } : {}),
      output: item.output.slice(0, TASK_COUNTEREXAMPLE_OUTPUT),
      ...(typeof item.repairOutput === 'string' ? { repairOutput: item.repairOutput.slice(0, TASK_COUNTEREXAMPLE_OUTPUT) } : {}),
    })) : undefined;
  return {
    startedAt: num(raw.startedAt),
    endedAt: num(raw.endedAt),
    ...(raw.guard && ['plan', 'review'].includes(raw.guard.stage) && ['passed', 'blocked'].includes(raw.guard.status)
      ? { guard: { stage: raw.guard.stage, status: raw.guard.stage === 'plan' ? 'blocked' : raw.guard.status, reviewers: Math.max(2, num(raw.guard.reviewers)), repairRounds: Math.min(3, num(raw.guard.repairRounds)) } as NonNullable<TaskSummary['guard']> } : {}),
    members,
    files,
    moreFiles: num(raw.moreFiles),
    ...(raw.verify === 'passed' || raw.verify === 'syntax-only' || raw.verify === 'failed' || raw.verify === 'none' ? { verify: raw.verify } : {}),
    ...(verification ? { verification } : {}),
    ...(Array.isArray(raw.verificationHistory) ? { verificationHistory: raw.verificationHistory.map(restoreVerification).filter((item: TaskSummary['verification']) => !!item) } : {}),
    ...(counterexamples ? { counterexamples } : {}),
    ...(raw.reviewStale === true ? { reviewStale: true } : {}),
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
