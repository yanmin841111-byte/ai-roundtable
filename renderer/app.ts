// Renderer 主程式。由 esbuild 打包成單一 IIFE(見 package.json 的 build:renderer)。
// shared / model-rules 以往靠 UMD 掛在 window 上,改成 import 後由 bundler inline 進來。
import { marked } from 'marked';
import * as Marker from '../src/shared';
import * as ModelRules from '../src/model-rules';
import type { Model } from '../src/model-rules';
import { isPhaseInfo } from '../src/ipc-types';
import type { PhaseValue } from '../src/ipc-types';
import type {
  AgentConfig, AppConfig, AttachLimits, AttachmentInput, CliType, CliStatus,
  ExtEntry, ExtSummary, ExtTemplate, ChatMessage, ChatState, ExtSpec, AttachmentMeta,
  AttachmentsResult, RendererApi,
  PendingAttachment, SessionSummary, SessionDetail, UsageInfo, Activity,
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
  usage: CachedEl;
  statusLine: CachedEl;
}

// setHtmlIfChanged / setTextIfChanged 把上次寫入的內容記在節點上,省掉重複的 DOM 寫入。
type CachedEl = HTMLElement & { _lastHtml?: string; _lastText?: string };

// updateUsageTotal 的累計欄位。
interface Metric { total: number; turns: number; agents: Set<string> }

let config: AppConfig = null as unknown as AppConfig;
let cliTypes: Record<string, CliType> = {};
let cliStatus: Record<string, CliStatus> = {};
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
const historyErrors = new Map<string, string>();
const mentionMenu: { open: boolean; start: number; items: AgentConfig[]; index: number } =
  { open: false, start: 0, items: [], index: 0 };

marked.setOptions({ breaks: true, gfm: true });


// ---------- 初始化 ----------
async function init() {
  [config, cliTypes, extSummary] = await Promise.all([window.api.getConfig(), window.api.cliTypes(), window.api.ext.list()]);
  applyAppearance();
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
  $<HTMLButtonElement>('#reset-btn').onclick = () => { if (!running || confirm('目前仍在進行中,確定要停止並清空對話?')) window.api.reset(); };
  $<HTMLButtonElement>('#export-btn').onclick = exportConversation;
  $<HTMLButtonElement>('#sessions-btn').onclick = () => window.api.openSessions();
  $<HTMLButtonElement>('#settings-btn').onclick = () => openSettings();
  $<HTMLButtonElement>('#cli-summary').onclick = () => openSettings('clis');
  $<HTMLButtonElement>('#settings-close').onclick = closeSettings;
  document.querySelectorAll<HTMLElement>('.settings-tab').forEach((tab) => { tab.onclick = () => showSettingsTab(tab.dataset.tab || ''); });
  $<HTMLButtonElement>('#workdir-chip').onclick = pickWorkDir;
  // 點背景關閉只用在沒有編輯內容的視窗,避免誤點丟掉未儲存的成員或擴充設定
  for (const id of ['#settings', '#history-modal', '#ext-picker']) {
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
  document.querySelectorAll<HTMLInputElement>('input[name="theme"], input[name="font-size"]').forEach((el) => el.addEventListener('change', saveAppearance));
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
const SETTINGS_TITLES: Record<string, string> = { general: '一般', clis: 'CLI 與擴充', appearance: '外觀', data: '資料與紀錄' };

function openSettings(tab = 'general'): void {
  renderSidebar();
  showSettingsTab(tab);
  $('#settings-saved').hidden = true;
  $<HTMLDivElement>('#settings').classList.remove('hidden');
}

function closeSettings() { $<HTMLDivElement>('#settings').classList.add('hidden'); }

function showSettingsTab(tab: string): void {
  document.querySelectorAll<HTMLElement>('.settings-tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll<HTMLElement>('.settings-page').forEach((el) => { el.hidden = el.dataset.page !== tab; });
  $('#settings-title').textContent = SETTINGS_TITLES[tab] || '設定';
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
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty('--font-size', `${fontSize}px`);
  const themeInput = document.querySelector<HTMLInputElement>(`input[name="theme"][value="${theme}"]`);
  if (themeInput) themeInput.checked = true;
  const sizeInput = document.querySelector<HTMLInputElement>(`input[name="font-size"][value="${fontSize}"]`);
  if (sizeInput) sizeInput.checked = true;
}

function saveAppearance() {
  const theme = document.querySelector<HTMLInputElement>('input[name="theme"]:checked');
  const size = document.querySelector<HTMLInputElement>('input[name="font-size"]:checked');
  if (theme) config.settings.theme = theme.value;
  if (size) config.settings.fontSize = Number(size.value);
  applyAppearance();
  window.api.saveConfig(config);
  flashSaved();
}

function clearTimeline() {
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
  d.innerHTML = '<div class="empty-icon">◎</div><div class="empty-title">把任務丟給圓桌</div><div class="empty-sub">成員會輪流討論、達成共識後由主持人分工,各自在工作目錄執行,最後互相審查。</div><div class="empty-steps"><span>① 討論</span><span class="arrow">→</span><span>② 分工執行</span><span class="arrow">→</span><span>③ 交叉審查</span></div>';
  return d;
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
  if (!quiet) $<HTMLDivElement>('#history-list').innerHTML = '<div class="history-empty">載入中…</div>';
  try {
    const result = await window.api.sessions.list();
    historySessions = Array.isArray(result && result.sessions) ? result.sessions! : [];
    historyLoaded = true;
    historyErrors.clear();
    if (result && result.error) setHistoryError(result.error);
    renderHistoryList();
  } catch (error) {
    setHistoryError(`無法讀取歷史紀錄:${cleanIpcError(error)}`);
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
    empty.textContent = '尚無歷史紀錄';
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
    title.textContent = session.title || '未命名對話';
    if (active) main.setAttribute('aria-current', 'true');
    const meta = document.createElement('span');
    meta.className = 'history-meta';
    const details = [formatHistoryTime(session.createdAt), `${Number(session.messageCount) || 0} 則`];
    if (Array.isArray(session.agents) && session.agents.length) details.push(session.agents.join('、'));
    meta.textContent = details.filter(Boolean).join(' · ');
    main.append(title, meta);
    main.onclick = () => openHistory(session);
    const remove = document.createElement('button');
    remove.className = 'history-delete';
    remove.title = '刪除歷史紀錄';
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
    if (!result || !result.ok || !result.session) throw new Error((result && result.error) || '紀錄不存在或無法讀取');
    const session = result.session;
    openHistoryId = summary.id;
    $('#history-modal-title').textContent = session.title || summary.title || '歷史對話';
    const meta = [formatHistoryTime(session.createdAt), ...(session.agents || []), `${(session.messages || []).length} 則訊息`];
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
    const who = message.kind === 'user' ? '使用者' : message.kind === 'agent' ? (message.agentName || 'AI 成員') : '系統';
    head.textContent = [who, message.phase, message.model, formatHistoryTime(message.ts)].filter(Boolean).join(' · ');
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
  if (!list.length) preview.innerHTML = '<div class="history-empty">這筆紀錄沒有訊息</div>';
}

async function removeHistory(session: SessionSummary): Promise<void> {
  const when = formatHistoryTime(session.createdAt);
  if (!confirm(`確定刪除歷史對話「${session.title || '未命名對話'}」${when ? `\n${when}` : ''}?`)) return;
  historyErrors.delete(session.id);
  try {
    const result = await window.api.sessions.remove(session.id);
    if (!result || !result.ok) throw new Error((result && result.error) || '刪除失敗');
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
  button.textContent = current ? '目前的對話' : '繼續這段對話';
  hint.textContent = running
    ? '目前仍在進行中,停止後才能載入其他對話。'
    : current
      ? '這段紀錄就是目前的對話,直接在下方輸入即可。'
      : '載入後可以直接接著送出訊息,成員會先讀過這段紀錄。';
}

async function resumeHistory() {
  const id = openHistoryId;
  if (!id || running) return;
  const button = $<HTMLButtonElement>('#history-resume');
  button.disabled = true;
  try {
    const result = await window.api.resume(id);
    if (!result || !result.ok) throw new Error((result && result.error) || '無法載入這段對話');
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
    $('#history-resume-hint').textContent = `無法載入:${cleanIpcError(error)}`;
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
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-TW', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZoneName: 'short',
  });
}

async function checkClis() {
  cliStatus = await window.api.checkCli();
  renderExtensions();
  renderCliSummary();
}

// 側欄底部:需要安裝檢查的 CLI 有幾個可用
function renderCliSummary() {
  const el = $<HTMLButtonElement>('#cli-summary');
  const checked = Object.values(cliTypes).filter((t) => cliStatus[t.id]);
  const broken = extSummary.entries.filter((e) => e.error).length;
  if (!checked.length) {
    el.innerHTML = '<span class="status-dot"></span><span>檢查 CLI 中…</span>';
    return;
  }
  const ok = checked.filter((t) => cliStatus[t.id].ok);
  const level = broken || ok.length === 0 ? 'bad' : ok.length < checked.length ? 'warn' : 'ok';
  const text = `${ok.length}/${checked.length} 個 CLI 可用${broken ? ` · ${broken} 個擴充載入失敗` : ''}`;
  el.innerHTML = `<span class="status-dot ${level}"></span><span>${escapeHtml(text)}</span>`;
  el.title = checked.map((t) => `${cliStatus[t.id].ok ? '●' : '○'} ${t.label}:${cliStatus[t.id].ok ? cliStatus[t.id].version : cliStatus[t.id].error}`).join('\n');
}

// ---------- CLI 與擴充 ----------
const TYPE_LABEL: Record<string, string> = { builtin: '內建', cli: 'CLI', openai: 'API', js: 'JS 外掛' };

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

function renderExtensions() {
  const list = $<HTMLDivElement>('#ext-list');
  if (!list) return;
  const rows = [];
  // 已載入的轉接器(內建 + 擴充)
  for (const t of Object.values(cliTypes)) {
    const st = cliStatus[t.id];
    const dot = `<span class="status-dot ${!st ? '' : st.ok ? 'ok' : 'bad'}"></span>`;
    const sub = st ? (st.ok ? st.version : st.error) : t.bin ? '檢查中…' : '不需檢查';
    const badges = [`<span class="badge">${TYPE_LABEL[t.type] || t.type}</span>`];
    if (!t.supportsEdit) badges.push('<span class="badge">只能討論</span>');
    const entry = extSummary.entries.find((e) => e.file === t.file);
    if (entry && entry.overrides) badges.push('<span class="badge warn">覆寫內建</span>');
    if (t.modelError) badges.push('<span class="badge warn">模型清單讀取失敗</span>');
    rows.push({ file: t.file, html: `${dot}<div class="ext-main"><div class="ext-title"><b>${escapeHtml(t.label)}</b>${badges.join('')}</div><div class="ext-sub" title="${escapeHtml(sub || '')}">${escapeHtml(sub || '')}</div>${t.modelError ? `<div class="ext-err">${escapeHtml(t.modelError)}</div>` : ''}</div>` });
  }
  // 載入失敗的擴充
  for (const e of extSummary.entries.filter((x) => x.error)) {
    rows.push({ file: e.file, broken: true, html: `<span class="status-dot bad"></span><div class="ext-main"><div class="ext-title"><b>${escapeHtml(e.file)}</b><span class="badge bad">載入失敗</span></div><div class="ext-err">${escapeHtml(e.error)}</div></div>` });
  }
  list.innerHTML = '';
  for (const r of rows) {
    const el = document.createElement('div');
    el.className = `ext-item${r.file ? ' clickable' : ''}${r.broken ? ' broken' : ''}`;
    el.innerHTML = r.html;
    if (r.file) { const file = r.file; el.title = `點擊編輯 ${file}`; el.onclick = () => { void openExtEditor(file); }; }
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
    box.innerHTML = '<div class="template-empty"><b>沒有符合的範本</b><span>試試清空搜尋,或改選「全部」。</span></div>';
    return;
  }

  const blankTemplates = templates.filter(isBlankTemplate);
  const readyTemplates = templates.filter((template) => !isBlankTemplate(template));
  appendTemplateGroup(box, '現成範本', readyTemplates);
  appendTemplateGroup(box, '從空白開始', blankTemplates);
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
  for (const t of templates) {
    const el = document.createElement('button');
    el.className = 'template';
    el.title = t.description;
    el.innerHTML = `<span class="row"><b>${escapeHtml(t.label)}</b><span class="badge">${TYPE_LABEL[t.type] || t.type}</span></span><span class="hint">${escapeHtml(t.description)}</span><span class="template-action">使用此範本 →</span>`;
    el.onclick = async () => {
      el.disabled = true;
      try {
        const { file } = await window.api.ext.install(t.file);
        $<HTMLDivElement>('#ext-picker').classList.add('hidden');
        await refreshCatalog();
        openExtEditor(file);
      } catch (e) {
        el.disabled = false;
        alert(`新增失敗:${cleanIpcError(e)}`);
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
    $('#ext-editor-title').textContent = `編輯擴充:${file}`;
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
  } catch (e) { alert(`無法開啟:${cleanIpcError(e)}`); }
}

function showExtEditorTab(tab: string): void {
  if (tab === 'basic' && editingExtFile && editingExtFile.endsWith('.js')) tab = 'advanced';
  if (tab === 'basic') {
    try {
      editingExtSpec = JSON.parse($<HTMLTextAreaElement>('#ext-content').value);
      fillExtBasic(editingExtSpec);
    } catch (e) {
      showExtResult(`JSON 格式錯誤:${(e as Error).message}`, null);
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
  $('#ext-args-help').textContent = $<HTMLTextAreaElement>('#ext-args').disabled ? '此範本含條件或參數群組，請在「進階 JSON」調整。' : '';
  $<HTMLInputElement>('#ext-base-url').value = spec.baseUrl || '';
  $<HTMLInputElement>('#ext-api-env').value = spec.apiKeyEnv || '';
  $<HTMLInputElement>('#ext-models').disabled = false;
  $<HTMLInputElement>('#ext-models').dataset.original = JSON.stringify(spec.models == null ? [] : spec.models);
  $<HTMLInputElement>('#ext-models').value = spec.models === 'auto' ? 'auto' : Array.isArray(spec.models) ? spec.models.map((model) => typeof model === 'string' ? model : model.id).filter(Boolean).join(', ') : '';
  $('#ext-models-help').textContent = Array.isArray(spec.models) && spec.models.some((model) => model && typeof model === 'object') ? '既有模型的名稱與強度設定會保留。' : '';
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
    badge.textContent = status.configured ? `已設定 ${status.hint}${status.source === 'environment' ? '(環境變數)' : ''}` : '尚未設定';
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
    showExtResult(null, '✓ 已清除「設定 → CLI 與擴充」裡填入的 API key');
  } catch (e) { showExtResult(cleanIpcError(e), null); }
}

async function testExtensionConnection() {
  const saved = await saveExtension({ quiet: true });
  if (!saved) return;
  $<HTMLButtonElement>('#ext-key-test').disabled = true;
  try {
    const result = await window.api.secrets.test(editingExtSpec?.id || '');
    showExtResult(result.ok ? null : result.error, result.ok ? `✓ ${result.version || '連線成功'}` : null);
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
    $('#ext-editor-title').textContent = `編輯擴充:${file}`;
    await refreshCatalog();
    await refreshExtensionSecretStatus();
    if (error || !quiet) showExtResult(error, error ? null : '✓ 已儲存並載入。成員編輯視窗的 CLI 選單已更新。');
    return !error;
  } catch (e) {
    showExtResult(cleanIpcError(e), null);
    return false;
  }
}

async function deleteExtension() {
  if (!editingExtFile || !confirm(`確定刪除 ${editingExtFile}?使用這個 CLI 的成員會無法發言。`)) return;
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
    el.innerHTML = `
      <div class="avatar" style="background:${a.color}">${initials(a.name)}</div>
      <div class="agent-info">
        <div class="agent-name">${escapeHtml(a.name)} ${a.id === lead ? '<span class="badge lead">主持人</span>' : ''} ${!cliTypes[a.cli] ? '<span class="badge bad">找不到 CLI</span>' : a.canEdit && cliTypes[a.cli].supportsEdit ? '' : '<span class="badge">唯讀</span>'}</div>
        <div class="agent-meta">${escapeHtml((cliTypes[a.cli] || {}).label || a.cli)} · ${escapeHtml(a.model || '預設模型')} · ${escapeHtml(a.effort || '預設強度')}</div>
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
  $('#workdir-label').textContent = workDir ? shortPath(workDir) : '未設定工作目錄';
  $<HTMLButtonElement>('#workdir-chip').title = `工作目錄:${workDir || '未設定'}(點擊更換)`;
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
  $('#modal-title').textContent = id ? '編輯成員' : '新增成員';
  const groups: Array<[string, (t: CliType) => boolean]> = [['內建', (t) => t.origin === 'builtin'], ['擴充', (t) => t.origin !== 'builtin']];
  let cliOptions = groups.map(([name, pick]) => {
    const opts = Object.values(cliTypes).filter(pick).map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)}${t.type !== 'builtin' ? `(${TYPE_LABEL[t.type] || t.type})` : ''}</option>`).join('');
    return opts ? `<optgroup label="${name}">${opts}</optgroup>` : '';
  }).join('');
  if (a.cli && !cliTypes[a.cli]) cliOptions += `<option value="${escapeHtml(a.cli)}">${escapeHtml(a.cli)}(找不到,請重新選擇)</option>`;
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
  sel.innerHTML = '<option value="">(CLI 預設模型)</option>'
    + models.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label !== m.id ? `${m.id}(${m.label})` : m.id)}</option>`).join('')
    + `<option value="${CUSTOM_MODEL}">其他(手動輸入)…</option>`;

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
  const t = cliTypes[cli];
  const supported = !t || t.supportsEdit;
  const box = $<HTMLInputElement>('#f-canEdit');
  box.disabled = !supported;
  let note = $<HTMLDivElement>('#f-canEdit-note');
  if (!note) {
    note = document.createElement('div');
    note.id = 'f-canEdit-note';
    note.className = 'field-note';
    $('#f-canEdit-wrap').after(note);
  }
  note.textContent = supported ? '' : `${t.label} 不能修改檔案,只能參與討論與審查`;
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
  const t = cliTypes[cli] || {};
  const source = t.modelSource;
  const info = findModel(cli, currentModel());
  const notes = [];
  if (info && info.description) notes.push(info.description);
  if (source === 'fallback') notes.push('(讀不到 CLI 的模型快取,顯示內建清單;先執行一次該 CLI 通常就會產生)');
  if (source === 'error') notes.push(`(模型清單讀取失敗:${t.modelError || '未知錯誤'};可以選「其他(手動輸入)」)`);
  if (source === 'loading') notes.push('(模型清單讀取中,稍後重新打開這個視窗)');
  if (t.description && t.origin !== 'builtin' && !info) notes.push(t.description);
  $<HTMLDivElement>('#f-model-desc').textContent = notes.join(' ');
  fillEfforts(cli, info, effort === undefined ? $<HTMLSelectElement>('#f-effort').value : effort);
}

function fillEfforts(cli: string, info: Model | null, wanted: string): void {
  const eff = $<HTMLSelectElement>('#f-effort');
  const t = cliTypes[cli] || {};
  const restricted = !!info && !info.unrestrictedEffort;
  // 認得且有限制的模型用它自己的強度清單;其他情況列出轉接器設定的強度與所有模型強度的聯集。
  let efforts: string[];
  if (restricted) efforts = info!.efforts || [];
  else {
    const pool = new Set([...(t.efforts || []), ...modelsOf(cli).flatMap((m) => m.efforts || [])]);
    efforts = [...ModelRules.EFFORT_RANK.filter((e) => pool.has(e)), ...[...pool].filter((e) => !ModelRules.EFFORT_RANK.includes(e))];
  }
  const unsupported = restricted && efforts.length === 0;
  eff.disabled = efforts.length === 0;
  eff.innerHTML = unsupported
    ? '<option value="">(此模型不支援強度設定)</option>'
    : efforts.length === 0
      ? '<option value="">(這個 CLI 沒有設定強度選項)</option>'
      : `<option value="">(預設${info && info.defaultEffort ? ':' + info.defaultEffort : ''})</option>` + efforts.map((e) => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join('');
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
  if (!editingId || !confirm('確定刪除這位成員?')) return;
  config.agents = config.agents.filter((x) => x.id !== editingId);
  if (config.settings.leadAgentId === editingId) config.settings.leadAgentId = null;
  window.api.saveConfig(config);
  renderSidebar();
  closeModal();
}

// ---------- 對話 ----------
const STAGE_LABEL: Record<string, string> = { discuss: '① 討論', execute: '② 分工執行', review: '③ 交叉審查', direct: '@ 指定回覆' };
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
    showAttachError(cleanIpcError(error) || '送出失敗');
  }
}

function setState(s: ChatState): void {
  running = !!s.running;
  const pill = $<HTMLDivElement>('#phase-pill');
  pill.textContent = running ? phaseText(s.phase) : PHASE_TEXT.idle;
  pill.className = 'phase ' + (running ? 'busy' : 'idle');
  $<HTMLButtonElement>('#stop-btn').disabled = !running;
  updateComposerHint();
  if (openHistoryId) updateResumeButton();
  updateSpeakingHighlight();
}

// ---------- @ 指定成員 ----------
function enabledAgents() { return (config && config.agents ? config.agents : []).filter((a) => a.enabled !== false); }

function updateComposerHint() {
  const mentioned = Marker.findMentions ? Marker.findMentions($<HTMLTextAreaElement>('#input').value, enabledAgents()) : [];
  const names = mentioned.map((a) => a.name).join('、');
  let text = '';
  if (mentioned.length && running) text = `@ 指定:${names} 會在下一次發言時看到;任務結束前沒輪到會補一次回覆`;
  else if (mentioned.length) text = `@ 指定:只有 ${names} 會回覆,不跑討論流程`;
  else if (running) text = '進行中,現在送出的訊息會在下一位成員發言時帶入';
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
  head.textContent = '指定成員';
  menu.appendChild(head);
  mentionMenu.items.forEach((agent, i) => {
    const option = document.createElement('div');
    option.className = `mention-option${i === mentionMenu.index ? ' active' : ''}`;
    option.id = `mention-option-${i}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(i === mentionMenu.index));
    const t = cliTypes[agent.cli] || {};
    option.innerHTML = `<div class="avatar" style="background:${escapeHtml(agent.color || '#6c8cff')}">${escapeHtml(initials(agent.name))}</div><div class="mention-option-main"><b>${escapeHtml(agent.name)}</b><span>${escapeHtml([t.label || agent.cli, agent.model].filter(Boolean).join(' · '))}</span></div>`;
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

// 顯示文字一律在 renderer 這側組出(第二輪換成 t('phase.*') 即可)。
const PHASE_TEXT: Record<string, string> = {
  idle: '閒置', direct: '指定', discuss: '討論', divide: '分工',
  execute: '執行', review: '交叉審查', repair: '修復', summary: '總結',
};

function phaseText(phase: PhaseValue | undefined | null): string {
  if (!phase) return '';
  if (!isPhaseInfo(phase)) return phase; // 舊 session 存的是現成字串,原樣顯示
  const label = PHASE_TEXT[phase.code] || phase.code;
  if (phase.code === 'discuss' && phase.round) {
    return phase.maxRounds ? `${label} 第 ${phase.round}/${phase.maxRounds} 回合` : `${label} R${phase.round}`;
  }
  if (phase.code === 'direct' && phase.names && phase.names.length) return `${label} ${phase.names.join('、')}`;
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
    divider.innerHTML = `<span class="tl-stage-label">${STAGE_LABEL[stage] || stage}</span>`;
    el.before(divider);
  }
  if (round && String(round) !== (prev && prev.dataset.round || '')) {
    const maxRounds = Number(config && config.settings && config.settings.maxRounds) || 0;
    const divider = document.createElement('div');
    divider.className = 'tl-round';
    divider.textContent = maxRounds ? `第 ${round} 輪 / ${maxRounds}` : `第 ${round} 輪`;
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
  return `<div class="avatar" style="background:var(--user-avatar)">我</div><div class="bubble"><div class="body">${md(m.text || '')}</div>${attachmentsMarkup(m.attachments)}</div>`;
}
function systemHtml(m: ChatMessage): string {
  return `<div class="bubble"><div class="body">${md(m.text || '')}</div></div>`;
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
    ? `<button type="button" class="ghost small icon attach-remove" data-attach-id="${escapeHtml(item.id)}" title="移除附件" aria-label="移除 ${escapeHtml(item.name)}">✕</button>`
    : '';
  return `<div class="attach-chip" data-attach-id="${escapeHtml(item.id || '')}">${thumb}<span class="attach-meta"><span class="attach-name" title="${escapeHtml(item.name || '')}">${escapeHtml(item.name || '未命名')}</span><span class="attach-size">${escapeHtml(formatBytes(item.size))}</span></span>${remove}</div>`;
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
  const status = m.status === 'running' ? '<span class="spinner" title="產生中"></span>' : '';
  const shell = ensureAgentShell(el);
  shell.avatar.style.background = m.color || '#6c8cff';
  setTextIfChanged(shell.avatar, initials(m.agentName));
  shell.bubble.style.setProperty('--c', m.color || '#6c8cff');
  setHtmlIfChanged(shell.head, `<span class="avatar head-avatar" style="background:${escapeHtml(m.color || '#6c8cff')}">${escapeHtml(initials(m.agentName))}</span><b>${escapeHtml(m.agentName)}</b><span class="badge">${escapeHtml((cliTypes[m.cli || ''] || {}).label || m.cli)}${m.model ? ' · ' + escapeHtml(m.model) : ''}</span>${phaseText(m.phase) ? `<span class="badge phase-badge">${escapeHtml(phaseText(m.phase))}</span>` : ''}${agreed ? '<span class="badge agreed">✓ 同意分工</span>' : ''}${status}`);
  renderThinking(shell.thinking, m.thinking || '');
  renderActivities(shell.activities, m.activities || []);
  const body = text ? md(text) : (m.status === 'running' ? '<span class="hint">…</span>' : '');
  if (!hasSelectionInside(shell.body)) setHtmlIfChanged(shell.body, body);
  shell.error.hidden = !m.error;
  setTextIfChanged(shell.error, m.error ? `⚠ ${m.error}` : '');
  const usage = usageText(m.usage);
  shell.usage.hidden = !usage;
  setTextIfChanged(shell.usage, usage);
  setTextIfChanged(shell.statusLine, '正在輸出…');
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
    const usage = document.createElement('div');
    usage.className = 'usage';
    const statusLine = document.createElement('div');
    statusLine.className = 'bubble-status';
    statusLine.textContent = '正在輸出…';
    bubble.append(head, thinking, activities, body, error, usage, statusLine);
    el.append(avatar, bubble);
    el.dataset.shell = 'agent';
  } else if (!el.querySelector('.bubble-status')) {
    const statusLine = document.createElement('div');
    statusLine.className = 'bubble-status';
    statusLine.textContent = '正在輸出…';
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
    summary.textContent = '💭 思考過程';
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
    setHtmlIfChanged(details.querySelector<CachedEl>('summary')!, `<span class="dot"></span>${escapeHtml(activity.title || '工具')}`);
    const detail = [activity.detail, activity.result ? '── 結果 ──\n' + activity.result : ''].filter(Boolean).join('\n');
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
  return fields.length ? `原始用量：${fields.join(' · ')}` : '原始用量（無欄位）';
}

function usageText(u: UsageInfo | null | undefined): string {
  if (!u) return '';
  if (!u.shape || u.shape === 'unknown') return rawUsageText(u);
  const parts = [];
  if (hasNumber(u.inputTokens)) {
    const detail = [];
    if (hasNumber(u.cachedInputTokens)) detail.push(`其中快取 ${fmt(numeric(u.cachedInputTokens))}`);
    if (hasNumber(u.cacheWriteTokens)) detail.push(`寫入快取 ${fmt(numeric(u.cacheWriteTokens))}`);
    parts.push(`輸入 ${fmt(numeric(u.inputTokens))}${detail.length ? `（${detail.join('、')}）` : ''}`);
  } else {
    if (hasNumber(u.cachedInputTokens)) parts.push(`快取輸入 ${fmt(numeric(u.cachedInputTokens))}`);
    if (hasNumber(u.cacheWriteTokens)) parts.push(`寫入快取 ${fmt(numeric(u.cacheWriteTokens))}`);
  }
  if (hasNumber(u.outputTokens)) parts.push(`輸出 ${fmt(numeric(u.outputTokens))}`);
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
    const agent = message.agentId || message.agentName || '未知成員';
    usageTurns++;
    usageAgents.add(agent);
    if (!usage.shape || usage.shape === 'unknown') { unknownTurns++; continue; }
    for (const key of Object.keys(metrics)) addMetric(metrics[key], usage[key], agent);
  }
  const compact = [];
  if (metrics.inputTokens.turns) {
    const detail = [];
    if (metrics.cachedInputTokens.turns) detail.push(`其中快取 ${fmt(metrics.cachedInputTokens.total)}`);
    if (metrics.cacheWriteTokens.turns) detail.push(`寫入快取 ${fmt(metrics.cacheWriteTokens.total)}`);
    compact.push(`輸入 ${fmt(metrics.inputTokens.total)}${detail.length ? `（${detail.join('、')}）` : ''}`);
  } else {
    if (metrics.cachedInputTokens.turns) compact.push(`快取輸入 ${fmt(metrics.cachedInputTokens.total)}`);
    if (metrics.cacheWriteTokens.turns) compact.push(`寫入快取 ${fmt(metrics.cacheWriteTokens.total)}`);
  }
  if (metrics.outputTokens.turns) compact.push(`輸出 ${fmt(metrics.outputTokens.total)}`);
  if (metrics.costUsd.turns) compact.push(`$${metrics.costUsd.total.toFixed(3)}`, `成本涵蓋 ${metrics.costUsd.turns}/${usageTurns} 回合`);
  if (unknownTurns) compact.push(`${unknownTurns} 則未納入`);

  const labels: Record<string, string> = { inputTokens: '輸入', cachedInputTokens: '快取輸入', cacheWriteTokens: '寫入快取', outputTokens: '輸出', costUsd: '成本' };
  const details = [];
  for (const [key, metric] of Object.entries(metrics)) {
    if (!metric.turns) continue;
    const total = key === 'costUsd' ? `$${metric.total.toFixed(6)}` : exactNumber(metric.total);
    details.push(`${labels[key]} ${total}（涵蓋 ${metric.agents.size}/${usageAgents.size} 位成員、${metric.turns}/${usageTurns} 次用量回報）`);
  }
  if (unknownTurns) details.push(`${unknownTurns}/${usageTurns} 次未知格式用量未納入總計`);
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
    if (result && result.error) alert(`匯出失敗:${result.error}`);
  } catch (error) {
    alert(`匯出失敗:${cleanIpcError(error)}`);
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
  hint.textContent = '放開以附加檔案';
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
  button.title = '附加檔案';
  button.setAttribute('aria-label', '附加檔案');
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
    const name = file.name || '未命名檔案';
    const ext = extensionOf(name);
    const size = Number(file.size) || 0;
    if (pendingAttachments.length >= attachLimits.maxFiles) {
      errors.push(formatAttachError(name, `一次最多 ${attachLimits.maxFiles} 個檔案`));
      continue;
    }
    if (!ATTACH_EXTS.has(ext)) {
      errors.push(formatAttachError(name, '不支援此類型,請改傳圖片、文字檔或 PDF'));
      continue;
    }
    if (size > attachLimits.maxFileBytes) {
      errors.push(formatAttachError(name, `單檔不能超過 ${formatBytes(attachLimits.maxFileBytes)}`));
      continue;
    }
    if (total + size > attachLimits.maxTotalBytes) {
      errors.push(formatAttachError(name, `這次附件合計不能超過 ${formatBytes(attachLimits.maxTotalBytes)}`));
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
  const name = file.name || '未命名';
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
  const name = src.name || (file && file.name) || '未命名';
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
    const result = await api.thumb(item);
    return typeof result === 'string' ? result : (result && (result.dataUrl || result.url)) || '';
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
  if (file && (detail.includes(`「${file}」`) || /^無法附加「/.test(detail))) return detail;
  if (file && detail) return `無法附加「${file}」:${detail.replace(/^[:：,，]\s*/, '')}`;
  if (file) return `無法附加「${file}」`;
  if (detail) return /^無法附加/.test(detail) ? detail : `無法附加檔案:${detail}`;
  return '無法附加檔案:發生未知錯誤';
}

function mimeConflictsWithName(name: string, mime: string): string {
  const type = String(mime || '').toLowerCase();
  if (!type || type === 'application/octet-stream') return '';
  const ext = extensionOf(name);
  if (!ATTACH_EXTS.has(ext)) return '';
  if (ATTACH_IMAGE_EXTS.has(ext)) {
    const expected = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : mimeFromName(name);
    return type === expected ? '' : `內容不是 ${ext.toUpperCase()} 格式(副檔名與實際內容不符)`;
  }
  if (ext === 'pdf') return type === 'application/pdf' ? '' : '內容不是 PDF 格式(副檔名與實際內容不符)';
  if (type.startsWith('image/') || type === 'application/pdf' || /executable|zip|octet/.test(type)) {
    return `內容不是 ${ext.toUpperCase()} 格式(副檔名與實際內容不符)`;
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
    reader.onerror = () => reject(reader.error || new Error('無法讀取預覽'));
    reader.readAsDataURL(file);
  });
}

function cssEscape(value: string): string {
  if (window.CSS && CSS.escape) return CSS.escape(String(value));
  return String(value).replace(/"/g, '\\"');
}

// ---------- 小工具 ----------
function fmt(n: number): string { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
function exactNumber(n: number): string { return Number(n).toLocaleString('zh-TW', { maximumFractionDigits: 20 }); }
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
