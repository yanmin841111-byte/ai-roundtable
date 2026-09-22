// 任務結果卡
import { t, joinNames } from './i18n';
import { controlLabel, icon as makeIcon } from './icons';
import { fmt, initials } from './util';
import { openDiff } from './diff-view';
import { revertTask } from './revert';
import { renderReviewTiming } from './task-review';
import { renderTaskVerification, refreshTaskVerifications } from './task-verification';
import type { TaskSummary, TaskVerificationStatus } from './api';

// 誰做完了、審查結論、改了哪些檔案、花了多少時間與 token:原本散在整條對話裡,任務結束時整理成一張卡。
// 結論沿用審查徽章的樣式與用詞,和流程實際的走向是同一個判斷(由主程序寫進訊息)。
// 「已修復」修完之後沒有再審查一次,不能跟「審查通過」一樣是綠色:用中性色
const OUTCOME_BADGE: Record<string, string> = { approved: 'verdict pass', repaired: '', unresolved: 'warn', unreviewed: 'unreviewed', failed: 'bad' };
const TASK_FILES_SHOWN = 12;

function durationText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? t('task.seconds', { s: seconds }) : t('task.minutes', { m: Math.floor(seconds / 60), s: seconds % 60 });
}

// 整體狀態:決定標題旁的狀態標籤(需要留意或失敗時換成警示色)。最嚴重的那個說了算
function taskState(s: TaskSummary): { tone: 'ok' | 'info' | 'warn' | 'bad'; label: string } {
  if (s.verify === 'failed' || s.members.some((member) => ['failed', 'unresolved'].includes(member.outcome)) || s.rollback) {
    return { tone: 'bad', label: t('task.acceptance.blocked') };
  }
  if (s.verify !== 'passed' || s.reviewStale || s.testsTouched || !s.verification?.scopeKnown || s.verification.unchecked?.length || s.verification.skippedCommands?.length || s.members.some((member) => member.outcome !== 'approved')) {
    return { tone: 'warn', label: t('task.acceptance.incomplete') };
  }
  return { tone: 'info', label: t('task.acceptance.pending') };
}

// 像 GitHub 那樣的 5 格增刪比例條:一眼看出這個檔案改了多少
function diffStatBar(added: number, removed: number): HTMLElement {
  const bar = document.createElement('span');
  bar.className = 'ts-bar';
  bar.setAttribute('aria-hidden', 'true');
  const total = added + removed;
  const green = total ? Math.round((5 * added) / total) : 0;
  const red = total ? 5 - green : 0;
  for (let i = 0; i < 5; i++) {
    const cell = document.createElement('i');
    cell.className = i < green ? 'add' : i < green + red ? 'del' : '';
    bar.appendChild(cell);
  }
  return bar;
}

// 儀表板式的數字:小標籤在上、數字在下
function metric(label: string, value: string, title: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'ts-metric';
  el.title = title;
  const l = document.createElement('span');
  l.className = 'ts-metric-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'ts-metric-value';
  v.textContent = value;
  el.append(l, v);
  return el;
}

function sectionLabel(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'ts-label';
  el.textContent = text;
  return el;
}

function evidenceRow(label: string, detail?: string, tone = ''): HTMLElement {
  const row = document.createElement(detail ? 'details' : 'div');
  row.className = `ts-evidence-row ${tone}`;
  const heading = document.createElement(detail ? 'summary' : 'span');
  heading.textContent = label;
  row.appendChild(heading);
  if (detail) {
    const output = document.createElement('pre');
    output.textContent = detail;
    row.appendChild(output);
  }
  return row;
}

function acceptanceEvidence(summary: TaskSummary): HTMLElement {
  const section = document.createElement('section');
  section.className = 'ts-evidence';
  const pending = summary.members.filter((member) => member.outcome !== 'approved');
  if (pending.length || summary.verify === 'failed' || summary.rollback || summary.testsTouched || summary.reviewStale) section.appendChild(sectionLabel(t('task.acceptance.attention')));
  for (const member of pending) section.appendChild(evidenceRow(`${member.name}: ${t(`task.outcome.${member.outcome}`)}`, undefined, 'warn'));
  if (summary.verify === 'failed') section.appendChild(evidenceRow(t('task.verify.failed'), undefined, 'bad'));
  if (summary.rollback) section.appendChild(evidenceRow(t('task.acceptance.rolledBack'), undefined, 'warn'));
  if (summary.testsTouched) section.appendChild(evidenceRow(t('task.testsTouchedTitle'), undefined, 'warn'));
  if (summary.reviewStale) section.appendChild(evidenceRow(t('task.freshness.reviewStale'), undefined, 'warn'));
  section.appendChild(sectionLabel(t('task.evidence.title')));
  const verification = summary.verification;
  if (!verification) {
    section.appendChild(evidenceRow(t('task.evidence.missing'), undefined, 'warn'));
    return section;
  }
  if (verification.checkedAt) section.appendChild(evidenceRow(t('task.evidence.at', { time: new Date(verification.checkedAt).toLocaleString(document.documentElement.lang || 'en') })));
  section.appendChild(evidenceRow(t('task.evidence.syntax', { n: verification.checked }), verification.checkedFiles?.join('\n')));
  for (const failure of verification.syntax) section.appendChild(evidenceRow(failure.file, failure.error, 'bad'));
  for (const gate of verification.gates) {
    const result = gate.timedOut ? 'timeout' : gate.notFound ? 'unavailable' : gate.ok ? 'passed' : 'failed';
    section.appendChild(evidenceRow(`${t(`task.evidence.${result}`)}: ${gate.command}`, `${t('task.evidence.exit', { code: gate.code ?? '-' })}\n${gate.output}`, gate.ok ? '' : 'bad'));
  }
  if (!verification.gates.length) section.appendChild(evidenceRow(t('task.evidence.noCommands'), undefined, 'warn'));
  for (const command of verification.skippedCommands || []) section.appendChild(evidenceRow(`${t('task.evidence.skipped')}: ${command}`, undefined, 'warn'));
  if (!verification.scopeKnown) section.appendChild(evidenceRow(t('task.evidence.unknownScope'), undefined, 'warn'));
  if (verification.unchecked?.length) {
    section.appendChild(evidenceRow(t('task.evidence.unchecked', { n: verification.unchecked.length }), verification.unchecked.map((item) => `${item.file}: ${t(`task.evidence.${item.reason}`)}`).join('\n'), 'warn'));
  }
  return section;
}

export function renderTaskSummary(el: HTMLElement, s: TaskSummary, taskId: string): void {
  const state = taskState(s);
  const card = document.createElement('div');
  card.className = `bubble task-summary tone-${state.tone}`;

  // ---- 標題:整體狀態 + 數字 ----
  const head = document.createElement('div');
  head.className = 'ts-head';
  const titleRow = document.createElement('div');
  titleRow.className = 'ts-title-row';
  const icon = document.createElement('span');
  icon.className = 'ts-icon';
  icon.appendChild(makeIcon('result'));
  icon.setAttribute('aria-hidden', 'true');
  const title = document.createElement('b');
  title.className = 'ts-title';
  title.textContent = t('task.title');
  const status = document.createElement('span');
  status.className = 'ts-state';
  status.textContent = state.label;
  titleRow.append(icon, title, status);
  if (s.rollback) {
    const rollback = document.createElement('span');
    rollback.className = 'ts-verify tests ts-rollback';
    rollback.textContent = t(s.rollback.status === 'complete'
      ? s.rollback.scope === 'repair' ? 'task.rollbackRepair' : 'task.rollbackTask'
      : s.rollback.status === 'partial' ? 'task.rollbackPartial' : 'task.rollbackUnavailable');
    titleRow.appendChild(rollback);
  }
  // app 自己跑的驗證:沒有驗證就直說「只有人工智慧讀過」,不讓「審查通過」看起來像跑過了
  if (s.verify) {
    const v = document.createElement('span');
    v.className = `ts-verify ${s.verify}`;
    v.textContent = t(`task.verify.${s.verify}`);
    v.title = t(`task.verifyTitle.${s.verify}`);
    titleRow.appendChild(v);
  }
  if (s.testsTouched) {
    const w = document.createElement('span');
    w.className = 'ts-verify tests';
    w.textContent = t('task.testsTouched');
    w.title = t('task.testsTouchedTitle');
    titleRow.appendChild(w);
  }
  const metrics = document.createElement('div');
  metrics.className = 'ts-metrics';
  metrics.appendChild(metric(t('task.metric.duration'), durationText(s.endedAt - s.startedAt), t('task.durationTitle')));
  const u = s.usage;
  if (u.turnsWithUsage) {
    metrics.appendChild(metric(t('task.metric.tokens'), t('task.tokens', { input: fmt(u.inputTokens), output: fmt(u.outputTokens) }), t('task.tokensTitle')));
    if (u.costUsd != null) metrics.appendChild(metric(t('task.metric.cost'), `$${u.costUsd.toFixed(3)}`, t('task.costTitle')));
  }
  head.append(titleRow, metrics);
  // 內容區:成員與檔案。標題列是一條品牌色的色帶,和對話泡泡明顯不同
  const body = document.createElement('div');
  body.className = 'ts-body';
  // 有回合沒回報用量時,總數偏低:講出來,不要讓它看起來像精確的數字
  if (u.turnsWithUsage && u.turnsWithUsage < u.turns) {
    const partial = document.createElement('div');
    partial.className = 'ts-partial';
    partial.textContent = t('task.usagePartial', { n: u.turns - u.turnsWithUsage });
    head.appendChild(partial);
  }
  card.append(head, body);
  let freshness: TaskVerificationStatus['freshness'] = 'unknown';
  let humanOutcome = 'pending';
  let timing: ReturnType<typeof renderReviewTiming> | undefined;
  const updateStatus = () => {
    const current = freshness === 'current';
    const tone = state.tone === 'bad' ? 'bad' : current ? state.tone : 'warn';
    card.className = `bubble task-summary tone-${tone}`;
    status.textContent = state.tone === 'bad' ? state.label : !current ? t('task.acceptance.incomplete')
      : state.tone === 'info' && humanOutcome !== 'pending' ? t(`task.review.${humanOutcome}`) : state.label;
    const badge = titleRow.querySelector('.ts-verify:not(.tests)');
    if (badge && (s.verify === 'passed' || s.verify === 'syntax-only')) {
      badge.className = `ts-verify ${current ? s.verify : 'none'}`;
      badge.textContent = current ? t(`task.verify.${s.verify}`) : t('task.freshness.historicalPass');
    }
  };
  const verification = renderTaskVerification(taskId, s, (value) => {
    freshness = value.freshness;
    timing?.setFreshness(freshness);
    updateStatus();
  });
  timing = renderReviewTiming(taskId, s, (outcome) => { humanOutcome = outcome; updateStatus(); }, verification.refresh);
  body.append(verification.section);
  body.appendChild(acceptanceEvidence(s));
  if (s.verificationHistory?.length) {
    const history = document.createElement('details');
    history.className = 'ts-verification-history';
    const label = document.createElement('summary');
    label.textContent = t('task.freshness.previous', { n: s.verificationHistory.length });
    history.appendChild(label);
    for (const old of s.verificationHistory) history.appendChild(acceptanceEvidence({ ...s, members: [], rollback: undefined, reviewStale: false, testsTouched: false, verify: undefined, verification: old }));
    body.appendChild(history);
  }

  // ---- 成員:每人一張小卡 ----
  const members = document.createElement('div');
  members.className = 'ts-members';
  for (const m of s.members) {
    const tile = document.createElement('div');
    tile.className = `ts-member outcome-${m.outcome}`;
    tile.style.setProperty('--member', m.color || '#6c8cff');
    const top = document.createElement('div');
    top.className = 'ts-member-top';
    const avatar = document.createElement('span');
    avatar.className = 'avatar ts-avatar';
    avatar.style.background = m.color || '#6c8cff';
    avatar.textContent = initials(m.name);
    const name = document.createElement('b');
    name.className = 'ts-name';
    name.textContent = m.name;
    top.append(avatar, name);
    const badge = document.createElement('span');
    badge.className = `badge ${OUTCOME_BADGE[m.outcome] || ''}`;
    badge.textContent = t(`task.outcome.${m.outcome}`);
    badge.title = t(`task.outcomeTitle.${m.outcome}`);
    tile.append(top, badge);
    if (m.reviewers.length) {
      const by = document.createElement('span');
      by.className = 'ts-reviewers';
      by.textContent = t('task.reviewedBy', { names: joinNames(m.reviewers) });
      tile.appendChild(by);
    }
    members.appendChild(tile);
  }
  // ---- 改動的檔案 ----
  const total = s.files.length + s.moreFiles;
  const filesHead = document.createElement('div');
  filesHead.className = 'ts-files-head';
  filesHead.appendChild(sectionLabel(total ? t('task.files', { n: total }) : t('task.noFiles')));
  if (total) {
    const actions = document.createElement('div');
    actions.className = 'ts-file-actions';
    // 修復回合把事情弄糟時,不能只印一行紅字:app 知道「執行後是過的、修復後不過了」,
    // 就該把「只收回修復」放在使用者眼前。執行階段做對的部分留著,不用整個重來。
    if (s.repairBroke && s.rollback?.status !== 'complete') {
      const undoFix = document.createElement('button');
      undoFix.type = 'button';
      undoFix.className = 'ts-revert warn';
      controlLabel(undoFix, 'revert', t('task.revertFix'));
      undoFix.title = t('task.revertFixTitle');
      undoFix.onclick = () => { void revertTask(undoFix, 'repair').finally(refreshTaskVerifications); };
      actions.appendChild(undoFix);
    }
    // 停損:成員卡住或改壞時的退路。破壞性操作,按下去會先問一次
    const revert = document.createElement('button');
    revert.type = 'button';
    revert.className = 'ts-revert';
    controlLabel(revert, 'revert', t('task.revert'));
    revert.title = t('task.revertTitle');
    revert.onclick = () => { void revertTask(revert).finally(refreshTaskVerifications); };
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'ts-open';
    controlLabel(open, 'diff', t('diff.open'));
    open.onclick = () => { void openDiff(); };
    actions.append(revert, open);
    filesHead.appendChild(actions);
  }
  body.appendChild(filesHead);
  if (total) {
    const files = document.createElement('div');
    files.className = 'ts-files';
    for (const f of s.files.slice(0, TASK_FILES_SHOWN)) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ts-file';
      row.title = t('review.fileTitle');
      const status = document.createElement('span');
      status.className = `diff-status ${f.status}`;
      status.textContent = t(`diff.status.${f.status}`);
      const p = document.createElement('span');
      p.className = 'ts-path';
      p.textContent = f.path;
      const counts = document.createElement('span');
      counts.className = 'ts-counts';
      const plus = document.createElement('span');
      plus.className = 'diff-plus';
      plus.textContent = `+${Number(f.added) || 0}`;
      const minus = document.createElement('span');
      minus.className = 'diff-minus';
      minus.textContent = `−${Number(f.removed) || 0}`;
      counts.append(plus, minus);
      row.append(status, p, counts, diffStatBar(Number(f.added) || 0, Number(f.removed) || 0));
      row.onclick = () => { void openDiff(f.path); };
      files.appendChild(row);
    }
    const rest = total - Math.min(s.files.length, TASK_FILES_SHOWN);
    if (rest > 0) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'ts-file more';
      more.textContent = t('review.scope.more', { n: rest });
      more.onclick = () => { void openDiff(); };
      files.appendChild(more);
    }
    body.appendChild(files);
  }
  const memberDetails = document.createElement('details');
  memberDetails.className = 'ts-member-details';
  const memberHeading = document.createElement('summary');
  memberHeading.textContent = `${t('task.membersLabel')} (${s.members.length})`;
  memberDetails.append(memberHeading, members);
  body.append(timing.section, memberDetails);
  // 上方一條「任務結束」分隔線,跟階段分隔線同一種語彙:這是一次任務的收尾,不是又一則發言
  const end = document.createElement('div');
  end.className = 'ts-end';
  const endLabel = document.createElement('span');
  endLabel.textContent = t('task.end');
  end.appendChild(endLabel);
  el.replaceChildren(end, card);
}
