// 任務結果卡
import { t, joinNames } from './i18n';
import { fmt, initials } from './util';
import { openDiff } from './diff-view';
import { revertTask } from './revert';
import type { TaskSummary } from './api';

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
  const count = (o: string) => s.members.filter((m) => m.outcome === o).length;
  if (count('failed')) return { tone: 'bad', label: t('task.state.bad', { n: count('failed') }) };
  const attention = count('unresolved') + count('unreviewed');
  if (attention) return { tone: 'warn', label: t('task.state.warn', { n: attention }) };
  if (count('repaired')) return { tone: 'info', label: t('task.state.repaired') };
  return { tone: 'ok', label: t('task.state.ok') };
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

export function renderTaskSummary(el: HTMLElement, s: TaskSummary): void {
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
  icon.textContent = '◎';
  icon.setAttribute('aria-hidden', 'true');
  const title = document.createElement('b');
  title.className = 'ts-title';
  title.textContent = t('task.title');
  const status = document.createElement('span');
  status.className = 'ts-state';
  status.textContent = state.label;
  titleRow.append(icon, title, status);
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

  // ---- 成員:每人一張小卡 ----
  body.appendChild(sectionLabel(t('task.membersLabel')));
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
  body.appendChild(members);

  // ---- 改動的檔案 ----
  const total = s.files.length + s.moreFiles;
  const filesHead = document.createElement('div');
  filesHead.className = 'ts-files-head';
  filesHead.appendChild(sectionLabel(total ? t('task.files', { n: total }) : t('task.noFiles')));
  if (total) {
    const actions = document.createElement('div');
    actions.className = 'ts-file-actions';
    // 停損:成員卡住或改壞時的退路。破壞性操作,按下去會先問一次
    const revert = document.createElement('button');
    revert.type = 'button';
    revert.className = 'ts-revert';
    revert.textContent = t('task.revert');
    revert.title = t('task.revertTitle');
    revert.onclick = () => { void revertTask(revert); };
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'ts-open';
    open.textContent = t('diff.open');
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
  // 上方一條「任務結束」分隔線,跟階段分隔線同一種語彙:這是一次任務的收尾,不是又一則發言
  const end = document.createElement('div');
  end.className = 'ts-end';
  const endLabel = document.createElement('span');
  endLabel.textContent = t('task.end');
  end.appendChild(endLabel);
  el.replaceChildren(end, card);
}
