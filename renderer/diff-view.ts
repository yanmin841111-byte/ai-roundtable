// 檔案改動(紅綠 diff)視窗
import * as Marker from '../src/shared';
import { t, localeTag } from './i18n';
import { $, escapeHtml, cleanIpcError, cssEscape } from './util';
import { envFixHtml, bindEnvFix } from './env-fix';
import type { DiffFile } from './api';

// 成員可以直接改使用者的檔案,但介面原本只看得到成員「說」它改了什麼。這裡把實際的
// git 改動撈出來逐檔、逐行呈現,讓說的和做的能被對照。唯讀:不提供套用或還原。

// 展開狀態要跨重新整理保留,否則每按一次 ↻ 使用者就得重新展開在看的那個檔案
const diffExpanded = new Set<string>();
// 從審查訊息點檔名打開時,要展開並捲到的那個檔案
let diffFocus: string | null = null;
let diffRequest = 0;

export async function openDiff(focus?: string): Promise<void> {
  diffFocus = focus || null;
  $<HTMLDivElement>('#diff-modal').classList.remove('hidden');
  await loadDiff();
}

export async function loadDiff(): Promise<void> {
  const request = ++diffRequest;
  const owner = window.api.jobs.current();
  const body = $<HTMLDivElement>('#diff-body');
  const summary = $<HTMLDivElement>('#diff-summary');
  const refresh = $<HTMLButtonElement>('#diff-refresh');
  refresh.disabled = true;
  summary.textContent = '';
  body.innerHTML = `<div class="diff-empty">${escapeHtml(t('diff.loading'))}</div>`;
  try {
    const result = await window.api.getDiff();
    if (request !== diffRequest || owner !== window.api.jobs.current()) return;
    if (!result.ok) {
      // git 本身不能用,和「這個資料夾不是 repo」是兩件事:叫使用者 git init 沒有用,
      // 要修的是 git。照實說一句,再給一行可以直接在內建終端執行的修復指令。
      if (result.reason === 'git-unavailable') {
        const what = t(result.issue === 'license' ? 'diff.gitLicense' : 'diff.gitMissing');
        body.innerHTML = `<div class="diff-empty">${escapeHtml(what)}\n${escapeHtml(t('diff.gitFallback'))}`
          + `${envFixHtml(result.fix)}</div>`;
        bindEnvFix(body);
        return;
      }
      const key = result.reason === 'no-workdir' ? 'diff.noWorkdir' : result.reason === 'not-a-repo' ? 'diff.notRepo' : 'diff.failed';
      // detail 是 git 的原文(多半是英文),只在真正失敗時附上,不強行翻譯
      const detail = result.reason === 'failed' && result.detail ? `\n${result.detail}` : '';
      // 說明裡提到「在資料夾執行 git init」時,就順手給那顆按鈕——指令一樣只是填進終端,
      // 由使用者自己按 Enter(git init 會動到他的資料夾,不該由 app 代按)
      const init = result.reason === 'not-a-repo' ? envFixHtml({ command: 'git init' }) : '';
      body.innerHTML = `<div class="diff-empty">${escapeHtml(t(key) + detail)}${init}</div>`;
      bindEnvFix(body);
      return;
    }
    renderDiff(result.files, result.dir, result.totalFiles, result.prefix || '', result.source === 'task' ? result.since : undefined);
  } catch (error) {
    if (request !== diffRequest || owner !== window.api.jobs.current()) return;
    body.innerHTML = `<div class="diff-empty">${escapeHtml(t('diff.failed') + '\n' + cleanIpcError(error))}</div>`;
  } finally {
    if (request === diffRequest) {
      refresh.disabled = false;
      diffFocus = null;
    }
  }
}

function renderDiff(files: DiffFile[], dir: string, totalFiles: number, prefix = '', taskSince?: number): void {
  const body = $<HTMLDivElement>('#diff-body');
  const summary = $<HTMLDivElement>('#diff-summary');
  body.innerHTML = '';
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  // 超過上限時 files 只是前面一段,增刪統計也只涵蓋這一段。
  // 把「顯示了幾個 / 一共幾個」講明白,不要讓截斷後的數字看起來像完整結果。
  const capped = totalFiles > files.length;
  const head = capped
    ? t('diff.summaryCapped', { shown: files.length, total: totalFiles, added, removed })
    : t('diff.summary', { files: files.length, added, removed });
  // 不是 git repo 時比對的基準是「最近一次任務開始前」,不是上一次 commit:要講清楚,不然數字會被誤讀
  const since = taskSince ? `　·　${t('diff.taskSince', { time: new Date(taskSince).toLocaleString(localeTag(), { dateStyle: 'short', timeStyle: 'short' }) })}` : '';
  summary.textContent = (totalFiles ? `${head}　·　${t('diff.dirLabel', { dir })}` : t('diff.dirLabel', { dir })) + since;
  if (!files.length) {
    body.innerHTML = `<div class="diff-empty">${escapeHtml(t('diff.clean'))}</div>`;
    return;
  }
  // 審查訊息裡的路徑相對於工作目錄,這裡的路徑相對於 repo 根目錄:接上 prefix 後要完全相符
  const focus = diffFocus ? Marker.findDiffFocus(files.map((f) => f.path), prefix, diffFocus) : null;
  if (diffFocus && !focus) {
    // 快照看得到、git 看不到的檔案(被 .gitignore 忽略、超過顯示上限):打開了卻什麼都沒標,使用者會以為壞了
    const note = document.createElement('div');
    note.className = 'diff-note diff-focus-missing';
    note.textContent = t('diff.focusMissing', { file: diffFocus });
    body.appendChild(note);
  }
  if (focus) diffExpanded.add(focus);
  for (const file of files) body.appendChild(diffFileEl(file));
  if (focus) {
    const el = body.querySelector<HTMLElement>(`.diff-file[data-path="${cssEscape(focus)}"]`);
    if (el) { el.classList.add('focused'); el.scrollIntoView({ block: 'start' }); }
  }
  if (capped) {
    const note = document.createElement('div');
    note.className = 'diff-note diff-cap-note';
    note.textContent = t('diff.cappedNote', { shown: files.length, total: totalFiles });
    body.appendChild(note);
  }
}

function diffFileEl(file: DiffFile): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'diff-file';
  wrap.dataset.path = file.path;
  const open = diffExpanded.has(file.path);

  const head = document.createElement('button');
  head.className = 'diff-file-head';
  head.setAttribute('aria-expanded', String(open));
  const arrow = document.createElement('span');
  arrow.className = 'diff-arrow';
  arrow.textContent = open ? '▾' : '▸';
  const status = document.createElement('span');
  status.className = `diff-status ${file.status}`;
  status.textContent = t(`diff.status.${file.status}`);
  const name = document.createElement('span');
  name.className = 'diff-path';
  name.textContent = `\u200E${file.path}`; // 見 .diff-path:RTL 省略時,開頭的標點才不會翻到尾端
  const counts = document.createElement('span');
  counts.className = 'diff-counts';
  // 即使檔案內容被截斷,這裡的數字仍是完整統計
  counts.innerHTML = `<span class="diff-plus">+${file.added}</span> <span class="diff-minus">−${file.removed}</span>`;
  head.append(arrow, status, name, counts);
  if (file.oldPath) {
    const from = document.createElement('span');
    from.className = 'diff-renamed-from';
    from.textContent = t('diff.renamedFrom', { from: file.oldPath });
    head.appendChild(from);
  }

  const bodyEl = document.createElement('div');
  bodyEl.className = 'diff-lines';
  bodyEl.hidden = !open;
  // 行數多的檔案展開時才建 DOM,一次把幾百個檔案全部渲染會讓視窗開不起來
  if (open) fillDiffLines(bodyEl, file);

  head.onclick = () => {
    const nowOpen = bodyEl.hidden;
    bodyEl.hidden = !nowOpen;
    arrow.textContent = nowOpen ? '▾' : '▸';
    head.setAttribute('aria-expanded', String(nowOpen));
    if (nowOpen) {
      diffExpanded.add(file.path);
      if (!bodyEl.childElementCount) fillDiffLines(bodyEl, file);
    } else diffExpanded.delete(file.path);
  };

  wrap.append(head, bodyEl);
  return wrap;
}

function fillDiffLines(el: HTMLElement, file: DiffFile): void {
  if (file.binary || file.unavailable) {
    el.innerHTML = `<div class="diff-note">${escapeHtml(t(file.unavailable ? `diff.unavailable.${file.unavailable}` : 'diff.binary'))}</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const line of file.lines) {
    const row = document.createElement('div');
    row.className = `diff-line ${line.kind}`;
    const sign = document.createElement('span');
    sign.className = 'diff-sign';
    sign.textContent = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : '';
    const text = document.createElement('span');
    text.className = 'diff-text';
    // 一律用 textContent:diff 內容是任意檔案的原始碼,絕不能當 HTML 解析
    text.textContent = line.text;
    row.append(sign, text);
    frag.appendChild(row);
  }
  if (file.truncated) {
    const note = document.createElement('div');
    note.className = 'diff-note';
    note.textContent = t('diff.truncated', { lines: file.lines.length });
    frag.appendChild(note);
  }
  el.appendChild(frag);
}
