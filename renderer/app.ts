// Renderer 主程式。由 esbuild 打包成單一 IIFE(見 package.json 的 build:renderer)。
// shared / model-rules 以往靠 UMD 掛在 window 上,改成 import 後由 bundler inline 進來。
import { marked } from 'marked';
import * as Marker from '../src/shared';
import * as ModelRules from '../src/model-rules';
import type { Model } from '../src/model-rules';
import { isPhaseInfo } from '../src/ipc-types';
import { t, applyStaticText, resolveLocale, setLocale, localeTag, joinNames } from './i18n';
import type { PhaseValue } from '../src/ipc-types';
import type {
  AgentConfig, AppConfig, AttachLimits, AttachmentInput, CliType, CliHealth, DiffFile,
  ExtEntry, ExtSummary, ExtTemplate, ChatMessage, ChatState, ExtSpec, AttachmentMeta,
  AttachmentsResult, RendererApi,
  PendingAttachment, PendingQuestion, QuestionAnswer, SessionSummary, SessionDetail, UsageInfo, Activity,
} from './api';

// querySelector 在這個 app 裡查的都是 index.html 既有的節點,查不到就是程式寫錯。
// 保留原本「直接使用回傳值」的語意,型別由呼叫端以泛型指定。
const $ = <T extends HTMLElement = HTMLElement>(s: string): T => document.querySelector(s) as T;

// marked v15 的 parse() 型別是 string | Promise<string>;這裡一律同步使用。
const md = (text: string): string => marked.parse(text, { async: false }) as string;

// renderAgentMessage 用的節點集合。
interface AgentShell {
  avatar: HTMLElement;
  bubble: HTMLElement;
  head: CachedEl;
  thinking: HTMLElement;
  activities: HTMLElement;
  body: CachedEl;
  error: CachedEl;
  // 舊的訊息節點可能還沒有這個元素,所以允許 null
  unreviewed: HTMLElement | null;
  usage: CachedEl;
  statusLine: CachedEl;
}

// setHtmlIfChanged / setTextIfChanged 把上次寫入的內容記在節點上,省掉重複的 DOM 寫入。
type CachedEl = HTMLElement & { _lastHtml?: string; _lastText?: string };

// updateUsageTotal 的累計欄位。
interface Metric { total: number; turns: number; agents: Set<string> }

let config: AppConfig = null as unknown as AppConfig;
let cliTypes: Record<string, CliType> = {};
let cliStatus: Record<string, CliHealth> = {};
let extSummary: ExtSummary = { entries: [], templates: [] };
let editingExtFile: string | null = null;
let editingExtSpec: ExtSpec | null = null;
let extTemplateFilter = 'all';
let editingId: string | null = null;
const msgEls = new Map<string, HTMLElement>();
const messageData = new Map<string, ChatMessage>();
let running = false;
let exporting = false;
let historyLoaded = false;
let historySessions: SessionSummary[] = [];
let openHistoryId: string | null = null;
let activeSessionId: string | null = null; // 目前對話寫入的歷史紀錄檔
let currentQuestion: PendingQuestion | null = null;
let answeredQuestionId: string | null = null;
let questionTimer: ReturnType<typeof setInterval> | undefined;
const historyErrors = new Map<string, string>();
const mentionMenu: { open: boolean; start: number; items: AgentConfig[]; index: number } =
  { open: false, start: 0, items: [], index: 0 };

marked.setOptions({ breaks: true, gfm: true });


// ---------- 初始化 ----------
async function init() {
  [config, cliTypes, extSummary] = await Promise.all([window.api.getConfig(), window.api.cliTypes(), window.api.ext.list()]);
  applyAppearance();
  applyStaticText();
  renderSidebar();
  renderExtensions();
  const snap = await window.api.snapshot();
  activeSessionId = snap.sessionId || null;
  snap.messages.forEach((m) => renderMessage(m, { animate: false }));
  setState(snap);
  checkClis();
  setupComposerAttachments();

  window.api.onMessage((m) => renderMessage(m, { animate: true }));
  window.api.onState(setState);
  window.api.onReset(() => {
    clearTimeline();
    clearPendingAttachments();
    activeSessionId = null;
    if (historyLoaded) renderHistoryList();
  });
  // 任務結束寫入紀錄後刷新清單,剛完成或剛續接的對話會排到最上面
  window.api.onSessionSaved((info) => {
    activeSessionId = (info && info.id) || activeSessionId;
    if (historyLoaded) loadHistory(true, { quiet: true });
  });

  $<HTMLButtonElement>('#send-btn').onclick = sendMessage;
  $<HTMLTextAreaElement>('#input').addEventListener('keydown', (e) => {
    if (handleMentionKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
  });
  $<HTMLTextAreaElement>('#input').addEventListener('input', () => { updateMentionMenu(); updateComposerHint(); });
  $<HTMLTextAreaElement>('#input').addEventListener('click', updateMentionMenu);
  $<HTMLTextAreaElement>('#input').addEventListener('blur', closeMentionMenu);
  $<HTMLButtonElement>('#history-resume').onclick = resumeHistory;
  $<HTMLButtonElement>('#stop-btn').onclick = () => window.api.stop();
  $<HTMLButtonElement>('#reset-btn').onclick = () => { if (!running || confirm(t('confirm.reset'))) window.api.reset(); };
  $<HTMLButtonElement>('#export-btn').onclick = exportConversation;
  $<HTMLButtonElement>('#sessions-btn').onclick = () => window.api.openSessions();
  $<HTMLButtonElement>('#settings-btn').onclick = () => openSettings();
  $<HTMLButtonElement>('#cli-summary').onclick = () => openSettings('clis');
  $<HTMLButtonElement>('#settings-close').onclick = closeSettings;
  document.querySelectorAll<HTMLElement>('.settings-tab').forEach((tab) => { tab.onclick = () => showSettingsTab(tab.dataset.tab || ''); });
  $<HTMLButtonElement>('#workdir-chip').onclick = pickWorkDir;
  // 點背景關閉只用在沒有編輯內容的視窗,避免誤點丟掉未儲存的成員或擴充設定
  $<HTMLButtonElement>('#diff-btn').onclick = openDiff;
  $<HTMLButtonElement>('#diff-close').onclick = () => $<HTMLDivElement>('#diff-modal').classList.add('hidden');
  $<HTMLButtonElement>('#diff-refresh').onclick = () => loadDiff();
  for (const id of ['#settings', '#history-modal', '#ext-picker', '#diff-modal']) {
    $(id).addEventListener('mousedown', (e) => { if (e.target === $(id)) closeTopModal(); });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && closeTopModal()) e.preventDefault();
    if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); openSettings(); }
  });
  $<HTMLButtonElement>('#history-toggle').onclick = toggleHistory;
  $<HTMLButtonElement>('#history-refresh').onclick = () => loadHistory(true);
  $<HTMLButtonElement>('#history-modal-close').onclick = closeHistoryModal;
  $<HTMLButtonElement>('#add-agent').onclick = () => openModal(null);
  $<HTMLButtonElement>('#modal-close').onclick = closeModal;
  $<HTMLButtonElement>('#modal-save').onclick = saveModal;
  $<HTMLButtonElement>('#modal-delete').onclick = deleteAgent;
  $<HTMLSelectElement>('#f-cli').onchange = () => fillCliDependentFields($<HTMLSelectElement>('#f-cli').value);
  $<HTMLSelectElement>('#f-model-select').onchange = onModelSelect;
  $<HTMLInputElement>('#f-model').addEventListener('input', () => refreshModelDependents());
  $<HTMLButtonElement>('#pick-dir').onclick = pickWorkDir;
  $<HTMLButtonElement>('#open-dir').onclick = () => window.api.openPath($<HTMLInputElement>('#work-dir').value);
  for (const id of ['#work-dir', '#max-rounds', '#language', '#lead-agent', '#default-mode', '#max-transcript']) $(id).addEventListener('change', saveSettings);
  document.querySelectorAll<HTMLInputElement>('input[name="theme"], input[name="font-size"], input[name="ui-locale"]').forEach((el) => el.addEventListener('change', saveAppearance));
  $<HTMLButtonElement>('#quick-detect').onclick = detectOllama;
  $<HTMLButtonElement>('#quick-apply').onclick = applyOllamaModel;
  $<HTMLButtonElement>('#ext-add').onclick = openTemplatePicker;
  $<HTMLButtonElement>('#ext-open-dir').onclick = () => window.api.ext.openDir();
  $<HTMLButtonElement>('#ext-reload').onclick = () => reloadExtensions();
  $<HTMLButtonElement>('#ext-docs').onclick = () => window.api.ext.openDocs();
  $<HTMLButtonElement>('#ext-editor-docs').onclick = () => window.api.ext.openDocs();
  $<HTMLButtonElement>('#ext-picker-close').onclick = () => $<HTMLDivElement>('#ext-picker').classList.add('hidden');
  const extFilterButtons = [...document.querySelectorAll<HTMLButtonElement>('.template-filters [data-filter]')];
  extFilterButtons.forEach((button, index) => {
    button.onclick = () => {
      extTemplateFilter = button.dataset.filter || 'all';
      extFilterButtons.forEach((item) => {
        const active = item === button;
        item.classList.toggle('active', active);
        item.setAttribute('aria-checked', String(active));
        item.tabIndex = active ? 0 : -1;
      });
      renderExtTemplates();
    };
    button.onkeydown = (event: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? extFilterButtons.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + extFilterButtons.length) % extFilterButtons.length;
      extFilterButtons[nextIndex].focus();
      extFilterButtons[nextIndex].click();
    };
  });
  $<HTMLInputElement>('#ext-search').addEventListener('input', renderExtTemplates);
  $<HTMLButtonElement>('#ext-editor-close').onclick = () => $<HTMLDivElement>('#ext-editor').classList.add('hidden');
  $<HTMLButtonElement>('#ext-save').onclick = () => { void saveExtension(); };
  $<HTMLButtonElement>('#ext-delete').onclick = deleteExtension;
  $<HTMLButtonElement>('#ext-tab-basic').onclick = () => showExtEditorTab('basic');
  $<HTMLButtonElement>('#ext-tab-advanced').onclick = () => showExtEditorTab('advanced');
  $<HTMLButtonElement>('#ext-pick-bin').onclick = pickExtensionExecutable;
  $<HTMLButtonElement>('#ext-key-clear').onclick = clearExtensionSecret;
  $<HTMLButtonElement>('#ext-key-test').onclick = testExtensionConnection;
  for (const id of ['#ext-id', '#ext-label', '#ext-type', '#ext-bin', '#ext-args', '#ext-base-url', '#ext-api-env', '#ext-models']) {
    $(id).addEventListener('input', syncExtBasicToJson);
  }
  $<HTMLSelectElement>('#ext-type').addEventListener('change', updateExtTypeFields);
  $<HTMLTextAreaElement>('#ext-content').addEventListener('blur', () => {
    if (!editingExtFile || editingExtFile.endsWith('.js')) return;
    try { fillExtBasic(JSON.parse($<HTMLTextAreaElement>('#ext-content').value)); } catch {}
  });
  $<HTMLTextAreaElement>('#ext-content').addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveExtension(); }
  });
  $<HTMLSelectElement>('#mode').value = config.settings.mode || 'divide';
  $<HTMLSelectElement>('#mode').onchange = () => { config.settings.mode = $<HTMLSelectElement>('#mode').value; $<HTMLSelectElement>('#default-mode').value = config.settings.mode; window.api.saveConfig(config); };
}

// ---------- 設定視窗 ----------

function openSettings(tab = 'general'): void {
  renderSidebar();
  showSettingsTab(tab);
  $('#settings-saved').hidden = true;
  $<HTMLDivElement>('#settings').classList.remove('hidden');
  // 使用者正要依燈號判斷「哪一位能用」,這時才值得花一次網路往返真的驗證 key。
  // 不 await:畫面先開,狀態回來再重畫。
  void checkClis({ probeCredentialed: true });
}

function closeSettings() { $<HTMLDivElement>('#settings').classList.add('hidden'); }

function showSettingsTab(tab: string): void {
  document.querySelectorAll<HTMLElement>('.settings-tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll<HTMLElement>('.settings-page').forEach((el) => { el.hidden = el.dataset.page !== tab; });
  $('#settings-title').textContent = ['general', 'clis', 'appearance', 'data'].includes(tab) ? t(`settings.tab.${tab}`) : t('settings.title');
}

let savedHintTimer: ReturnType<typeof setTimeout> | undefined;
function flashSaved() {
  const el = $('#settings-saved');
  el.hidden = false;
  clearTimeout(savedHintTimer);
  savedHintTimer = setTimeout(() => { el.hidden = true; }, 1600);
}

// Esc 或點背景時關掉最上層的視窗;回傳是否有關掉
function closeTopModal() {
  const open = [...document.querySelectorAll<HTMLElement>('.modal:not(.hidden)')];
  const top = open[open.length - 1];
  if (!top || top.id === 'ext-editor') return false; // 擴充編輯器有未儲存的程式碼,不用 Esc 關
  if (top.id === 'history-modal') closeHistoryModal();
  else top.classList.add('hidden');
  return true;
}

async function pickWorkDir() {
  const d = await window.api.pickDir();
  if (!d) return;
  $<HTMLInputElement>('#work-dir').value = d;
  saveSettings();
}

// ---------- 外觀 ----------
function applyAppearance() {
  const s = config.settings;
  const theme = ['light', 'dark', 'system'].includes(s.theme || '') ? s.theme! : 'light';
  const fontSize = [13, 14, 15].includes(Number(s.fontSize)) ? Number(s.fontSize) : 14;
  const localeSetting = ['system', 'zh-Hant', 'en'].includes(s.uiLocale || '') ? s.uiLocale! : 'system';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty('--font-size', `${fontSize}px`);
  setLocale(resolveLocale(localeSetting === 'system' ? null : localeSetting));
  const localeInput = document.querySelector<HTMLInputElement>(`input[name="ui-locale"][value="${localeSetting}"]`);
  if (localeInput) localeInput.checked = true;
  const themeInput = document.querySelector<HTMLInputElement>(`input[name="theme"][value="${theme}"]`);
  if (themeInput) themeInput.checked = true;
  const sizeInput = document.querySelector<HTMLInputElement>(`input[name="font-size"][value="${fontSize}"]`);
  if (sizeInput) sizeInput.checked = true;
}

function saveAppearance() {
  const theme = document.querySelector<HTMLInputElement>('input[name="theme"]:checked');
  const size = document.querySelector<HTMLInputElement>('input[name="font-size"]:checked');
  const locale = document.querySelector<HTMLInputElement>('input[name="ui-locale"]:checked');
  if (theme) config.settings.theme = theme.value;
  if (size) config.settings.fontSize = Number(size.value);
  if (locale) config.settings.uiLocale = locale.value as AppConfig['settings']['uiLocale'];
  applyAppearance();
  window.api.saveConfig(config);
  flashSaved();
  if (locale) relocalize();
}

// 切換介面語言:靜態文案重填、側欄與時間軸重畫;訊息資料都還在 messageData,直接重新 render
function relocalize(): void {
  applyStaticText();
  renderSidebar();
  renderExtensions();
  renderCliSummary();
  updateComposerHint();
  renderAttachChips();
  const composerHint = document.querySelector<HTMLElement>('.composer-drop-hint');
  if (composerHint) composerHint.textContent = t('composer.dropHint');
  const attachButton = $<HTMLButtonElement>('#attach-btn');
  if (attachButton) { attachButton.title = t('composer.attach'); attachButton.setAttribute('aria-label', t('composer.attach')); }
  const messages = [...messageData.values()];
  const question = currentQuestion;
  const wasAnswered = question && answeredQuestionId === question.id;
  clearTimeline();
  messages.forEach((m) => renderMessage(m, { animate: false }));
  setState({ running, question });
  if (wasAnswered) {
    answeredQuestionId = question!.id;
    disableQuestionCard('answered');
  }
  if (historyLoaded) renderHistoryList();
  if (openHistoryId) updateResumeButton();
  showSettingsTab(document.querySelector<HTMLElement>('.settings-tab.active')?.dataset.tab || 'general');
}

function clearTimeline() {
  clearInterval(questionTimer);
  questionTimer = undefined;
  currentQuestion = null;
  answeredQuestionId = null;
  msgEls.clear();
  messageData.clear();
  $<HTMLDivElement>('#timeline').innerHTML = '';
  $<HTMLDivElement>('#timeline').appendChild(emptyEl());
  updateUsageTotal();
  updateSpeakingHighlight();
}

function emptyEl() {
  const d = document.createElement('div');
  d.id = 'empty'; d.className = 'empty';
  d.innerHTML = `<div class="empty-icon">◎</div><div class="empty-title">${escapeHtml(t('empty.title'))}</div><div class="empty-sub">${escapeHtml(t('empty.sub'))}</div><div class="empty-steps"><span>${escapeHtml(t('stage.discuss'))}</span><span class="arrow">→</span><span>${escapeHtml(t('stage.execute'))}</span><span class="arrow">→</span><span>${escapeHtml(t('stage.review'))}</span></div>`;
  return d;
}

// ---------- 檔案改動(紅綠 diff) ----------
// 成員可以直接改使用者的檔案,但介面原本只看得到成員「說」它改了什麼。這裡把實際的
// git 改動撈出來逐檔、逐行呈現,讓說的和做的能被對照。唯讀:不提供套用或還原。

// 展開狀態要跨重新整理保留,否則每按一次 ↻ 使用者就得重新展開在看的那個檔案
const diffExpanded = new Set<string>();

async function openDiff(): Promise<void> {
  $<HTMLDivElement>('#diff-modal').classList.remove('hidden');
  await loadDiff();
}

async function loadDiff(): Promise<void> {
  const body = $<HTMLDivElement>('#diff-body');
  const summary = $<HTMLDivElement>('#diff-summary');
  const refresh = $<HTMLButtonElement>('#diff-refresh');
  refresh.disabled = true;
  summary.textContent = '';
  body.innerHTML = `<div class="diff-empty">${escapeHtml(t('diff.loading'))}</div>`;
  try {
    const result = await window.api.getDiff();
    if (!result.ok) {
      const key = result.reason === 'no-workdir' ? 'diff.noWorkdir' : result.reason === 'not-a-repo' ? 'diff.notRepo' : 'diff.failed';
      // detail 是 git 的原文(多半是英文),只在真正失敗時附上,不強行翻譯
      const detail = result.reason === 'failed' && result.detail ? `\n${result.detail}` : '';
      body.innerHTML = `<div class="diff-empty">${escapeHtml(t(key) + detail)}</div>`;
      return;
    }
    renderDiff(result.files, result.dir, result.totalFiles);
  } catch (error) {
    body.innerHTML = `<div class="diff-empty">${escapeHtml(t('diff.failed') + '\n' + cleanIpcError(error))}</div>`;
  } finally {
    refresh.disabled = false;
  }
}

function renderDiff(files: DiffFile[], dir: string, totalFiles: number): void {
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
  summary.textContent = totalFiles ? `${head}　·　${t('diff.dirLabel', { dir })}` : t('diff.dirLabel', { dir });
  if (!files.length) {
    body.innerHTML = `<div class="diff-empty">${escapeHtml(t('diff.clean'))}</div>`;
    return;
  }
  for (const file of files) body.appendChild(diffFileEl(file));
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
  name.textContent = file.path;
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
  if (file.binary) {
    el.innerHTML = `<div class="diff-note">${escapeHtml(t('diff.binary'))}</div>`;
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

// ---------- 歷史對話 ----------
async function toggleHistory() {
  const panel = $<HTMLDivElement>('#history-panel');
  const opening = panel.hidden;
  panel.hidden = !opening;
  $<HTMLButtonElement>('#history-toggle').setAttribute('aria-expanded', String(opening));
  $('#history-toggle .history-arrow').textContent = opening ? '▾' : '▸';
  $<HTMLButtonElement>('#history-refresh').hidden = !opening;
  if (opening && !historyLoaded) await loadHistory();
}

function setHistoryError(message: string): void {
  const el = $<HTMLDivElement>('#history-error');
  el.hidden = !message;
  el.textContent = message || '';
}

async function loadHistory(force = false, { quiet = false }: { quiet?: boolean } = {}): Promise<void> {
  if (historyLoaded && !force) return;
  const refresh = $<HTMLButtonElement>('#history-refresh');
  refresh.disabled = true;
  setHistoryError('');
  if (!quiet) $<HTMLDivElement>('#history-list').innerHTML = `<div class="history-empty">${escapeHtml(t('history.loading'))}</div>`;
  try {
    const result = await window.api.sessions.list();
    historySessions = Array.isArray(result && result.sessions) ? result.sessions! : [];
    historyLoaded = true;
    historyErrors.clear();
    if (result && result.error) setHistoryError(result.error);
    renderHistoryList();
  } catch (error) {
    setHistoryError(t('history.loadFailed', { reason: cleanIpcError(error) }));
    $<HTMLDivElement>('#history-list').innerHTML = '';
  } finally {
    refresh.disabled = false;
  }
}

function renderHistoryList() {
  const list = $<HTMLDivElement>('#history-list');
  list.innerHTML = '';
  if (!historySessions.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = t('history.empty');
    list.appendChild(empty);
    return;
  }
  for (const session of historySessions) {
    const item = document.createElement('div');
    const active = session.id === activeSessionId;
    item.className = `history-item${active ? ' active' : ''}`;
    item.dataset.sessionId = session.id;
    const main = document.createElement('button');
    main.className = 'history-open';
    const title = document.createElement('span');
    title.className = 'history-title';
    // 讀不到的紀錄沒有標題;要說「無法讀取」而不是「未命名」,兩者意思完全不同
    title.textContent = session.title || (session.error ? t('history.unreadable') : t('history.untitled'));
    if (active) main.setAttribute('aria-current', 'true');
    const meta = document.createElement('span');
    meta.className = 'history-meta';
    const details = [formatHistoryTime(session.createdAt), t('history.count', { n: Number(session.messageCount) || 0 })];
    if (Array.isArray(session.agents) && session.agents.length) details.push(joinNames(session.agents));
    meta.textContent = details.filter(Boolean).join(' · ');
    main.append(title, meta);
    main.onclick = () => openHistory(session);
    const remove = document.createElement('button');
    remove.className = 'history-delete';
    remove.title = t('history.delete');
    remove.textContent = '✕';
    remove.onclick = () => removeHistory(session);
    item.append(main, remove);
    const error = historyErrors.get(session.id) || session.error;
    if (error) {
      const err = document.createElement('div');
      err.className = 'history-item-error';
      err.textContent = error;
      item.appendChild(err);
    }
    list.appendChild(item);
  }
}

async function openHistory(summary: SessionSummary): Promise<void> {
  historyErrors.delete(summary.id);
  try {
    const result = await window.api.sessions.read(summary.id);
    if (!result || !result.ok) throw new Error((result && result.error) || t('history.readFailed'));
    if (!result.session) throw new Error(t('history.readFailed'));
    const session = result.session;
    openHistoryId = summary.id;
    $('#history-modal-title').textContent = session.title || summary.title || t('history.untitled');
    const meta = [formatHistoryTime(session.createdAt), ...(session.agents || []), t('history.messages', { n: (session.messages || []).length })];
    $<HTMLDivElement>('#history-modal-meta').textContent = meta.filter(Boolean).join(' · ');
    renderHistoryPreview(session.messages || []);
    updateResumeButton();
    $<HTMLDivElement>('#history-modal').classList.remove('hidden');
  } catch (error) {
    historyErrors.set(summary.id, cleanIpcError(error));
    renderHistoryList();
  }
}

function renderHistoryPreview(messages: unknown): void {
  const preview = $<HTMLDivElement>('#history-preview');
  preview.innerHTML = '';
  const list = Array.isArray(messages) ? messages : [];
  for (const rawMessage of list) {
    const message = rawMessage && typeof rawMessage === 'object'
      ? rawMessage
      : { kind: 'system', text: rawMessage == null ? '' : String(rawMessage) };
    const card = document.createElement('article');
    card.className = `history-message ${message.kind || 'system'} ${message.level || ''}`;
    const head = document.createElement('div');
    head.className = 'history-message-head';
    const who = message.kind === 'user' ? t('who.user') : message.kind === 'agent' ? (message.agentName || t('who.agent')) : t('who.system');
    head.textContent = [who, phaseText(message.phase), message.model, formatHistoryTime(message.ts)].filter(Boolean).join(' · ');
    const body = document.createElement('div');
    body.className = 'body';
    body.innerHTML = md(String(message.text || ''));
    card.append(head, body);
    if (Array.isArray(message.attachments) && message.attachments.length) {
      const wrap = document.createElement('div');
      wrap.innerHTML = attachmentsMarkup(message.attachments);
      if (wrap.firstChild) card.appendChild(wrap.firstChild);
      hydrateAttachmentThumbs(card, message.attachments);
    }
    if (message.error) {
      const error = document.createElement('div');
      error.className = 'error-text';
      error.textContent = `⚠ ${message.error}`;
      card.appendChild(error);
    }
    const usage = usageText(message.usage);
    if (usage) {
      const el = document.createElement('div');
      el.className = 'usage';
      el.textContent = usage;
      card.appendChild(el);
    }
    preview.appendChild(card);
  }
  if (!list.length) preview.innerHTML = `<div class="history-empty">${escapeHtml(t('history.noMessages'))}</div>`;
}

async function removeHistory(session: SessionSummary): Promise<void> {
  const when = formatHistoryTime(session.createdAt);
  if (!confirm(t('history.confirmDelete', { title: session.title || t('history.untitled'), when: when ? `\n${when}` : '' }))) return;
  historyErrors.delete(session.id);
  try {
    const result = await window.api.sessions.remove(session.id);
    if (!result || !result.ok) throw new Error((result && result.error) || t('history.deleteFailed'));
    historySessions = historySessions.filter((item) => item.id !== session.id);
    if (openHistoryId === session.id) closeHistoryModal();
    renderHistoryList();
  } catch (error) {
    historyErrors.set(session.id, cleanIpcError(error));
    renderHistoryList();
  }
}

function updateResumeButton() {
  const button = $<HTMLButtonElement>('#history-resume');
  const hint = $('#history-resume-hint');
  const current = !!openHistoryId && openHistoryId === activeSessionId;
  button.disabled = running || current;
  button.textContent = current ? t('history.current') : t('history.resume');
  hint.textContent = running ? t('history.hintRunning') : current ? t('history.hintCurrent') : t('history.hintResume');
}

async function resumeHistory() {
  const id = openHistoryId;
  if (!id || running) return;
  const button = $<HTMLButtonElement>('#history-resume');
  button.disabled = true;
  try {
    const result = await window.api.resume(id);
    if (!result || !result.ok) throw new Error((result && result.error) || t('history.resumeFailed'));
    clearTimeline();
    await clearPendingAttachments();
    activeSessionId = result.id;
    const messages = (result.snapshot && result.snapshot.messages) || [];
    messages.forEach((m) => renderMessage(m, { animate: false }));
    setState(result.snapshot || { running: false });
    closeHistoryModal();
    renderHistoryList();
    $<HTMLDivElement>('#timeline').scrollTop = $<HTMLDivElement>('#timeline').scrollHeight;
    $<HTMLTextAreaElement>('#input').focus();
  } catch (error) {
    $('#history-resume-hint').textContent = t('history.loadError', { reason: cleanIpcError(error) });
    button.disabled = false;
  }
}

function closeHistoryModal() {
  openHistoryId = null;
  $<HTMLDivElement>('#history-modal').classList.add('hidden');
  $<HTMLDivElement>('#history-preview').innerHTML = '';
}

function formatHistoryTime(value: string | number | undefined): string {
  const date = new Date(value ?? NaN);
  // 側欄一行放不下秒數與時區;匯出檔仍保留完整時間
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(localeTag(), {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// probeCredentialed:打開設定時帶 true,真的連線驗證有 key 的雲端 API。
// 啟動時不帶,避免每開一次 app 就打一輪付費端點。
async function checkClis(opts: { probeCredentialed?: boolean } = {}) {
  cliStatus = await window.api.checkCli(opts);
  // 側邊欄也要重畫:成員卡上的健康徽章讀的就是 cliStatus,不重畫的話它永遠停在
  // 「還沒檢查」那一刻的樣子——也就是什麼警告都不顯示。
  renderSidebar();
  renderExtensions();
  renderCliSummary();
}

// 側欄底部:需要安裝檢查的 CLI 有幾個可用
function renderCliSummary() {
  const el = $<HTMLButtonElement>('#cli-summary');
  const checked = Object.values(cliTypes).filter((t) => cliStatus[t.id]);
  const broken = extSummary.entries.filter((e) => e.error).length;
  if (!checked.length) {
    el.innerHTML = `<span class="status-dot"></span><span>${escapeHtml(t('cli.checking'))}</span>`;
    return;
  }
  const ready = checked.filter((type) => cliStatus[type.id].state === 'ready');
  // 設定本身沒問題、只差登入或啟動服務的狀態:不算「沒有可用的成員」,也不該畫成空心圓
  const fixable = (state?: string) => state === 'unauthenticated' || state === 'unreachable';
  const anyFixable = checked.some((type) => fixable(cliStatus[type.id].state));
  const level = broken || (!ready.length && !anyFixable) ? 'bad' : ready.length < checked.length ? 'warn' : 'ok';
  const text = `${t('cli.summary', { ok: ready.length, total: checked.length })}${broken ? ` · ${t('cli.broken', { n: broken })}` : ''}`;
  el.innerHTML = `<span class="status-dot ${level}"></span><span>${escapeHtml(text)}</span>`;
  renderEmptySetup(ready.length);
  el.title = checked.map((type) => {
    const status = cliStatus[type.id];
    const label = status.state === 'ready' ? t('cli.ready')
      : status.state === 'unauthenticated' ? t('cli.unauthenticated')
      : status.state === 'unreachable' ? t('cli.unreachable')
      : t('cli.missing');
    return `${status.state === 'ready' ? '●' : fixable(status.state) ? '◐' : '○'} ${type.label}: ${status.version || status.error || label}`;
  }).join('\n');
}

// 空狀態原本只描述「圓桌會怎麼運作」,沒有告訴使用者現在該做什麼。
// 一個成員都還不能用的時候,那段說明其實是誤導——照著送出任務只會失敗。
function renderEmptySetup(readyCount: number): void {
  const box = document.getElementById('empty-setup');
  const label = document.getElementById('empty-setup-text');
  const btn = document.getElementById('empty-setup-btn') as HTMLButtonElement | null;
  if (!box || !label || !btn) return;
  const usable = config.agents.filter((a) => a.enabled !== false && cliTypes[a.cli]
    && (!cliStatus[a.cli] || cliStatus[a.cli].state === 'ready'));
  const show = !usable.length;
  box.hidden = !show;
  if (!show) return;
  label.textContent = readyCount ? t('empty.setupSomeReady') : t('empty.setupNone');
  btn.onclick = () => openSettings('clis');
}

// ---------- CLI 與擴充 ----------
// 內建的「自訂指令」轉接器 label 由主程序給中文,介面上依語言顯示;其他轉接器的 label 原樣用
const cliLabel = (type: Partial<CliType> | undefined, fallback: string): string => (type?.id === 'custom' && type.origin === 'builtin' ? t('adapter.custom') : type?.label || fallback);
const typeLabel = (type: string): string => (['builtin', 'cli', 'openai', 'js'].includes(type) ? t(`type.${type}`) : type);

async function refreshCatalog() {
  [cliTypes, extSummary] = await Promise.all([window.api.cliTypes(), window.api.ext.list()]);
  renderSidebar();
  renderExtensions();
  renderCliSummary();
  checkClis();
}

async function reloadExtensions() {
  await window.api.ext.reload();
  await refreshCatalog();
}

// ---------- 一鍵連接本機模型(Ollama) ----------
// 使用者反映「cli 與 api 與各種東西的連結太複雜,不是技術背景的使用者根本看不懂」。
// 這個流程刻意只留一個決定:選一個模型。端點、API key、JSON、逾時、歷史上限全部
// 留在 adapter 層,介面連顯示它們的機會都沒有。

function setQuickStatus(message: string, kind: 'ok' | 'warn' | 'error' | '' = ''): void {
  const el = $<HTMLDivElement>('#quick-status');
  el.hidden = !message;
  el.textContent = message;
  el.className = `quick-status${kind ? ' ' + kind : ''}`;
}

async function detectOllama(): Promise<void> {
  const btn = $<HTMLButtonElement>('#quick-detect');
  btn.disabled = true;
  $<HTMLDivElement>('#quick-pick').hidden = true;
  setQuickStatus(t('quick.detecting'));
  try {
    const r = await window.api.quickSetupOllama();
    if (!r.ok) {
      // hint 是可以照做的下一步(例如「請先執行 ollama serve」);
      // error 是 fetch 的原始訊息,多半是英文且對一般使用者沒有意義,不顯示。
      setQuickStatus(r.hint || t('quick.notFound'), 'warn');
      return;
    }
    if (!r.models.length) {
      setQuickStatus(t('quick.noModels'), 'warn');
      return;
    }
    const select = $<HTMLSelectElement>('#quick-model');
    select.innerHTML = '';
    for (const m of r.models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.id;
      select.appendChild(opt);
    }
    // 預設選中後端建議的模型,使用者不必自己判斷哪個好
    if (r.recommendedModel) select.value = r.recommendedModel;
    $<HTMLDivElement>('#quick-pick').hidden = false;
    setQuickStatus(t('quick.found', { count: r.models.length }), 'ok');
  } catch (error) {
    // 主程序已經把 registry 的例外轉成 { ok:false }，所以走到這裡代表 IPC 本身出事。
    // 即使如此也先給一句能照做的話，原始訊息只當補充,不要讓使用者只看到一行英文。
    setQuickStatus(`${t('quick.notFound')}\n${cleanIpcError(error)}`, 'warn');
  } finally {
    btn.disabled = false;
  }
}

async function applyOllamaModel(): Promise<void> {
  const btn = $<HTMLButtonElement>('#quick-apply');
  const model = $<HTMLSelectElement>('#quick-model').value;
  if (!model) return;
  btn.disabled = true;
  setQuickStatus(t('quick.applying'));
  try {
    const r = await window.api.quickSetupOllama(model);
    if (!r.installed) {
      setQuickStatus(r.hint || r.error || t('quick.failed'), 'error');
      return;
    }
    setQuickStatus(t('quick.done', { model: r.selectedModel || model }), 'ok');
    $<HTMLDivElement>('#quick-pick').hidden = true;
    // 設定已經寫進 adapter,重載後成員設定的清單才看得到它
    await reloadExtensions();
  } catch (error) {
    setQuickStatus(`${t('quick.failed')}\n${cleanIpcError(error)}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

function renderExtensions() {
  const list = $<HTMLDivElement>('#ext-list');
  if (!list) return;
  const rows = [];
  // 已載入的轉接器(內建 + 擴充)
  for (const type of Object.values(cliTypes)) {
    const st = cliStatus[type.id];
    // unauthenticated 與 unreachable 都是「設定在,只差一步」——畫成 warn,和左下角摘要
    // 的 fixable 判定一致(以前 unreachable 在這裡畫紅、在摘要算可修復,同一狀態兩種說法)。
    const dotClass = !st ? '' : st.state === 'ready' ? 'ok' : st.state === 'unauthenticated' || st.state === 'unreachable' ? 'warn' : 'bad';
    const dot = `<span class="status-dot ${dotClass}"></span>`;
    // hint 是唯一「照做就能修好」的一句話(例如「請先執行 ollama serve」)。
    // 以前只有 unauthenticated 讀 hint,unreachable 落到 st.error,使用者看到的是
    // fetch 原文那種開發者訊息。錯誤原文改放 title,需要時才看得到。
    const sub = st
      ? st.state === 'ready' ? st.version || t('cli.ready')
        : st.state === 'unauthenticated' ? st.hint || t('cli.unauthenticated')
        : st.state === 'unreachable' ? st.hint || t('cli.unreachable')
        : st.error || t('cli.missing')
      : type.bin ? t('ext.checking') : t('ext.noCheck');
    const subTitle = st && st.error && st.hint && st.error !== st.hint ? ` title="${escapeHtml(st.error)}"` : '';
    // 目前只有 Codex 宣告 authCheck；待狀態契約提供獨立 command 欄位後可移除此窄幅對應。
    const loginCommand = st?.state === 'unauthenticated' && type.id === 'codex' ? 'codex login' : '';
    const auth = loginCommand ? `<div class="cli-auth"><code class="cli-auth-command">${escapeHtml(loginCommand)}</code><button type="button" class="cli-copy" data-copy-login="${escapeHtml(loginCommand)}">${escapeHtml(t('cli.copyLogin'))}</button></div>` : '';
    const badges = [`<span class="badge">${escapeHtml(typeLabel(type.type))}</span>`];
    if (!type.supportsEdit) badges.push(`<span class="badge">${escapeHtml(t('ext.discussOnly'))}</span>`);
    const entry = extSummary.entries.find((e) => e.file === type.file);
    if (entry && entry.overrides) badges.push(`<span class="badge warn">${escapeHtml(t('ext.overrides'))}</span>`);
    if (type.modelError) badges.push(`<span class="badge warn">${escapeHtml(t('ext.modelListFailed'))}</span>`);
    rows.push({ file: type.file, html: `${dot}<div class="ext-main"><div class="ext-title"><b>${escapeHtml(cliLabel(type, type.id))}</b>${badges.join('')}</div><div class="ext-sub"${subTitle || ` title="${escapeHtml(sub || '')}"`}>${escapeHtml(sub || '')}</div>${auth}${type.modelError ? `<div class="ext-err">${escapeHtml(type.modelError)}</div>` : ''}</div>` });
  }
  // 載入失敗的擴充
  for (const e of extSummary.entries.filter((x) => x.error)) {
    rows.push({ file: e.file, broken: true, html: `<span class="status-dot bad"></span><div class="ext-main"><div class="ext-title"><b>${escapeHtml(e.file)}</b><span class="badge bad">${escapeHtml(t('ext.loadFailed'))}</span></div><div class="ext-err">${escapeHtml(e.error)}</div></div>` });
  }
  list.innerHTML = '';
  for (const r of rows) {
    const el = document.createElement('div');
    el.className = `ext-item${r.file ? ' clickable' : ''}${r.broken ? ' broken' : ''}`;
    el.innerHTML = r.html;
    if (r.file) { const file = r.file; el.title = t('ext.clickToEdit', { file }); el.onclick = () => { void openExtEditor(file); }; }
    const copy = el.querySelector<HTMLButtonElement>('[data-copy-login]');
    if (copy) copy.onclick = (event) => {
      event.stopPropagation();
      void navigator.clipboard.writeText(copy.dataset.copyLogin || '').then(() => {
        copy.textContent = t('cli.copied');
        setTimeout(() => { if (copy.isConnected) copy.textContent = t('cli.copyLogin'); }, 1400);
      });
    };
    list.appendChild(el);
  }
}

function openTemplatePicker() {
  $<HTMLInputElement>('#ext-search').value = '';
  renderExtTemplates();
  $<HTMLDivElement>('#ext-picker').classList.remove('hidden');
}

function renderExtTemplates() {
  const box = $<HTMLDivElement>('#ext-templates');
  box.innerHTML = '';
  const query = $<HTMLInputElement>('#ext-search').value.trim().toLocaleLowerCase();
  const templates = extSummary.templates.filter((template) => {
    const kind = template.type === 'cli' ? 'cli' : template.type === 'openai' ? 'api' : 'other';
    const matchesFilter = extTemplateFilter === 'all' || kind === extTemplateFilter;
    const haystack = `${template.label || ''} ${template.description || ''}`.toLocaleLowerCase();
    return matchesFilter && (!query || haystack.includes(query));
  });

  if (!templates.length) {
    box.innerHTML = `<div class="template-empty"><b>${escapeHtml(t('extPicker.noMatch'))}</b><span>${escapeHtml(t('extPicker.noMatchHint'))}</span></div>`;
    return;
  }

  const blankTemplates = templates.filter(isBlankTemplate);
  const readyTemplates = templates.filter((template) => !isBlankTemplate(template));
  appendTemplateGroup(box, t('extPicker.ready'), readyTemplates);
  appendTemplateGroup(box, t('extPicker.blank'), blankTemplates);
}

function isBlankTemplate(template: ExtTemplate): boolean {
  return template.file.startsWith('blank-') || template.id.startsWith('my-');
}

function appendTemplateGroup(container: HTMLElement, title: string, templates: ExtTemplate[]): void {
  if (!templates.length) return;
  const section = document.createElement('section');
  section.className = 'template-group';
  const heading = document.createElement('div');
  heading.className = 'template-group-title';
  heading.textContent = title;
  const list = document.createElement('div');
  list.className = 'template-list';
  for (const tpl of templates) {
    const el = document.createElement('button');
    el.className = 'template';
    el.title = tpl.description;
    el.innerHTML = `<span class="row"><b>${escapeHtml(tpl.label)}</b><span class="badge">${escapeHtml(typeLabel(tpl.type))}</span></span><span class="hint">${escapeHtml(tpl.description)}</span><span class="template-action">${escapeHtml(t('extPicker.use'))}</span>`;
    el.onclick = async () => {
      el.disabled = true;
      try {
        const { file } = await window.api.ext.install(tpl.file);
        $<HTMLDivElement>('#ext-picker').classList.add('hidden');
        await refreshCatalog();
        openExtEditor(file);
      } catch (e) {
        el.disabled = false;
        alert(t('extPicker.installFailed', { reason: cleanIpcError(e) }));
      }
    };
    list.appendChild(el);
  }
  section.append(heading, list);
  container.appendChild(section);
}

async function openExtEditor(file: string): Promise<void> {
  try {
    const result = await window.api.ext.read(file);
    const content = typeof result === 'string' ? result : result.content;
    const migration = typeof result === 'object' && result ? result.migration : '';
    const migrationError = typeof result === 'object' && result ? result.migrationError : '';
    editingExtFile = file;
    $('#ext-editor-title').textContent = t('extEditor.titleFile', { file });
    $<HTMLInputElement>('#ext-file').value = file;
    $<HTMLTextAreaElement>('#ext-content').value = content;
    $<HTMLInputElement>('#ext-api-key').value = '';
    if (file.endsWith('.json')) {
      // JSON 壞掉時 showExtEditorTab 會退回「進階 JSON」分頁，讓使用者直接修
      editingExtSpec = null;
      showExtEditorTab('basic');
      await refreshExtensionSecretStatus();
    } else {
      editingExtSpec = null;
      showExtEditorTab('advanced');
    }
    if (migration) await refreshCatalog();
    const entry = extSummary.entries.find((e) => e.file === file);
    showExtResult(migrationError || (migration ? null : entry && entry.error), migration || null);
    $<HTMLDivElement>('#ext-editor').classList.remove('hidden');
  } catch (e) { alert(t('extEditor.openFailed', { reason: cleanIpcError(e) })); }
}

function showExtEditorTab(tab: string): void {
  if (tab === 'basic' && editingExtFile && editingExtFile.endsWith('.js')) tab = 'advanced';
  if (tab === 'basic') {
    try {
      editingExtSpec = JSON.parse($<HTMLTextAreaElement>('#ext-content').value);
      fillExtBasic(editingExtSpec);
    } catch (e) {
      showExtResult(t('extEditor.jsonError', { reason: (e as Error).message }), null);
      tab = 'advanced';
    }
  }
  const basic = tab === 'basic';
  $<HTMLDivElement>('#ext-basic').hidden = !basic;
  $<HTMLDivElement>('#ext-advanced').hidden = basic;
  $<HTMLButtonElement>('#ext-tab-basic').classList.toggle('active', basic);
  $<HTMLButtonElement>('#ext-tab-advanced').classList.toggle('active', !basic);
  $<HTMLButtonElement>('#ext-tab-basic').setAttribute('aria-selected', String(basic));
  $<HTMLButtonElement>('#ext-tab-advanced').setAttribute('aria-selected', String(!basic));
  $<HTMLButtonElement>('#ext-tab-basic').disabled = !!(editingExtFile && editingExtFile.endsWith('.js'));
}

function fillExtBasic(spec: ExtSpec | null | undefined): void {
  const isJson = !!spec && typeof spec === 'object' && !Array.isArray(spec);
  $<HTMLDivElement>('#ext-basic-unavailable').hidden = isJson;
  $<HTMLDivElement>('#ext-basic-fields').hidden = !isJson;
  if (!isJson) return;
  $<HTMLInputElement>('#ext-id').value = spec.id || '';
  $<HTMLInputElement>('#ext-label').value = spec.label || '';
  $<HTMLSelectElement>('#ext-type').value = spec.type === 'openai' ? 'openai' : 'cli';
  $<HTMLInputElement>('#ext-bin').value = spec.bin || '';
  const simpleArgs = Array.isArray(spec.args) && spec.args.every((arg) => typeof arg === 'string');
  $<HTMLTextAreaElement>('#ext-args').disabled = Array.isArray(spec.args) && !simpleArgs;
  $<HTMLTextAreaElement>('#ext-args').value = simpleArgs ? (spec.args as string[]).join('\n') : '';
  $('#ext-args-help').textContent = $<HTMLTextAreaElement>('#ext-args').disabled ? t('extEditor.argsAdvanced') : '';
  $<HTMLInputElement>('#ext-base-url').value = spec.baseUrl || '';
  $<HTMLInputElement>('#ext-api-env').value = spec.apiKeyEnv || '';
  $<HTMLInputElement>('#ext-models').disabled = false;
  $<HTMLInputElement>('#ext-models').dataset.original = JSON.stringify(spec.models == null ? [] : spec.models);
  $<HTMLInputElement>('#ext-models').value = spec.models === 'auto' ? 'auto' : Array.isArray(spec.models) ? spec.models.map((model) => typeof model === 'string' ? model : model.id).filter(Boolean).join(', ') : '';
  $('#ext-models-help').textContent = Array.isArray(spec.models) && spec.models.some((model) => model && typeof model === 'object') ? t('extEditor.modelsKept') : '';
  updateExtTypeFields();
}

function updateExtTypeFields() {
  const api = $<HTMLSelectElement>('#ext-type').value === 'openai';
  $<HTMLDivElement>('#ext-cli-fields').hidden = api;
  $<HTMLDivElement>('#ext-api-fields').hidden = !api;
}

function syncExtBasicToJson() {
  if (!editingExtFile || editingExtFile.endsWith('.js')) return;
  let spec;
  try { spec = JSON.parse($<HTMLTextAreaElement>('#ext-content').value); } catch { spec = editingExtSpec || {}; }
  spec.id = $<HTMLInputElement>('#ext-id').value.trim();
  spec.label = $<HTMLInputElement>('#ext-label').value.trim();
  spec.type = $<HTMLSelectElement>('#ext-type').value;
  if (!$<HTMLTextAreaElement>('#ext-args').disabled) spec.args = $<HTMLTextAreaElement>('#ext-args').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  spec.bin = $<HTMLInputElement>('#ext-bin').value.trim();
  spec.baseUrl = $<HTMLInputElement>('#ext-base-url').value.trim();
  const env = $<HTMLInputElement>('#ext-api-env').value.trim();
  if (env) spec.apiKeyEnv = env; else delete spec.apiKeyEnv;
  const modelText = $<HTMLInputElement>('#ext-models').value.trim();
  if (modelText === 'auto') spec.models = 'auto';
  else {
    const ids = modelText.split(',').map((id) => id.trim()).filter(Boolean);
    let original = [];
    try { original = JSON.parse($<HTMLInputElement>('#ext-models').dataset.original || '[]'); } catch {}
    const byId = new Map((Array.isArray(original) ? original : []).filter((item) => item && typeof item === 'object').map((item) => [item.id, item]));
    spec.models = ids.map((id) => byId.get(id) || id);
  }
  if (!spec.capabilities) spec.capabilities = { attachments: spec.type === 'openai' ? ['textInline'] : ['filePath'], attachmentsNeedCwd: false };
  editingExtSpec = spec;
  $<HTMLTextAreaElement>('#ext-content').value = JSON.stringify(spec, null, 2) + '\n';
  updateExtTypeFields();
}

function extensionSecretRef(spec: ExtSpec | null = editingExtSpec): string {
  return (spec && spec.secretRef) || `adapter:${(spec && spec.id) || $<HTMLInputElement>('#ext-id').value.trim()}`;
}

async function refreshExtensionSecretStatus() {
  if (!editingExtSpec || editingExtSpec.type !== 'openai') return;
  try {
    const status = await window.api.secrets.status(extensionSecretRef(), editingExtSpec.apiKeyEnv || '');
    const badge = $('#ext-key-status');
    badge.classList.toggle('configured', status.configured);
    badge.textContent = status.configured ? `${t('extEditor.keySet', { hint: status.hint })}${status.source === 'environment' ? t('extEditor.keyEnv') : ''}` : t('extEditor.keyUnset');
    $<HTMLButtonElement>('#ext-key-clear').disabled = status.source !== 'safeStorage';
  } catch (e) { showExtResult(cleanIpcError(e), null); }
}

async function pickExtensionExecutable() {
  const file = await window.api.pickExecutable();
  if (!file) return;
  $<HTMLInputElement>('#ext-bin').value = file;
  syncExtBasicToJson();
}

async function clearExtensionSecret() {
  try {
    await window.api.secrets.clear(extensionSecretRef());
    const spec = JSON.parse($<HTMLTextAreaElement>('#ext-content').value);
    delete spec.secretRef;
    editingExtSpec = spec;
    $<HTMLTextAreaElement>('#ext-content').value = JSON.stringify(spec, null, 2) + '\n';
    $<HTMLInputElement>('#ext-api-key').value = '';
    syncExtBasicToJson();
    await refreshExtensionSecretStatus();
    showExtResult(null, t('extEditor.keyCleared'));
  } catch (e) { showExtResult(cleanIpcError(e), null); }
}

async function testExtensionConnection() {
  const saved = await saveExtension({ quiet: true });
  if (!saved) return;
  $<HTMLButtonElement>('#ext-key-test').disabled = true;
  try {
    const result = await window.api.secrets.test(editingExtSpec?.id || '');
    showExtResult(result.ok ? null : result.error, result.ok ? `✓ ${result.version || t('extEditor.connected')}` : null);
  } catch (e) { showExtResult(cleanIpcError(e), null); }
  finally { $<HTMLButtonElement>('#ext-key-test').disabled = false; }
}

function showExtResult(error: string | null | undefined | false, ok: string | null): void {
  $<HTMLDivElement>('#ext-error').hidden = !error;
  $<HTMLDivElement>('#ext-error').textContent = error ? `⚠ ${error}` : '';
  $<HTMLDivElement>('#ext-ok').hidden = !ok;
  $<HTMLDivElement>('#ext-ok').textContent = ok || '';
}

async function saveExtension({ quiet = false }: { quiet?: boolean } = {}): Promise<boolean> {
  const file = $<HTMLInputElement>('#ext-file').value.trim();
  try {
    if (!file.endsWith('.js')) {
      // 在「進階 JSON」分頁儲存時以 JSON 為準，不能拿基本欄位的舊值覆蓋
      if (!$<HTMLDivElement>('#ext-basic').hidden) syncExtBasicToJson();
      const spec = JSON.parse($<HTMLTextAreaElement>('#ext-content').value);
      const key = $<HTMLInputElement>('#ext-api-key').value.trim();
      if (spec.type === 'openai' && key) {
        spec.secretRef = extensionSecretRef(spec);
        await window.api.secrets.set(spec.secretRef, key);
        $<HTMLInputElement>('#ext-api-key').value = '';
        editingExtSpec = spec;
        $<HTMLTextAreaElement>('#ext-content').value = JSON.stringify(spec, null, 2) + '\n';
      }
    }
    const { error } = await window.api.ext.write(file, $<HTMLTextAreaElement>('#ext-content').value, editingExtFile);
    editingExtFile = file;
    $('#ext-editor-title').textContent = t('extEditor.titleFile', { file });
    await refreshCatalog();
    await refreshExtensionSecretStatus();
    if (error || !quiet) showExtResult(error, error ? null : t('extEditor.saved'));
    return !error;
  } catch (e) {
    showExtResult(cleanIpcError(e), null);
    return false;
  }
}

async function deleteExtension() {
  if (!editingExtFile || !confirm(t('extEditor.confirmDelete', { file: editingExtFile }))) return;
  await window.api.ext.remove(editingExtFile);
  $<HTMLDivElement>('#ext-editor').classList.add('hidden');
  editingExtFile = null;
  await refreshCatalog();
}

// Electron 會把主程序錯誤包成 "Error invoking remote method 'x': Error: 訊息"
function cleanIpcError(e: unknown): string {
  return String((e && (e as Error).message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ---------- 側欄 ----------
function renderSidebar() {
  const list = $<HTMLDivElement>('#agent-list');
  list.innerHTML = '';
  const lead = config.settings.leadAgentId || config.agents.find((a) => a.enabled !== false)?.id;
  for (const a of config.agents) {
    const el = document.createElement('div');
    el.className = 'agent-card' + (a.enabled === false ? ' disabled' : '');
    el.dataset.agentId = a.id;
    // 健康狀態要畫在成員卡上。以前只在「轉接器沒註冊」時給徽章,所以綁到一個沒安裝的
    // CLI 的成員看起來完全正常——使用者要等送出任務失敗才知道,而那時已經浪費一輪。
    const health = cliTypes[a.cli] ? cliStatus[a.cli] : null;
    const healthBadge = !cliTypes[a.cli]
      ? `<span class="badge bad">${escapeHtml(t('agent.cliMissing'))}</span>`
      : health && health.state === 'missing'
        ? `<span class="badge bad" title="${escapeHtml(health.error || '')}">${escapeHtml(t('agent.notInstalled'))}</span>`
        : health && health.state === 'unauthenticated'
          ? `<span class="badge warn" title="${escapeHtml(health.hint || health.error || '')}">${escapeHtml(t('agent.needsKey'))}</span>`
          : health && health.state === 'unreachable'
            ? `<span class="badge warn" title="${escapeHtml(health.hint || health.error || '')}">${escapeHtml(t('agent.offline'))}</span>`
            : '';
    const editBadge = cliTypes[a.cli] && !(a.canEdit && cliTypes[a.cli].supportsEdit)
      ? `<span class="badge">${escapeHtml(t('agent.readOnly'))}</span>` : '';
    el.innerHTML = `
      <div class="avatar" style="background:${a.color}">${initials(a.name)}</div>
      <div class="agent-info">
        <div class="agent-name">${escapeHtml(a.name)} ${a.id === lead ? `<span class="badge lead">${escapeHtml(t('agent.lead'))}</span>` : ''} ${healthBadge}${editBadge}</div>
        <div class="agent-meta">${escapeHtml(cliLabel(cliTypes[a.cli], a.cli))} · ${escapeHtml(a.model || t('agent.defaultModel'))} · ${escapeHtml(a.effort || t('agent.defaultEffort'))}</div>
        ${a.persona ? `<div class="agent-meta persona">${escapeHtml(a.persona)}</div>` : ''}
      </div>`;
    el.onclick = () => openModal(a.id);
    list.appendChild(el);
  }
  $<HTMLInputElement>('#work-dir').value = config.settings.workDir || '';
  $<HTMLInputElement>('#max-rounds').value = String(config.settings.maxRounds || 3);
  $<HTMLInputElement>('#language').value = config.settings.language || '繁體中文';
  $<HTMLSelectElement>('#default-mode').value = config.settings.mode || 'divide';
  $<HTMLInputElement>('#max-transcript').value = String(config.settings.maxTranscriptChars ?? 60000);
  const workDir = config.settings.workDir || '';
  $('#workdir-label').textContent = workDir ? shortPath(workDir) : t('topbar.workdirUnset');
  $<HTMLButtonElement>('#workdir-chip').title = t('topbar.workdirTitle', { dir: workDir || t('topbar.unset') });
  const sel = $<HTMLSelectElement>('#lead-agent');
  sel.innerHTML = config.agents.filter((a) => a.enabled !== false).map((a) => `<option value="${a.id}" ${a.id === lead ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('');
  updateSpeakingHighlight();
}

function saveSettings() {
  config.settings.workDir = $<HTMLInputElement>('#work-dir').value.trim();
  config.settings.maxRounds = Number($<HTMLInputElement>('#max-rounds').value) || 3;
  config.settings.language = $<HTMLInputElement>('#language').value.trim() || '繁體中文';
  config.settings.leadAgentId = $<HTMLSelectElement>('#lead-agent').value || null;
  config.settings.mode = $<HTMLSelectElement>('#default-mode').value || 'divide';
  const maxTranscript = Number($<HTMLInputElement>('#max-transcript').value);
  config.settings.maxTranscriptChars = Number.isFinite(maxTranscript) && maxTranscript >= 0 ? maxTranscript : 60000;
  $<HTMLSelectElement>('#mode').value = config.settings.mode;
  window.api.saveConfig(config);
  renderSidebar();
  flashSaved();
}

// ---------- 成員編輯 ----------
async function openModal(id: string | null): Promise<void> {
  editingId = id;
  // 每次打開都重抓:CLI 更新模型快取後不用重開 app。主程序有依檔案修改時間快取,重抓很便宜。
  try { cliTypes = await window.api.cliTypes(); } catch {}
  const blank: Omit<AgentConfig, 'id'> = { name: '', cli: 'claude', model: '', effort: '', persona: '', color: randomColor(), canEdit: true, enabled: true, customCommand: '' };
  // id 一定來自 config.agents(側欄與 @ 選單都是從它產生的),find 不會落空。
  const a: Omit<AgentConfig, 'id'> = id ? (config.agents.find((x) => x.id === id) as AgentConfig) : blank;
  $('#modal-title').textContent = id ? t('agent.editTitle') : t('agent.addTitle');
  const groups: Array<[string, (type: CliType) => boolean]> = [[t('agent.groupBuiltin'), (type) => type.origin === 'builtin'], [t('agent.groupExt'), (type) => type.origin !== 'builtin']];
  let cliOptions = groups.map(([name, pick]) => {
    const opts = Object.values(cliTypes).filter(pick).map((type) => `<option value="${escapeHtml(type.id)}">${escapeHtml(cliLabel(type, type.id))}${type.type !== 'builtin' ? `(${escapeHtml(typeLabel(type.type))})` : ''}</option>`).join('');
    return opts ? `<optgroup label="${escapeHtml(name)}">${opts}</optgroup>` : '';
  }).join('');
  if (a.cli && !cliTypes[a.cli]) cliOptions += `<option value="${escapeHtml(a.cli)}">${escapeHtml(a.cli)}${escapeHtml(t('agent.cliNotFound'))}</option>`;
  $<HTMLSelectElement>('#f-cli').innerHTML = cliOptions;
  $<HTMLSelectElement>('#f-cli').value = a.cli;
  $<HTMLInputElement>('#f-name').value = a.name;
  $<HTMLInputElement>('#f-color').value = a.color;
  $<HTMLTextAreaElement>('#f-persona').value = a.persona || '';
  $<HTMLInputElement>('#f-canEdit').checked = !!a.canEdit;
  $<HTMLInputElement>('#f-enabled').checked = a.enabled !== false;
  $<HTMLInputElement>('#f-custom').value = a.customCommand || '';
  fillCliDependentFields(a.cli, a.model, a.effort);
  $<HTMLButtonElement>('#modal-delete').style.visibility = id ? 'visible' : 'hidden';
  $<HTMLDivElement>('#modal').classList.remove('hidden');
  $<HTMLInputElement>('#f-name').focus();
}
// ---------- 模型與強度 ----------
const CUSTOM_MODEL = '__custom__';
const modelsOf = (cli: string): Model[] => (cliTypes[cli] || {}).models || [];
const findModel = (cli: string, name: string): Model | null => ModelRules.findModel(modelsOf(cli), name);

function fillCliDependentFields(cli: string, model?: string, effort?: string): void {
  const models = modelsOf(cli);
  const isCustomCli = !!(cliTypes[cli] && cliTypes[cli].usesCustomCommand);
  const sel = $<HTMLSelectElement>('#f-model-select');
  sel.innerHTML = `<option value="">${escapeHtml(t('agent.cliDefaultModel'))}</option>`
    + models.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label !== m.id ? `${m.id}(${m.label})` : m.id)}</option>`).join('')
    + `<option value="${CUSTOM_MODEL}">${escapeHtml(t('agent.otherModel'))}</option>`;

  // model 為 undefined 代表剛切換 CLI:預設選清單第一個。舊設定存的別名(例如 opus)會對應到完整名稱。
  const raw = model === undefined ? (models[0] ? models[0].id : '') : String(model || '');
  const known = raw === '' ? null : findModel(cli, raw);
  const manual = isCustomCli || (raw !== '' && !known);
  sel.value = manual ? CUSTOM_MODEL : (known ? known.id : '');
  sel.style.display = isCustomCli ? 'none' : '';
  $<HTMLInputElement>('#f-model').value = manual ? raw : '';
  $<HTMLInputElement>('#f-model').style.display = manual ? '' : 'none';
  $('#f-custom-wrap').style.display = isCustomCli ? '' : 'none';
  updateEditCapability(cli);
  refreshModelDependents(effort);
}

// 轉接器不支援修改檔案時(例如 API),停用勾選框並說明原因;成員原本的設定保留不動。
function updateEditCapability(cli: string): void {
  const type = cliTypes[cli];
  const supported = !type || type.supportsEdit;
  const box = $<HTMLInputElement>('#f-canEdit');
  box.disabled = !supported;
  let note = $<HTMLDivElement>('#f-canEdit-note');
  if (!note) {
    note = document.createElement('div');
    note.id = 'f-canEdit-note';
    note.className = 'field-note';
    $('#f-canEdit-wrap').after(note);
  }
  note.textContent = supported ? '' : t('agent.cannotEdit', { label: cliLabel(type, cli) });
  note.hidden = !!supported;
}

function currentModel() {
  const v = $<HTMLSelectElement>('#f-model-select').value;
  return v === CUSTOM_MODEL ? $<HTMLInputElement>('#f-model').value.trim() : v;
}

function onModelSelect() {
  const manual = $<HTMLSelectElement>('#f-model-select').value === CUSTOM_MODEL;
  $<HTMLInputElement>('#f-model').style.display = manual ? '' : 'none';
  if (manual) $<HTMLInputElement>('#f-model').focus();
  refreshModelDependents();
}

// 依目前選的模型更新說明文字與強度選單。effort 未給時沿用畫面上的選擇。
function refreshModelDependents(effort?: string): void {
  const cli = $<HTMLSelectElement>('#f-cli').value;
  const type = cliTypes[cli] || {};
  const source = type.modelSource;
  const info = findModel(cli, currentModel());
  const notes = [];
  if (info && info.description) notes.push(info.description);
  if (source === 'fallback') notes.push(t('agent.fallbackNote'));
  if (source === 'error') notes.push(t('agent.modelErrorNote', { error: type.modelError || t('agent.unknownError') }));
  if (source === 'loading') notes.push(t('agent.loadingNote'));
  if (type.description && type.origin !== 'builtin' && !info) notes.push(type.description);
  $<HTMLDivElement>('#f-model-desc').textContent = notes.join(' ');
  fillEfforts(cli, info, effort === undefined ? $<HTMLSelectElement>('#f-effort').value : effort);
}

function fillEfforts(cli: string, info: Model | null, wanted: string): void {
  const eff = $<HTMLSelectElement>('#f-effort');
  const type = cliTypes[cli] || {};
  const restricted = !!info && !info.unrestrictedEffort;
  // 認得且有限制的模型用它自己的強度清單;其他情況列出轉接器設定的強度與所有模型強度的聯集。
  let efforts: string[];
  if (restricted) efforts = info!.efforts || [];
  else {
    const pool = new Set([...(type.efforts || []), ...modelsOf(cli).flatMap((m) => m.efforts || [])]);
    efforts = [...ModelRules.EFFORT_RANK.filter((e) => pool.has(e)), ...[...pool].filter((e) => !ModelRules.EFFORT_RANK.includes(e))];
  }
  const unsupported = restricted && efforts.length === 0;
  eff.disabled = efforts.length === 0;
  eff.innerHTML = unsupported
    ? `<option value="">${escapeHtml(t('agent.effortUnsupported'))}</option>`
    : efforts.length === 0
      ? `<option value="">${escapeHtml(t('agent.effortNone'))}</option>`
      : `<option value="">${escapeHtml(info && info.defaultEffort ? t('agent.effortDefaultOf', { effort: info.defaultEffort }) : t('agent.effortDefault'))}</option>` + efforts.map((e) => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join('');
  // 換模型時保留原本的強度;新模型不支援就降到最接近的等級,跟實際執行時的規則一致。
  const resolved = restricted ? ModelRules.resolveEffort([info!], info!.id, wanted).effort : wanted;
  eff.value = resolved && efforts.includes(resolved) ? resolved : '';
}

function closeModal() { $<HTMLDivElement>('#modal').classList.add('hidden'); }
function saveModal() {
  const name = $<HTMLInputElement>('#f-name').value.trim();
  if (!name) { $<HTMLInputElement>('#f-name').focus(); return; }
  const data = { name, cli: $<HTMLSelectElement>('#f-cli').value, model: ModelRules.resolveModelId(modelsOf($<HTMLSelectElement>('#f-cli').value), currentModel()), effort: $<HTMLSelectElement>('#f-effort').value, persona: $<HTMLTextAreaElement>('#f-persona').value.trim(), color: $<HTMLInputElement>('#f-color').value, canEdit: $<HTMLInputElement>('#f-canEdit').checked, enabled: $<HTMLInputElement>('#f-enabled').checked, customCommand: $<HTMLInputElement>('#f-custom').value.trim() };
  if (editingId) Object.assign(config.agents.find((x) => x.id === editingId) as AgentConfig, data);
  else config.agents.push({ id: crypto.randomUUID(), ...data });
  window.api.saveConfig(config);
  renderSidebar();
  closeModal();
}
function deleteAgent() {
  if (!editingId || !confirm(t('agent.confirmDelete'))) return;
  config.agents = config.agents.filter((x) => x.id !== editingId);
  if (config.settings.leadAgentId === editingId) config.settings.leadAgentId = null;
  window.api.saveConfig(config);
  renderSidebar();
  closeModal();
}

// ---------- 對話 ----------
const ATTACH_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'txt', 'md', 'json', 'csv', 'log', 'pdf']);
const ATTACH_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const pendingAttachments: PendingAttachment[] = [];
const attachLimits: AttachLimits = { maxFiles: 10, maxFileBytes: 20 * 1024 * 1024, maxTotalBytes: 50 * 1024 * 1024 };

async function sendMessage() {
  closeMentionMenu();
  const text = $<HTMLTextAreaElement>('#input').value.trim();
  if (!text && !pendingAttachments.length) return;
  const attachments = pendingAttachments.map((item) => ({
    id: item.id,
    name: item.name,
    mime: item.mime,
    size: item.size,
    kind: item.kind,
    path: item.path || null,
    relPath: item.relPath || null,
    thumb: item.thumb || null,
  }));
  const toClear = pendingAttachments.splice(0, pendingAttachments.length);
  $<HTMLTextAreaElement>('#input').value = '';
  updateComposerHint();
  renderAttachChips();
  clearAttachError();
  try {
    await window.api.send(text, $<HTMLSelectElement>('#mode').value, attachments);
    revokeThumbUrls(toClear);
  } catch (error) {
    pendingAttachments.unshift(...toClear);
    renderAttachChips();
    showAttachError(cleanIpcError(error) || t('composer.sendFailed'));
  }
}

function setState(s: ChatState): void {
  running = !!s.running;
  const pill = $<HTMLDivElement>('#phase-pill');
  pill.textContent = running ? phaseText(s.phase) : t('phase.idle');
  pill.className = 'phase ' + (running ? 'busy' : 'idle');
  $<HTMLButtonElement>('#stop-btn').disabled = !running;
  updateComposerHint();
  if (openHistoryId) updateResumeButton();
  updateSpeakingHighlight();
  if (Object.prototype.hasOwnProperty.call(s, 'question')) renderQuestion(s.question || null);
}

function renderQuestion(question: PendingQuestion | null): void {
  const previous = currentQuestion;
  currentQuestion = question;
  if (!question) {
    clearInterval(questionTimer);
    questionTimer = undefined;
    answeredQuestionId = null;
    document.querySelector('#pending-question')?.remove();
    return;
  }
  if (previous?.id === question.id && document.querySelector('#pending-question')) {
    updateQuestionCountdown();
    return;
  }
  clearInterval(questionTimer);
  answeredQuestionId = null;
  document.querySelector('#pending-question')?.remove();
  const card = document.createElement('section');
  card.id = 'pending-question';
  card.className = 'question-card';
  card.setAttribute('aria-labelledby', 'pending-question-title');

  const head = document.createElement('div');
  head.className = 'question-card-head';
  head.innerHTML = `<strong>${escapeHtml(t('question.label', { name: question.agentName }))}</strong><span class="question-countdown"></span>`;
  card.appendChild(head);
  const text = document.createElement('div');
  text.id = 'pending-question-title';
  text.className = 'question-text';
  text.textContent = question.question;
  card.appendChild(text);

  if (question.options.length) {
    const options = document.createElement('div');
    options.className = 'question-options';
    for (const option of question.options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'question-option';
      button.innerHTML = `<span class="question-option-id">${escapeHtml(option.id.toUpperCase())}</span><span class="question-option-copy"><b>${escapeHtml(option.label)}</b>${option.detail ? `<small>${escapeHtml(option.detail)}</small>` : ''}</span>`;
      button.onclick = () => submitQuestion({ id: question.id, optionIds: [option.id], decision: 'answered' });
      options.appendChild(button);
    }
    card.appendChild(options);
  }

  const actions = document.createElement('div');
  actions.className = 'question-actions';
  if (question.allowFree) {
    const free = document.createElement('form');
    free.className = 'question-free';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = t('question.freePlaceholder');
    input.setAttribute('aria-label', t('question.freePlaceholder'));
    const send = document.createElement('button');
    send.type = 'submit';
    send.className = 'primary';
    send.textContent = t('question.send');
    free.onsubmit = (event) => {
      event.preventDefault();
      const answer = input.value.trim();
      if (!answer) { input.focus(); return; }
      submitQuestion({ id: question.id, text: answer, decision: 'answered' });
    };
    free.append(input, send);
    actions.appendChild(free);
  }
  const defer = document.createElement('button');
  defer.type = 'button';
  defer.className = 'ghost';
  defer.textContent = t('question.defer');
  defer.onclick = () => submitQuestion({ id: question.id, decision: 'defer' });
  actions.appendChild(defer);
  card.appendChild(actions);
  const status = document.createElement('div');
  status.className = 'question-card-status';
  status.setAttribute('aria-live', 'polite');
  card.appendChild(status);

  const timeline = $<HTMLDivElement>('#timeline');
  const empty = $<HTMLDivElement>('#empty');
  if (empty) empty.style.display = 'none';
  timeline.appendChild(card);
  updateQuestionCountdown();
  questionTimer = setInterval(updateQuestionCountdown, 1000);
  timeline.scrollTop = timeline.scrollHeight;
}

function submitQuestion(answer: QuestionAnswer): void {
  if (!currentQuestion || currentQuestion.id !== answer.id || answeredQuestionId === answer.id || Date.now() >= currentQuestion.expiresAt) return;
  answeredQuestionId = answer.id;
  void window.api.answerQuestion(answer);
  disableQuestionCard('answered');
}

function updateQuestionCountdown(): void {
  if (!currentQuestion) return;
  const remaining = Math.max(0, currentQuestion.expiresAt - Date.now());
  const seconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(seconds / 60);
  const time = `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  const countdown = document.querySelector<HTMLElement>('#pending-question .question-countdown');
  if (countdown) countdown.textContent = remaining > 0 ? t('question.remaining', { time }) : t('question.expired');
  if (remaining <= 0 && answeredQuestionId !== currentQuestion.id) disableQuestionCard('expired');
}

function disableQuestionCard(reason: 'answered' | 'expired'): void {
  clearInterval(questionTimer);
  questionTimer = undefined;
  const card = document.querySelector<HTMLElement>('#pending-question');
  if (!card) return;
  card.classList.add(reason);
  card.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach((control) => { control.disabled = true; });
  const status = card.querySelector<HTMLElement>('.question-card-status');
  if (status) status.textContent = t(reason === 'answered' ? 'question.sent' : 'question.expired');
}

// ---------- @ 指定成員 ----------
function enabledAgents() { return (config && config.agents ? config.agents : []).filter((a) => a.enabled !== false); }

function updateComposerHint() {
  const mentioned = Marker.findMentions ? Marker.findMentions($<HTMLTextAreaElement>('#input').value, enabledAgents()) : [];
  const names = joinNames(mentioned.map((a) => a.name));
  let text = '';
  if (mentioned.length && running) text = t('hint.mentionRunning', { names });
  else if (mentioned.length) text = t('hint.mentionIdle', { names });
  else if (running) text = t('hint.running');
  if (pendingAttachments.some((item) => item.kind === 'image')) {
    const targets = mentioned.length ? mentioned : enabledAgents();
    const unsupported = targets.filter((agent) => {
      const modes = cliTypes[agent.cli]?.capabilities?.attachments || [];
      return !modes.includes('imageInline') && !modes.includes('filePath');
    });
    if (unsupported.length) text = [text, t('attach.imageUnavailable', { names: joinNames(unsupported.map((a) => a.name)) })].filter(Boolean).join(' ');
  }
  const hint = $('#hint');
  hint.textContent = text;
  hint.title = text;
  hint.classList.toggle('mention-hint', mentioned.length > 0);
}

// 游標前面是「@查詢字」時回傳範圍;@ 前面是英數字(例如 email)不算
function mentionContext(): { start: number; query: string } | null {
  const input = $<HTMLTextAreaElement>('#input');
  if (input.selectionStart !== input.selectionEnd) return null;
  const before = input.value.slice(0, input.selectionStart);
  const match = before.match(/(^|[^A-Za-z0-9_])[@＠]([^\s@＠]{0,40})$/);
  if (!match) return null;
  return { start: input.selectionStart - match[2].length - 1, query: match[2] };
}

function updateMentionMenu() {
  const ctx = mentionContext();
  if (!ctx) { closeMentionMenu(); return; }
  const query = ctx.query.toLowerCase();
  const items = enabledAgents()
    .filter((a) => a.name.toLowerCase().includes(query))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(query)) - Number(!b.name.toLowerCase().startsWith(query)));
  if (!items.length) { closeMentionMenu(); return; }
  const same = mentionMenu.open && mentionMenu.items.map((a) => a.id).join() === items.map((a) => a.id).join();
  Object.assign(mentionMenu, { open: true, start: ctx.start, items, index: same ? Math.min(mentionMenu.index, items.length - 1) : 0 });
  renderMentionMenu();
}

function renderMentionMenu() {
  const menu = $<HTMLDivElement>('#mention-menu');
  menu.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'mention-menu-head';
  head.textContent = t('composer.mentionMenu');
  menu.appendChild(head);
  mentionMenu.items.forEach((agent, i) => {
    const option = document.createElement('div');
    option.className = `mention-option${i === mentionMenu.index ? ' active' : ''}`;
    option.id = `mention-option-${i}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(i === mentionMenu.index));
    const type = cliTypes[agent.cli] || {};
    option.innerHTML = `<div class="avatar" style="background:${escapeHtml(agent.color || '#6c8cff')}">${escapeHtml(initials(agent.name))}</div><div class="mention-option-main"><b>${escapeHtml(agent.name)}</b><span>${escapeHtml([cliLabel(type, agent.cli), agent.model].filter(Boolean).join(' · '))}</span></div>`;
    // mousedown 就選取:click 會先觸發輸入框 blur 把選單關掉
    option.addEventListener('mousedown', (e) => { e.preventDefault(); pickMention(i); });
    option.addEventListener('mousemove', () => { if (mentionMenu.index !== i) { mentionMenu.index = i; renderMentionMenu(); } });
    menu.appendChild(option);
  });
  menu.hidden = false;
  $<HTMLTextAreaElement>('#input').setAttribute('aria-activedescendant', `mention-option-${mentionMenu.index}`);
}

function closeMentionMenu() {
  if (!mentionMenu.open) return;
  mentionMenu.open = false;
  $<HTMLDivElement>('#mention-menu').hidden = true;
  $<HTMLTextAreaElement>('#input').removeAttribute('aria-activedescendant');
}

function pickMention(index: number): void {
  const agent = mentionMenu.items[index];
  if (!agent) return;
  const input = $<HTMLTextAreaElement>('#input');
  const end = input.selectionStart;
  const insert = `@${agent.name} `;
  input.setRangeText(insert, mentionMenu.start, end, 'end');
  closeMentionMenu();
  input.focus();
  updateComposerHint();
}

function handleMentionKey(e: KeyboardEvent): boolean {
  if (!mentionMenu.open || e.isComposing) return false;
  const count = mentionMenu.items.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    mentionMenu.index = (mentionMenu.index + (e.key === 'ArrowDown' ? 1 : -1) + count) % count;
    renderMentionMenu();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    pickMention(mentionMenu.index);
  } else if (e.key === 'Escape') {
    closeMentionMenu();
  } else {
    return false;
  }
  e.preventDefault();
  e.stopPropagation();
  return true;
}

// 使用者訊息裡的 @名稱 標成膠囊;跳過程式碼區塊
function highlightMentions(root: HTMLElement | null, mentions: ChatMessage['mentions']): void {
  const names = (Array.isArray(mentions) ? mentions : []).map((m) => m && m.name).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!root || !names.length) return;
  const pattern = new RegExp(`[@＠](${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![A-Za-z0-9_-])`, 'gi');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement && node.parentElement.closest('code, pre, .mention') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.nodeValue || '';
    pattern.lastIndex = 0;
    if (!pattern.test(text)) continue;
    pattern.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      frag.append(text.slice(last, match.index ?? 0));
      const chip = document.createElement('span');
      chip.className = 'mention';
      chip.textContent = `@${match[1]}`;
      frag.append(chip);
      last = (match.index ?? 0) + match[0].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

function renderMessage(m: ChatMessage, { animate = false }: { animate?: boolean } = {}): void {
  messageData.set(m.id, m);
  updateUsageTotal();
  const tl = $<HTMLDivElement>('#timeline');
  const empty = $<HTMLDivElement>('#empty');
  if (empty) empty.style.display = 'none';
  let el = msgEls.get(m.id);
  const atBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 80;
  const isNew = !el;
  let placed: { node: HTMLElement; isNewNode: boolean } | null = null;
  if (!el) {
    el = document.createElement('div');
    msgEls.set(m.id, el);
    placed = placeMessage(el, m);
    if (animate) {
      el!.classList.add('enter');
      el!.addEventListener('animationend', () => el!.classList.remove('enter'), { once: true });
    }
  }
  el.className = `msg ${m.kind} ${m.level || ''} ${m.status === 'running' ? 'streaming' : ''}${el.classList.contains('enter') ? ' enter' : ''}${el.classList.contains('msg-continue') ? ' msg-continue' : ''}`;
  if (m.agentId) el.dataset.agentId = m.agentId;
  else delete el.dataset.agentId;
  if (m.kind === 'agent') renderAgentMessage(el, m);
  else if (m.kind === 'user') renderUserMessage(el, m);
  else el.innerHTML = systemHtml(m);
  if (isNew && placed!.isNewNode) insertTimelineMarkers(placed!.node, m);
  if (el.parentElement && el.parentElement.classList.contains('msg-group')) el.classList.remove('msg-continue');
  else updateContinuation(el);
  updateSpeakingHighlight();
  if (atBottom) tl.scrollTop = tl.scrollHeight;
}

// 同一批平行發言(m.group)放進同一個格狀容器:每列最多三則,第四則起換行
function placeMessage(el: HTMLElement, m: ChatMessage): { node: HTMLElement; isNewNode: boolean } {
  const tl = $<HTMLDivElement>('#timeline');
  if (!m.group) { tl.appendChild(el); return { node: el, isNewNode: true }; }
  const existing = [...tl.children].find((node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains('msg-group') && node.dataset.group === m.group);
  const isNewNode = !existing;
  let group: HTMLElement;
  if (existing) group = existing;
  else {
    group = document.createElement('div');
    group.className = 'msg-group';
    group.dataset.group = m.group;
    tl.appendChild(group);
  }
  group.appendChild(el);
  const count = group.children.length;
  group.dataset.count = String(count);
  group.style.setProperty('--cols', String(Math.min(count, 3)));
  return { node: group, isNewNode };
}

// PhaseCode -> 時間軸分組。divide/execute 併成「分工執行」,review/repair/summary 併成「交叉審查」。
const STAGE_OF_CODE: Record<string, string> = {
  direct: 'direct', discuss: 'discuss',
  divide: 'execute', execute: 'execute',
  review: 'review', repair: 'review', summary: 'review',
};

// 顯示文字一律在 renderer 這側依介面語言組出。
const PHASE_CODES = new Set(['idle', 'direct', 'discuss', 'ask', 'divide', 'execute', 'review', 'repair', 'summary']);

function phaseText(phase: PhaseValue | undefined | null): string {
  if (!phase) return '';
  if (!isPhaseInfo(phase)) return phase; // 舊 session 存的是現成字串,原樣顯示
  const label = PHASE_CODES.has(phase.code) ? t(`phase.${phase.code}`) : phase.code;
  if (phase.code === 'discuss' && phase.round) {
    return phase.maxRounds ? t('phase.discussRound', { label, round: phase.round, max: phase.maxRounds }) : t('phase.discussR', { label, round: phase.round });
  }
  if (phase.code === 'direct' && phase.names && phase.names.length) return `${label} ${joinNames(phase.names)}`;
  return label;
}

// 舊 session 沒有 code 欄位時才走:沿用當初寫給訊息層 phase 字串的比對規則。
function legacyStage(phase: string): string {
  if (phase === '指定') return 'direct';
  if (/^討論/.test(phase)) return 'discuss';
  if (phase === '分工' || phase === '執行') return 'execute';
  if (phase === '審查' || phase === '修復' || phase === '總結') return 'review';
  return '';
}

function stageFromMessage(m: ChatMessage): string {
  if (m.directed) return 'direct';
  const phase = m.phase;
  if (isPhaseInfo(phase)) return STAGE_OF_CODE[phase.code] || '';
  return legacyStage(String(phase || ''));
}

function roundFromMessage(m: ChatMessage): number {
  const phase = m.phase;
  if (isPhaseInfo(phase)) return phase.code === 'discuss' ? Number(phase.round) || 0 : 0;
  const match = String(phase || '').match(/討論\s*R(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function adjacentMsg(el: HTMLElement, dir: number): HTMLElement | null {
  let node: Element | null = dir < 0 ? el.previousElementSibling : el.nextElementSibling;
  while (node && !node.classList.contains('msg') && !node.classList.contains('msg-group')) {
    node = dir < 0 ? node.previousElementSibling : node.nextElementSibling;
  }
  return node as HTMLElement | null;
}

function insertTimelineMarkers(el: HTMLElement, m: ChatMessage): void {
  const prev = adjacentMsg(el, -1);
  const inherited = prev ? prev.dataset.stage : '';
  const stage = stageFromMessage(m) || inherited || (m.kind === 'user' ? 'discuss' : '');
  const round = roundFromMessage(m);
  el.dataset.stage = stage || '';
  el.dataset.round = round ? String(round) : (stage && stage === inherited ? (prev && prev.dataset.round) || '' : '');
  if (stage && stage !== inherited) {
    const divider = document.createElement('div');
    divider.className = 'tl-stage';
    divider.innerHTML = `<span class="tl-stage-label">${escapeHtml(['discuss', 'execute', 'review', 'direct'].includes(stage) ? t(`stage.${stage}`) : stage)}</span>`;
    el.before(divider);
  }
  if (round && String(round) !== (prev && prev.dataset.round || '')) {
    const maxRounds = Number(config && config.settings && config.settings.maxRounds) || 0;
    const divider = document.createElement('div');
    divider.className = 'tl-round';
    divider.textContent = maxRounds ? t('timeline.round', { round, max: maxRounds }) : t('timeline.roundOnly', { round });
    el.before(divider);
  }
}

function updateContinuation(el: HTMLElement): void {
  const prev = adjacentMsg(el, -1);
  const key = el.dataset.agentId || '';
  el.classList.toggle('msg-continue', !!(key && el.classList.contains('agent') && prev && prev.dataset.agentId === key));
  const next = adjacentMsg(el, 1);
  if (next) next.classList.toggle('msg-continue', !!(next.dataset.agentId && next.classList.contains('agent') && next.dataset.agentId === key));
}

function updateSpeakingHighlight() {
  const speaking = new Set();
  for (const message of messageData.values()) {
    if (message.kind === 'agent' && message.status === 'running' && message.agentId) speaking.add(message.agentId);
  }
  document.querySelectorAll<HTMLElement>('#agent-list .agent-card').forEach((card) => {
    card.classList.toggle('speaking', speaking.has(card.dataset.agentId));
  });
}

function userHtml(m: ChatMessage): string {
  return `<div class="avatar" style="background:var(--user-avatar)">${escapeHtml(t('msg.me'))}</div><div class="bubble"><div class="body">${md(m.text || '')}</div>${attachmentsMarkup(m.attachments)}</div>`;
}
function systemHtml(m: ChatMessage): string {
  if (m.tag === 'tool-audit' && Array.isArray(m.toolAudit) && m.toolAudit.length) return toolAuditHtml(m);
  return `<div class="bubble"><div class="body">${md(m.text || '')}</div></div>`;
}

// 檔案工具的稽核紀錄。這是「成員實際做了什麼」,和它自己在報告裡說的話是兩回事;
// 失敗要看得出來——靜默失敗會讓使用者以為改好了,實際上什麼也沒發生。
function toolAuditHtml(m: ChatMessage): string {
  const rows = (m.toolAudit || []).map((e) => {
    // 統計退化成整檔行數時會嚴重高估,不標出來使用者會把它當精確數字
    const approx = e.statsApproximate
      ? `<span class="tool-approx" title="${escapeHtml(t('tool.approxTitle'))}">${escapeHtml(t('tool.approx'))}</span>`
      : '';
    const counts = e.added != null || e.removed != null
      ? `<span class="tool-counts"><span class="diff-plus">+${e.added || 0}</span> <span class="diff-minus">−${e.removed || 0}</span>${approx}</span>`
      : '';
    const note = e.ok
      ? (e.reason ? `<div class="tool-note">${escapeHtml(e.reason)}</div>` : '')
      : `<div class="tool-note error">${escapeHtml(e.error || t('tool.unknownError'))}</div>`;
    return `<div class="tool-row ${e.ok ? 'ok' : 'bad'}">`
      + `<span class="tool-mark">${e.ok ? '✓' : '✗'}</span>`
      + `<span class="tool-name">${escapeHtml(e.tool)}</span>`
      + `<span class="tool-path">${escapeHtml(e.path || '')}</span>`
      + counts
      + note
      + '</div>';
  }).join('');
  // 標題沿用主程序組好的第一行(含成員名稱),語系已經在那邊決定
  const title = (m.text || '').split('\n')[0].replace(/\*\*/g, '');
  return `<div class="bubble"><div class="body tool-audit"><div class="tool-audit-title">${escapeHtml(title)}</div>${rows}</div></div>`;
}

function renderUserMessage(el: HTMLElement, m: ChatMessage): void {
  el.innerHTML = userHtml(m);
  highlightMentions(el.querySelector('.body'), m.mentions);
  hydrateAttachmentThumbs(el, m.attachments);
}

function attachmentsMarkup(list: AttachmentMeta[] | undefined): string {
  if (!Array.isArray(list) || !list.length) return '';
  return `<div class="msg-attachments">${list.map((item) => attachmentChipMarkup(item, false)).join('')}</div>`;
}

function attachmentChipMarkup(item: AttachmentMeta | PendingAttachment, removable: boolean): string {
  const kind = item.kind || kindFromName(item.name, item.mime);
  const isImage = kind === 'image' || kind === 'imageInline';
  const thumb = item.thumbUrl
    ? `<img class="attach-thumb" alt="" src="${escapeHtml(item.thumbUrl)}">`
    : `<span class="attach-thumb file">${isImage ? '🖼' : '📄'}</span>`;
  const remove = removable
    ? `<button type="button" class="ghost small icon attach-remove" data-attach-id="${escapeHtml(item.id)}" title="${escapeHtml(t('attach.remove'))}" aria-label="${escapeHtml(t('attach.removeNamed', { name: item.name }))}">✕</button>`
    : '';
  return `<div class="attach-chip" data-attach-id="${escapeHtml(item.id || '')}">${thumb}<span class="attach-meta"><span class="attach-name" title="${escapeHtml(item.name || '')}">${escapeHtml(item.name || t('attach.unnamed'))}</span><span class="attach-size">${escapeHtml(formatBytes(item.size))}</span></span>${remove}</div>`;
}

function hydrateAttachmentThumbs(root: HTMLElement | null, list: Array<AttachmentMeta | PendingAttachment> | undefined): void {
  if (!root || !Array.isArray(list)) return;
  for (const raw of list) {
    const item = normalizeAttachment(raw);
    if (!item.id) continue;
    const img = root.querySelector(`.attach-chip[data-attach-id="${cssEscape(item.id)}"] img.attach-thumb`);
    if (img && img.getAttribute('src')) continue;
    loadAttachmentThumb(item).then((url) => {
      if (!url) return;
      const chip = root.querySelector(`.attach-chip[data-attach-id="${cssEscape(item.id)}"]`);
      if (!chip) return;
      const current = chip.querySelector('.attach-thumb');
      const next = document.createElement('img');
      next.className = 'attach-thumb';
      next.alt = '';
      next.src = url;
      if (current) current.replaceWith(next);
    }).catch(() => {});
  }
}

function renderAgentMessage(el: HTMLElement, m: ChatMessage): void {
  const agreed = Marker.hasMarker(m.text || '', 'AGREED');
  const text = Marker.stripMarker(m.text || '', 'AGREED');
  const status = m.status === 'running' ? `<span class="spinner" title="${escapeHtml(t('msg.generating'))}"></span>` : '';
  const shell = ensureAgentShell(el);
  shell.avatar.style.background = m.color || '#6c8cff';
  setTextIfChanged(shell.avatar, initials(m.agentName));
  shell.bubble.style.setProperty('--c', m.color || '#6c8cff');
  setHtmlIfChanged(shell.head, `<span class="avatar head-avatar" style="background:${escapeHtml(m.color || '#6c8cff')}">${escapeHtml(initials(m.agentName))}</span><b>${escapeHtml(m.agentName)}</b><span class="badge">${escapeHtml(cliLabel(cliTypes[m.cli || ''], m.cli || ''))}${m.model ? ' · ' + escapeHtml(m.model) : ''}</span>${phaseText(m.phase) ? `<span class="badge phase-badge">${escapeHtml(phaseText(m.phase))}</span>` : ''}${agreed ? `<span class="badge agreed">${escapeHtml(t('msg.agreed'))}</span>` : ''}${m.unreviewed ? `<span class="badge unreviewed" title="${escapeHtml(t('review.unreviewedTitle'))}">${escapeHtml(t('review.unreviewed'))}</span>` : ''}${status}`);
  renderThinking(shell.thinking, m.thinking || '');
  renderActivities(shell.activities, m.activities || []);
  // 回合結束卻沒有任何內容時,以前留下一個完全空白的泡泡——使用者無從判斷是
  // 成員沒話說、還是出了什麼事。討論與總結階段都會這樣收尾,必須講出來。
  const body = text
    ? md(text)
    : m.status === 'running' ? '<span class="hint">…</span>'
      : m.error ? '' : `<span class="hint">${escapeHtml(t('msg.emptyReply'))}</span>`;
  if (!hasSelectionInside(shell.body)) setHtmlIfChanged(shell.body, body);
  shell.error.hidden = !m.error;
  setTextIfChanged(shell.error, m.error ? `⚠ ${m.error}` : '');
  if (shell.unreviewed) {
    shell.unreviewed.hidden = !m.unreviewed;
    if (m.unreviewed && !shell.unreviewed.dataset.built) {
      shell.unreviewed.dataset.built = '1';
      shell.unreviewed.textContent = '';
      const text = document.createElement('span');
      text.textContent = t('review.unreviewedHint');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'unreviewed-open';
      open.textContent = t('diff.open');
      // 提示講「開啟上方的檔案改動」,那就讓它直接可按,不要只是敘述。
      open.onclick = () => { void openDiff(); };
      shell.unreviewed.append(text, open);
    }
  }
  const usage = usageText(m.usage);
  shell.usage.hidden = !usage;
  setTextIfChanged(shell.usage, usage);
  setTextIfChanged(shell.statusLine, t('msg.streaming'));
}

function ensureAgentShell(el: HTMLElement): AgentShell {
  if (el.dataset.shell !== 'agent') {
    el.textContent = '';
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const head = document.createElement('div');
    head.className = 'bubble-head';
    const thinking = document.createElement('div');
    thinking.className = 'thinking-slot';
    const activities = document.createElement('div');
    activities.className = 'activities';
    const body = document.createElement('div');
    body.className = 'body';
    const error = document.createElement('div');
    error.className = 'error-text';
    // 「沒有人審查過這次改動」是這個產品最不希望被忽略的訊號,不能只靠標頭一個小徽章。
    const unreviewed = document.createElement('div');
    unreviewed.className = 'unreviewed-note';
    unreviewed.hidden = true;
    const usage = document.createElement('div');
    usage.className = 'usage';
    const statusLine = document.createElement('div');
    statusLine.className = 'bubble-status';
    statusLine.textContent = t('msg.streaming');
    bubble.append(head, thinking, activities, body, error, unreviewed, usage, statusLine);
    el.append(avatar, bubble);
    el.dataset.shell = 'agent';
  } else if (!el.querySelector('.bubble-status')) {
    const statusLine = document.createElement('div');
    statusLine.className = 'bubble-status';
    statusLine.textContent = t('msg.streaming');
    el.querySelector<HTMLElement>(':scope > .bubble')!.appendChild(statusLine);
  }
  // 以上分支保證這些節點都存在,querySelector 不會落空。
  return {
    avatar: el.querySelector<HTMLElement>(':scope > .avatar')!,
    bubble: el.querySelector<HTMLElement>(':scope > .bubble')!,
    head: el.querySelector<CachedEl>('.bubble-head')!,
    thinking: el.querySelector<HTMLElement>('.thinking-slot')!,
    activities: el.querySelector<HTMLElement>('.activities')!,
    body: el.querySelector<CachedEl>('.body')!,
    error: el.querySelector<CachedEl>('.error-text')!,
    unreviewed: el.querySelector<HTMLElement>('.unreviewed-note'),
    usage: el.querySelector<CachedEl>('.usage')!,
    statusLine: el.querySelector<CachedEl>('.bubble-status')!,
  };
}

function renderThinking(slot: HTMLElement, thinking: string): void {
  slot.hidden = !thinking;
  if (!thinking) return;
  let details = slot.querySelector('details.thinking');
  if (!details) {
    details = document.createElement('details');
    details.className = 'thinking';
    const summary = document.createElement('summary');
    summary.textContent = t('msg.thinking');
    const content = document.createElement('div');
    content.className = 'content';
    details.append(summary, content);
    slot.appendChild(details);
  }
  setTextIfChanged(details.querySelector<CachedEl>('.content')!, thinking);
}

function renderActivities(slot: HTMLElement, activities: Activity[]): void {
  slot.hidden = activities.length === 0;
  const seen = new Set();
  for (const activity of activities) {
    const id = String(activity.id || activity.title || seen.size);
    seen.add(id);
    let details = [...slot.children].find((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.actId === id);
    if (!details) {
      details = document.createElement('details');
      details.dataset.actId = id;
      const summary = document.createElement('summary');
      const pre = document.createElement('pre');
      details.append(summary, pre);
      slot.appendChild(details);
    }
    details.className = `act ${activity.kind === 'note' ? 'note' : ''} ${activity.status || ''}`;
    setHtmlIfChanged(details.querySelector<CachedEl>('summary')!, `<span class="dot"></span>${escapeHtml(activity.title || t('msg.tool'))}`);
    const detail = [activity.detail, activity.result ? `${t('msg.result')}\n` + activity.result : ''].filter(Boolean).join('\n');
    const pre = details.querySelector<CachedEl & HTMLPreElement>('pre')!;
    pre.hidden = !detail;
    setTextIfChanged(pre, detail);
  }
  for (const child of [...slot.children]) {
    if (!(child instanceof HTMLElement) || !seen.has(child.dataset.actId || '')) child.remove();
  }
}

function setHtmlIfChanged(el: CachedEl, html: string): void {
  if (el._lastHtml === html) return;
  el.innerHTML = html;
  el._lastHtml = html;
}
function setTextIfChanged(el: CachedEl, text: string): void {
  if (el._lastText === text) return;
  el.textContent = text;
  el._lastText = text;
}
function hasSelectionInside(el: HTMLElement): boolean {
  const sel = window.getSelection && window.getSelection();
  return !!(sel && !sel.isCollapsed && el.contains(sel.anchorNode) && el.contains(sel.focusNode));
}
function rawValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value == null || typeof value !== 'object') return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function rawUsageText(u: UsageInfo | null | undefined): string {
  const raw = u && u.raw && typeof u.raw === 'object' ? u.raw : u;
  const fields = raw && typeof raw === 'object'
    ? Object.entries(raw).filter(([key]) => !['shape', 'raw'].includes(key)).map(([key, value]) => `${key}=${rawValue(value)}`)
    : [];
  return fields.length ? t('usage.raw', { fields: fields.join(' · ') }) : t('usage.rawEmpty');
}

function usageText(u: UsageInfo | null | undefined): string {
  if (!u) return '';
  if (!u.shape || u.shape === 'unknown') return rawUsageText(u);
  const parts = [];
  if (hasNumber(u.inputTokens)) {
    const detail = [];
    if (hasNumber(u.cachedInputTokens)) detail.push(t('usage.cached', { n: fmt(numeric(u.cachedInputTokens)) }));
    if (hasNumber(u.cacheWriteTokens)) detail.push(t('usage.cacheWrite', { n: fmt(numeric(u.cacheWriteTokens)) }));
    parts.push(`${t('usage.input', { n: fmt(numeric(u.inputTokens)) })}${detail.length ? `（${joinNames(detail)}）` : ''}`);
  } else {
    if (hasNumber(u.cachedInputTokens)) parts.push(t('usage.cachedInput', { n: fmt(numeric(u.cachedInputTokens)) }));
    if (hasNumber(u.cacheWriteTokens)) parts.push(t('usage.cacheWrite', { n: fmt(numeric(u.cacheWriteTokens)) }));
  }
  if (hasNumber(u.outputTokens)) parts.push(t('usage.output', { n: fmt(numeric(u.outputTokens)) }));
  if (hasNumber(u.costUsd)) parts.push(`$${numeric(u.costUsd).toFixed(3)}`);
  return parts.join(' · ');
}

function numeric(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
function hasNumber(value: unknown): boolean { return value != null && Number.isFinite(Number(value)); }

function emptyMetric(): Metric { return { total: 0, turns: 0, agents: new Set<string>() }; }
function addMetric(metric: Metric, value: unknown, agent: string): void {
  if (!hasNumber(value)) return;
  metric.total += numeric(value);
  metric.turns++;
  metric.agents.add(agent);
}

function updateUsageTotal() {
  const metrics: Record<string, Metric> = {
    inputTokens: emptyMetric(),
    cachedInputTokens: emptyMetric(),
    cacheWriteTokens: emptyMetric(),
    outputTokens: emptyMetric(),
    costUsd: emptyMetric(),
  };
  const usageAgents = new Set();
  let usageTurns = 0;
  let unknownTurns = 0;
  for (const message of messageData.values()) {
    const usage = message && message.usage;
    if (!usage) continue;
    const agent = message.agentId || message.agentName || t('usage.unknownAgent');
    usageTurns++;
    usageAgents.add(agent);
    if (!usage.shape || usage.shape === 'unknown') { unknownTurns++; continue; }
    for (const key of Object.keys(metrics)) addMetric(metrics[key], usage[key], agent);
  }
  const compact = [];
  if (metrics.inputTokens.turns) {
    const detail = [];
    if (metrics.cachedInputTokens.turns) detail.push(t('usage.cached', { n: fmt(metrics.cachedInputTokens.total) }));
    if (metrics.cacheWriteTokens.turns) detail.push(t('usage.cacheWrite', { n: fmt(metrics.cacheWriteTokens.total) }));
    compact.push(`${t('usage.input', { n: fmt(metrics.inputTokens.total) })}${detail.length ? `（${joinNames(detail)}）` : ''}`);
  } else {
    if (metrics.cachedInputTokens.turns) compact.push(t('usage.cachedInput', { n: fmt(metrics.cachedInputTokens.total) }));
    if (metrics.cacheWriteTokens.turns) compact.push(t('usage.cacheWrite', { n: fmt(metrics.cacheWriteTokens.total) }));
  }
  if (metrics.outputTokens.turns) compact.push(t('usage.output', { n: fmt(metrics.outputTokens.total) }));
  if (metrics.costUsd.turns) compact.push(`$${metrics.costUsd.total.toFixed(3)}`, t('usage.costCoverage', { a: metrics.costUsd.turns, b: usageTurns }));
  if (unknownTurns) compact.push(t('usage.unknownTurns', { n: unknownTurns }));

  const details = [];
  for (const [key, metric] of Object.entries(metrics)) {
    if (!metric.turns) continue;
    const total = key === 'costUsd' ? `$${metric.total.toFixed(6)}` : exactNumber(metric.total);
    details.push(t('usage.detail', { label: t(`usage.label.${key}`), total, a: metric.agents.size, b: usageAgents.size, c: metric.turns, d: usageTurns }));
  }
  if (unknownTurns) details.push(t('usage.unknownDetail', { a: unknownTurns, b: usageTurns }));
  const el = $<HTMLDivElement>('#usage-total');
  el.hidden = compact.length === 0;
  el.textContent = compact.join(' · ');
  el.title = details.join('\n');
  $<HTMLButtonElement>('#export-btn').disabled = exporting || messageData.size === 0;
}

async function exportConversation() {
  const button = $<HTMLButtonElement>('#export-btn');
  if (exporting) return;
  exporting = true;
  button.disabled = true;
  try {
    const result = await window.api.exportChat();
    if (result && result.error) alert(t('export.failed', { reason: result.error }));
  } catch (error) {
    alert(t('export.failed', { reason: cleanIpcError(error) }));
  } finally {
    exporting = false;
    updateUsageTotal();
  }
}

// ---------- Composer 附件 ----------
function attachmentsApi(): RendererApi['attachments'] | null {
  return (window.api && window.api.attachments) || null;
}

function applyAttachLimits(limits: unknown): void {
  if (!limits || typeof limits !== 'object') return;
  const raw = limits as Partial<AttachLimits>;
  const maxFiles = Number(raw.maxFiles);
  const maxFileBytes = Number(raw.maxFileBytes);
  const maxTotalBytes = Number(raw.maxTotalBytes);
  if (Number.isFinite(maxFiles) && maxFiles > 0) attachLimits.maxFiles = maxFiles;
  if (Number.isFinite(maxFileBytes) && maxFileBytes > 0) attachLimits.maxFileBytes = maxFileBytes;
  if (Number.isFinite(maxTotalBytes) && maxTotalBytes > 0) attachLimits.maxTotalBytes = maxTotalBytes;
}

function setupComposerAttachments() {
  const box = document.querySelector<HTMLElement>('.composer-box');
  const bar = document.querySelector<HTMLElement>('.composer-bar');
  if (!box || !bar || $<HTMLButtonElement>('#attach-btn')) return;

  const hint = document.createElement('div');
  hint.className = 'composer-drop-hint';
  hint.textContent = t('composer.dropHint');
  box.prepend(hint);

  const chips = document.createElement('div');
  chips.id = 'attach-chips';
  chips.className = 'attach-chips';
  chips.setAttribute('aria-live', 'polite');
  const error = document.createElement('div');
  error.id = 'attach-error';
  error.className = 'attach-error';
  error.setAttribute('role', 'alert');
  const input = $<HTMLTextAreaElement>('#input');
  input.after(chips);
  chips.after(error);

  const button = document.createElement('button');
  button.id = 'attach-btn';
  button.type = 'button';
  button.className = 'ghost small icon';
  button.title = t('composer.attach');
  button.setAttribute('aria-label', t('composer.attach'));
  button.textContent = '📎';
  button.onclick = () => pickAttachments();
  bar.insertBefore(button, bar.querySelector<HTMLElement>('.spacer'));

  const api = attachmentsApi();
  if (!api || typeof api.pick !== 'function') {
    const fileInput = document.createElement('input');
    fileInput.id = 'attach-input';
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.hidden = true;
    fileInput.accept = '.png,.jpg,.jpeg,.webp,.gif,.txt,.md,.json,.csv,.log,.pdf';
    fileInput.addEventListener('change', async () => {
      await addAttachmentFiles(fileInput.files);
      fileInput.value = '';
    });
    box.appendChild(fileInput);
  }

  box.addEventListener('dragenter', (event) => { if (isFileDrag(event)) { event.preventDefault(); box.classList.add('dragover'); } });
  box.addEventListener('dragover', (event) => { if (isFileDrag(event)) { event.preventDefault(); box.classList.add('dragover'); } });
  box.addEventListener('dragleave', (event) => { if (!(event.relatedTarget instanceof Node) || !box.contains(event.relatedTarget)) box.classList.remove('dragover'); });
  box.addEventListener('drop', async (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    box.classList.remove('dragover');
    await addAttachmentFiles(event.dataTransfer?.files);
  });
  syncPendingAttachments();
}

function isFileDrag(event: DragEvent): boolean {
  return !!(event.dataTransfer && [...event.dataTransfer.types].includes('Files'));
}

async function syncPendingAttachments() {
  const api = attachmentsApi();
  if (!api || typeof api.list !== 'function') return;
  try {
    applyPendingFromResult(await api.list(), { keepError: true });
  } catch {}
}

async function pickAttachments() {
  const api = attachmentsApi();
  if (api && typeof api.pick === 'function') {
    try {
      applyPendingFromResult(await api.pick());
    } catch (error) {
      showAttachError(formatAttachError('', cleanIpcError(error)));
    }
    return;
  }
  const input = $<HTMLInputElement>('#attach-input');
  if (input) input.click();
}

function applyPendingFromResult(result: AttachmentsResult | null | undefined, { keepError = false }: { keepError?: boolean } = {}): void {
  if (!result) return;
  applyAttachLimits(result.limits);
  if (Array.isArray(result.attachments)) {
    pendingAttachments.splice(0, pendingAttachments.length, ...result.attachments.map((item) => normalizeAttachment(item)));
  } else if (Array.isArray(result.added)) {
    for (const item of result.added) pendingAttachments.push(normalizeAttachment(item));
  }
  renderAttachChips();
  if (result.canceled) return;
  const errors = Array.isArray(result.errors) ? result.errors : [];
  if (errors.length) {
    showAttachError(formatAttachResultError(errors[0]));
  } else if (!keepError) {
    clearAttachError();
  }
}

async function addAttachmentFiles(fileList: FileList | null | undefined): Promise<void> {
  const files = [...(fileList || [])].filter(Boolean);
  if (!files.length) return;
  const api = attachmentsApi();
  if (api && typeof api.add === 'function') {
    try {
      const items = [];
      for (const file of files) {
        items.push(await fileToAddItem(file, api));
      }
      applyPendingFromResult(await api.add(items));
    } catch (error) {
      const names = files.map((file) => file && file.name).filter(Boolean);
      showAttachError(formatAttachError(names[0] || '', cleanIpcError(error)));
    }
    return;
  }
  const errors = [];
  let total = pendingAttachments.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
  for (const file of files) {
    const name = file.name || t('attach.unnamedFile');
    const ext = extensionOf(name);
    const size = Number(file.size) || 0;
    if (pendingAttachments.length >= attachLimits.maxFiles) {
      errors.push(formatAttachError(name, t('attach.tooMany', { n: attachLimits.maxFiles })));
      continue;
    }
    if (!ATTACH_EXTS.has(ext)) {
      errors.push(formatAttachError(name, t('attach.unsupported')));
      continue;
    }
    if (size > attachLimits.maxFileBytes) {
      errors.push(formatAttachError(name, t('attach.tooLarge', { size: formatBytes(attachLimits.maxFileBytes) })));
      continue;
    }
    if (total + size > attachLimits.maxTotalBytes) {
      errors.push(formatAttachError(name, t('attach.totalTooLarge', { size: formatBytes(attachLimits.maxTotalBytes) })));
      continue;
    }
    const mismatch = mimeConflictsWithName(name, file.type);
    if (mismatch) {
      errors.push(formatAttachError(name, mismatch));
      continue;
    }
    try {
      const added = await storeAttachmentStub(file);
      pendingAttachments.push(added);
      total += added.size || size;
    } catch (error) {
      errors.push(formatAttachError(name, cleanIpcError(error)));
    }
  }
  renderAttachChips();
  if (errors.length) showAttachError(errors[0]);
  else clearAttachError();
}

async function fileToAddItem(file: File, api: RendererApi['attachments']): Promise<AttachmentInput> {
  const name = file.name || t('attach.unnamed');
  const filePath = typeof api.pathForFile === 'function' ? String(api.pathForFile(file) || '') : '';
  if (filePath) return { name, path: filePath };
  const data = await file.arrayBuffer();
  return { name, data };
}

async function storeAttachmentStub(file: File): Promise<PendingAttachment> {
  const id = (crypto.randomUUID && crypto.randomUUID()) || `att-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const item = normalizeAttachment({
    id,
    name: file.name,
    mime: file.type || mimeFromName(file.name),
    size: file.size,
    kind: kindFromName(file.name, file.type),
    file,
  }, file);
  if (item.kind === 'image' && file instanceof Blob) item.thumbUrl = await readFileDataUrl(file);
  return item;
}

function normalizeAttachment(item: Partial<PendingAttachment> & { type?: string } | null | undefined, file?: File): PendingAttachment {
  const src = item || {};
  const name = src.name || (file && file.name) || t('attach.unnamed');
  const mime = src.mime || src.type || (file && file.type) || mimeFromName(name);
  const kind = src.kind || kindFromName(name, mime);
  return {
    id: src.id || '',
    name,
    mime,
    size: Number(src.size != null ? src.size : file && file.size) || 0,
    kind,
    path: src.path || null,
    relPath: src.relPath || null,
    thumb: src.thumb || null,
    thumbUrl: src.thumbUrl || null,
    file: src.file || file || null,
  };
}

function renderAttachChips() {
  const row = $<HTMLDivElement>('#attach-chips');
  const button = $<HTMLButtonElement>('#attach-btn');
  if (!row) return;
  row.innerHTML = pendingAttachments.map((item) => attachmentChipMarkup(item, true)).join('');
  row.querySelectorAll<HTMLButtonElement>('.attach-remove').forEach((btn) => {
    btn.onclick = () => { void removePendingAttachment(btn.dataset.attachId); };
  });
  if (button) button.disabled = pendingAttachments.length >= attachLimits.maxFiles;
  hydrateAttachmentThumbs(row, pendingAttachments);
  updateComposerHint();
}

async function removePendingAttachment(id: string | undefined): Promise<void> {
  const index = pendingAttachments.findIndex((item) => item.id === id);
  if (index < 0) return;
  const [item] = pendingAttachments.splice(index, 1);
  await forgetAttachments([item]);
  renderAttachChips();
  clearAttachError();
}

async function clearPendingAttachments() {
  const items = pendingAttachments.splice(0, pendingAttachments.length);
  await forgetAttachments(items);
  renderAttachChips();
  clearAttachError();
}

function revokeThumbUrls(items: PendingAttachment[] | undefined): void {
  for (const item of items || []) {
    if (item.thumbUrl && String(item.thumbUrl).startsWith('blob:')) URL.revokeObjectURL(item.thumbUrl);
  }
}

async function forgetAttachments(items: PendingAttachment[] | undefined): Promise<void> {
  revokeThumbUrls(items);
  const api = attachmentsApi();
  if (!api || typeof api.remove !== 'function') return;
  for (const item of items || []) {
    if (!item.id) continue;
    try { await api.remove(item.id); } catch {}
  }
}

async function loadAttachmentThumb(item: AttachmentMeta | PendingAttachment | null): Promise<string> {
  if (!item) return '';
  if (item.thumbUrl) return item.thumbUrl;
  const kind = item.kind || kindFromName(item.name, item.mime);
  if (kind !== 'image' && kind !== 'imageInline') return '';
  const api = attachmentsApi();
  if (api && typeof api.thumb === 'function' && (item.relPath || item.thumb || item.id)) {
    return (await api.thumb(item)) || '';
  }
  if (item.file instanceof Blob) return readFileDataUrl(item.file);
  return '';
}

function formatAttachResultError(entry: string | { name?: string; error?: string; message?: string } | null | undefined): string {
  if (entry == null) return formatAttachError('', '');
  if (typeof entry === 'string') return formatAttachError('', entry);
  return formatAttachError(entry.name || '', entry.error || entry.message || '');
}

function formatAttachError(name: string, reason: string): string {
  const file = String(name || '').trim();
  let detail = String(reason || '').trim();
  detail = detail.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const prefix = t('attach.cannotPrefix');
  if (file && (detail.includes(`「${file}」`) || detail.includes(`"${file}"`) || detail.startsWith(prefix))) return detail;
  if (file && detail) return t('attach.cannotReason', { name: file, reason: detail.replace(/^[:：,，]\s*/, '') });
  if (file) return t('attach.cannot', { name: file });
  if (detail) return detail.startsWith(prefix) ? detail : t('attach.cannotFile', { reason: detail });
  return t('attach.unknown');
}

function mimeConflictsWithName(name: string, mime: string): string {
  const type = String(mime || '').toLowerCase();
  if (!type || type === 'application/octet-stream') return '';
  const ext = extensionOf(name);
  if (!ATTACH_EXTS.has(ext)) return '';
  if (ATTACH_IMAGE_EXTS.has(ext)) {
    const expected = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : mimeFromName(name);
    return type === expected ? '' : t('attach.mismatch', { ext: ext.toUpperCase() });
  }
  if (ext === 'pdf') return type === 'application/pdf' ? '' : t('attach.mismatch', { ext: 'PDF' });
  if (type.startsWith('image/') || type === 'application/pdf' || /executable|zip|octet/.test(type)) {
    return t('attach.mismatch', { ext: ext.toUpperCase() });
  }
  return '';
}

function showAttachError(message: string): void {
  const el = $<HTMLDivElement>('#attach-error');
  if (!el) return;
  el.textContent = message;
}

function clearAttachError() {
  const el = $<HTMLDivElement>('#attach-error');
  if (el) el.textContent = '';
}

function extensionOf(name: string | undefined): string {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function kindFromName(name: string | undefined, mime?: string | null): string {
  const ext = extensionOf(name);
  if (ATTACH_IMAGE_EXTS.has(ext) || (mime && String(mime).startsWith('image/'))) return 'image';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  return 'text';
}

function mimeFromName(name: string | undefined): string {
  const ext = extensionOf(name);
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'json') return 'application/json';
  if (ext === 'csv') return 'text/csv';
  if (ext === 'md') return 'text/markdown';
  return 'text/plain';
}

function formatBytes(value: number | undefined): string {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function readFileDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error(t('attach.previewFailed')));
    reader.readAsDataURL(file);
  });
}

function cssEscape(value: string): string {
  if (window.CSS && CSS.escape) return CSS.escape(String(value));
  return String(value).replace(/"/g, '\\"');
}

// ---------- 小工具 ----------
function fmt(n: number): string { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
function exactNumber(n: number): string { return Number(n).toLocaleString(localeTag(), { maximumFractionDigits: 20 }); }
// 只留最後兩層,例如 /Users/me/projects/app → …/projects/app
function shortPath(p: string): string {
  const parts = String(p).replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : String(p);
}
function initials(name: string | undefined): string { return (name || '?').trim().slice(0, 1).toUpperCase(); }
function escapeHtml(s: unknown): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s ?? '').replace(/[&<>"']/g, (c) => map[c]);
}
function randomColor(): string { const c = ['#6c8cff', '#d97757', '#10a37f', '#c678dd', '#e5c07b', '#56b6c2', '#ff6b9d']; return c[Math.floor(Math.random() * c.length)]; }

init();
