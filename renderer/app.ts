// Renderer 主程式。由 esbuild 打包成單一 IIFE(見 package.json 的 build:renderer)。
// shared / model-rules 以往靠 UMD 掛在 window 上,改成 import 後由 bundler inline 進來。
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import * as Marker from '../src/shared';
import * as ModelRules from '../src/model-rules';
import type { Model } from '../src/model-rules';
import { isPhaseInfo } from '../src/ipc-types';
import { t, applyStaticText, resolveLocale, setLocale, getLocale, localeTag, joinNames } from './i18n';
import { controlLabel, icon } from './icons';
import { $, fmt, exactNumber, shortPath, initials, escapeHtml, randomColor, cleanIpcError, cssEscape, bindResizeHandle } from './util';
import { openDiff, loadDiff } from './diff-view';
import { renderTaskSummary } from './task-card';
import { refreshTaskVerifications } from './task-verification';
import { setupLineups, renderLineupButton } from './lineup-menu';
import { setupTerminal, toggleTerminal, syncTerminalTheme, relocalizeTerminal } from './terminal';
import {
  setupHistory, setActiveSessionId, getActiveSessionId, isHistoryLoaded,
  refreshHistoryUI, loadHistory, renderHistoryList, updateResumeButton, closeHistoryModal,
} from './history';
import {
  pendingAttachments, setupComposerAttachments, attachmentsMarkup, hydrateAttachmentThumbs,
  syncPendingAttachments, renderAttachChips, clearPendingAttachments, revokeThumbUrls,
  showAttachError, clearAttachError,
} from './attachments';
import { setupExtensions, renderExtensions, cliLabel, typeLabel } from './extensions';
import { summarizeCosts } from '../src/usage';
import { envFixHtml, bindEnvFix, describeCliHealth, setEnvFixHandlers } from './env-fix';
import { isInstallRunning, openInstallDialog, setupInstallDialog } from './install-dialog';
import type { PhaseValue } from '../src/ipc-types';
import type {
  AgentConfig, AppConfig, AttachLimits, AttachmentInput, CliType, CliHealth,
  ExtEntry, ExtSummary, ExtTemplate, ChatMessage, ChatState, ExtSpec, AttachmentMeta, ReviewInfo, ModelCapability,
  AttachmentsResult, RendererApi, JobsState, JobSelectResult, JobSummary,
  PendingAttachment, PendingQuestion, QuestionAnswer, SessionSummary, SessionDetail, UsageInfo, Activity, EnvFix,
} from './api';

// marked v15 的 parse() 型別是 string | Promise<string>;這裡一律同步使用。
const md = (text: string): string => DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
  ALLOWED_TAGS: ['p', 'br', 'hr', 'strong', 'em', 'del', 's', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'img', 'details', 'summary'],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'start', 'colspan', 'rowspan'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(?:https?:\/\/|mailto:)/i,
});

// renderAgentMessage 用的節點集合。
interface AgentShell {
  avatar: HTMLElement;
  bubble: HTMLElement;
  head: CachedEl;
  thinking: HTMLElement;
  activities: HTMLElement;
  body: CachedEl;
  error: CachedEl;
  // 這個版本之前建立的訊息節點沒有這一格,所以允許 null
  fix: HTMLElement | null;
  // 舊的訊息節點可能還沒有這個元素,所以允許 null
  unreviewed: HTMLElement | null;
  reviewScope: HTMLElement;
  retry: HTMLButtonElement | null;
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
let editingId: string | null = null;
const msgEls = new Map<string, HTMLElement>();
const messageData = new Map<string, ChatMessage>();
let running = false;
let exporting = false;
let currentQuestion: PendingQuestion | null = null;
let jobsState: JobsState | null = null;
// 時間軸目前畫的是哪件任務;jobs:changed 會比切換的回應先到,不能拿 selectedId 判斷要不要重畫
let shownJobId: string | null = null;
let switchingJobs = false;
// 切到別的任務時,輸入框裡還沒送出的字留給原本那件
const drafts = new Map<string, string>();
let answeredQuestionId: string | null;
let questionTimer: ReturnType<typeof setInterval> | undefined;
const mentionMenu: { open: boolean; start: number; items: AgentConfig[]; index: number } =
  { open: false, start: 0, items: [], index: 0 };

marked.setOptions({ breaks: true, gfm: true });

// ---------- 初始化 ----------
async function init() {
  [config, cliTypes, extSummary] = await Promise.all([window.api.getConfig(), window.api.cliTypes(), window.api.ext.list()]);
  applyAppearance();
  applyStaticText();
  setupLineups({
    config: () => config,
    running: () => running,
    availability: () => Object.fromEntries(config.agents.map((agent) => {
      const type = cliTypes[agent.cli];
      const health = cliStatus[agent.cli];
      const configured = !!type && (!type.usesCustomCommand || !!agent.customCommand.trim());
      const customUnchecked = configured && !!type?.usesCustomCommand && !health;
      const ready = configured && (customUnchecked || (health?.state === 'ready' && health.ok));
      const capability = modelCaps.get(capKey(agent.cli, agent.model));
      return [agent.id, {
        ready,
        writable: ready && agent.canEdit && !!type?.supportsEdit && capability?.tools !== false,
        detail: !configured ? t('agent.cliMissing') : customUnchecked ? t('lineup.quick.customUnchecked') : ready ? t('cli.ready') : describeCliHealth(health, type).text,
      }];
    })),
    refresh: () => checkClis(),
    pickWorkDir,
    openConnections: () => openSettings('clis'),
    addMember: () => { void openModal(null); },
    copilotTrio: cliTypes.copilot ? async () => {
      const models = ['gpt-5-mini', 'claude-haiku-4.5', 'gpt-5.4-mini'];
      const taken = new Set(config.agents.map((agent) => agent.id));
      const created = models.map((model, index) => {
        let id = `copilot-${model.replace(/[^a-z0-9]+/gi, '-')}`;
        for (let n = 2; taken.has(id); n++) id = `copilot-${model.replace(/[^a-z0-9]+/gi, '-')}-${n}`;
        taken.add(id);
        return { id, name: `Copilot ${model}`, cli: 'copilot', model, effort: '', persona: '', color: ['#2f81f7', '#a371f7', '#3fb950'][index], canEdit: false, enabled: true, customCommand: '' };
      });
      const fresh = created.filter((member) => !config.agents.some((agent) => agent.cli === 'copilot' && agent.model === member.model));
      if (!fresh.length) return true;
      const next = { ...config, agents: [...config.agents, ...fresh] };
      try { await window.api.saveConfig(next); }
      catch (error) { showSaveFailed(cleanIpcError(error)); return false; }
      config.agents = next.agents;
      renderSidebar();
      updateComposerHint();
      return true;
    } : null,
    commit: async (next) => {
      try { await window.api.saveConfig(next); }
      catch (error) { showSaveFailed(cleanIpcError(error)); return false; }
      config.agents = next.agents;
      config.settings = next.settings;
      config.lineups = next.lineups;
      $<HTMLSelectElement>('#mode').value = config.settings.mode || 'divide';
      $<HTMLSelectElement>('#work-style').value = config.settings.workStyle === 'general' ? 'general' : 'code';
      renderSidebar();
      updateComposerHint();
      return true;
    },
  });
  setupExtensions({
    cliTypes: () => cliTypes,
    cliStatus: () => cliStatus,
    extSummary: () => extSummary,
    refreshCatalog,
    showSettingsTab,
  });
  renderSidebar();
  renderExtensions();
  jobsState = await window.api.jobs.list();
  shownJobId = window.api.jobs.current();
  const snap = await window.api.snapshot();
  setActiveSessionId(snap.sessionId || null);
  snap.messages.forEach((m) => renderMessage(m, { animate: false }));
  setState(snap);
  renderJobs();
  renderWorkdirChip();
  checkClis();
  setupComposerAttachments({
    isSwitchingJobs: () => switchingJobs,
    shownJobId: () => shownJobId,
    onChanged: updateComposerHint,
  });
  setupLayoutResize();
  ensureStagePin();
  window.addEventListener('resize', scheduleStagePin);
  // 修復卡片上的「打開設定」由這裡提供:env-fix 只負責畫面,不認得設定畫面
  setEnvFixHandlers({ openSettings: (tab) => openSettings(tab), install: (cliId) => { void openInstallDialog(cliId); } });
  setupInstallDialog(async () => { await checkClis(); return cliStatus; });
  setupHistory({
    running: () => running,
    md,
    phaseText,
    usageText,
    attachmentsMarkup,
    hydrateAttachmentThumbs,
    onResumed: async ({ id, messages, snapshot }) => {
      clearTimeline();
      await clearPendingAttachments();
      setActiveSessionId(id);
      messages.forEach((m) => renderMessage(m, { animate: false }));
      setState(snapshot);
      $<HTMLDivElement>('#timeline').scrollTop = $<HTMLDivElement>('#timeline').scrollHeight;
      $<HTMLTextAreaElement>('#input').focus();
    },
  });
  // 終端面板:平常收著。成員在工作目錄動手,使用者也該能在同一個目錄自己下指令。
  setupTerminal({
    workDir: () => selectedJob()?.workDir || config.settings.workDir,
    width: () => Number(config.settings.terminalWidth) || 0,
    saveWidth: (value) => { config.settings.terminalWidth = value; void saveConfig(); },
  });

  window.api.onMessage((m) => renderMessage(m, { animate: true }));
  window.api.onState((state) => { setState(state); if (!state.running) refreshTaskVerifications(); });
  window.api.jobs.onChange(onJobsChanged);
  $<HTMLButtonElement>('#job-new').onclick = () => { void createJob(); };
  window.api.onReset(() => {
    clearTimeline();
    clearPendingAttachments();
    setActiveSessionId(null);
    if (isHistoryLoaded()) renderHistoryList();
  });
  // 任務結束寫入紀錄後刷新清單,剛完成或剛續接的對話會排到最上面
  window.api.onSessionSaved((info) => {
    setActiveSessionId((info && info.id) || getActiveSessionId());
    if (isHistoryLoaded()) void loadHistory(true, { quiet: true });
  });

  $<HTMLButtonElement>('#send-btn').onclick = sendMessage;
  $<HTMLTextAreaElement>('#input').addEventListener('keydown', (e) => {
    if (handleMentionKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
  });
  $<HTMLTextAreaElement>('#input').addEventListener('input', () => { updateMentionMenu(); updateComposerHint(); });
  $<HTMLTextAreaElement>('#input').addEventListener('click', updateMentionMenu);
  $<HTMLTextAreaElement>('#input').addEventListener('blur', closeMentionMenu);
  $<HTMLButtonElement>('#stop-btn').onclick = () => { void stopSelected(); };
  $<HTMLButtonElement>('#reset-btn').onclick = () => {
    if (!switchingJobs && (!running || confirm(t('confirm.reset')))) void window.api.reset().catch((error) => alert(cleanIpcError(error)));
  };
  $<HTMLButtonElement>('#export-btn').onclick = exportConversation;
  const tools = $('#task-tools');
  const toolsButton = $('#tools-btn');
  const positionTools = () => {
    const bounds = toolsButton.getBoundingClientRect();
    tools.style.top = `${bounds.bottom + 8}px`;
    tools.style.right = `${Math.max(12, window.innerWidth - bounds.right)}px`;
  };
  tools.addEventListener('beforetoggle', positionTools);
  tools.addEventListener('toggle', () => toolsButton.setAttribute('aria-expanded', String(tools.matches(':popover-open'))));
  tools.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('button:not(:disabled)')) tools.hidePopover();
  });
  window.addEventListener('resize', positionTools);
  $<HTMLButtonElement>('#sessions-btn').onclick = () => void openFolder(() => window.api.openSessions());
  $<HTMLButtonElement>('#settings-btn').onclick = () => openSettings();
  $<HTMLButtonElement>('#cli-summary').onclick = () => openSettings('clis');
  $<HTMLButtonElement>('#settings-close').onclick = closeSettings;
  document.querySelectorAll<HTMLElement>('.settings-tab').forEach((tab) => { tab.onclick = () => showSettingsTab(tab.dataset.tab || ''); });
  $<HTMLButtonElement>('#workdir-chip').onclick = pickWorkDir;
  // 點背景關閉只用在沒有編輯內容的視窗,避免誤點丟掉未儲存的成員或擴充設定
  $<HTMLButtonElement>('#diff-btn').onclick = () => { void openDiff(); };
  $<HTMLButtonElement>('#diff-close').onclick = () => $<HTMLDivElement>('#diff-modal').classList.add('hidden');
  $<HTMLButtonElement>('#diff-refresh').onclick = () => loadDiff();
  for (const id of ['#settings', '#history-modal', '#ext-picker', '#diff-modal', '#install-modal']) {
    $(id).addEventListener('mousedown', (e) => { if (e.target === $(id)) closeTopModal(); });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && closeTopModal()) e.preventDefault();
    if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); openSettings(); }
    // ⌘J 開關終端。終端自己聚焦時的 ⌘J / ⌘T / ⌘W / ⌘K 由 renderer/terminal.ts 處理
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); void toggleTerminal(); }
  });
  $<HTMLButtonElement>('#add-agent').onclick = () => openModal(null);
  $<HTMLButtonElement>('#modal-close').onclick = closeModal;
  $<HTMLButtonElement>('#modal-save').onclick = saveModal;
  $<HTMLButtonElement>('#modal-delete').onclick = deleteAgent;
  $<HTMLSelectElement>('#f-cli').onchange = () => fillCliDependentFields($<HTMLSelectElement>('#f-cli').value);
  $<HTMLSelectElement>('#f-model-select').onchange = onModelSelect;
  $<HTMLInputElement>('#f-model').oninput = () => updateCapabilityRow();
  $<HTMLButtonElement>('#f-cap-test').onclick = () => { void testCapability(); };
  $<HTMLInputElement>('#f-model').addEventListener('input', () => refreshModelDependents());
  $<HTMLButtonElement>('#pick-dir').onclick = pickWorkDir;
  $<HTMLButtonElement>('#open-dir').onclick = () => void openFolder(() => window.api.openPath($<HTMLInputElement>('#work-dir').value));
  $<HTMLInputElement>('#work-dir').addEventListener('input', clearVerifySuggestions);
  for (const id of ['#work-dir', '#max-rounds', '#discussion-mode', '#language', '#lead-agent', '#default-mode', '#max-transcript', '#max-parallel', '#max-task-cost', '#verify-command', '#allow-git', '#allow-git-push']) $(id).addEventListener('change', saveSettings);
  $<HTMLTextAreaElement>('#verify-command').addEventListener('input', () => renderVerifySuggestions());
  document.querySelectorAll<HTMLInputElement>('input[name="theme"], input[name="font-size"], input[name="ui-locale"]').forEach((el) => el.addEventListener('change', saveAppearance));
  $<HTMLSelectElement>('#mode').value = config.settings.mode || 'divide';
  $<HTMLSelectElement>('#work-style').value = config.settings.workStyle === 'general' ? 'general' : 'code';
  $<HTMLSelectElement>('#mode').onchange = () => { config.settings.mode = $<HTMLSelectElement>('#mode').value; $<HTMLSelectElement>('#default-mode').value = config.settings.mode; void saveConfig(); renderLineupButton(); };
  $<HTMLSelectElement>('#work-style').onchange = () => {
    config.settings.workStyle = $<HTMLSelectElement>('#work-style').value === 'general' ? 'general' : 'code';
    void saveConfig();
    updateComposerHint();
  };
}

// ---------- 設定視窗 ----------

let detectedVerifyCommands: string[] = [];
let detectVerifySeq = 0;
let detectVerifyError = '';
let detectingVerify = false;

function clearVerifySuggestions(): void {
  detectVerifySeq++;
  detectedVerifyCommands = [];
  detectVerifyError = '';
  detectingVerify = false;
  renderVerifySuggestions();
}

async function refreshVerifySuggestions(): Promise<void> {
  clearVerifySuggestions();
  const cwd = $<HTMLInputElement>('#work-dir').value.trim();
  const seq = detectVerifySeq;
  if (!cwd) return;
  detectingVerify = true;
  renderVerifySuggestions();
  try {
    if (typeof window.api.detectVerifyCommands !== 'function') throw new Error(t('settings.verifyUnavailable'));
    const res = await window.api.detectVerifyCommands(cwd);
    if (seq !== detectVerifySeq) return;
    if (!Array.isArray(res?.commands) || !res.commands.every((cmd) => typeof cmd === 'string')) throw new Error(t('settings.verifyInvalidResponse'));
    detectedVerifyCommands = res.commands;
  } catch (error) {
    if (seq !== detectVerifySeq) return;
    detectVerifyError = cleanIpcError(error);
  }
  detectingVerify = false;
  renderVerifySuggestions();
}

function renderVerifySuggestions(): void {
  const box = document.getElementById('verify-suggestions') as HTMLDivElement | null;
  if (!box) return;
  const input = $<HTMLTextAreaElement>('#verify-command');
  const existing = new Set(input.value.split('\n').map((line) => line.trim()).filter(Boolean));
  const missing = detectedVerifyCommands.filter((cmd) => !existing.has(cmd));
  box.innerHTML = '';
  box.hidden = false;
  if (detectingVerify || detectVerifyError) {
    const status = document.createElement('span');
    status.className = 'verify-suggest-label';
    status.setAttribute('role', detectVerifyError ? 'alert' : 'status');
    status.textContent = detectVerifyError ? t('settings.verifyFailed', { reason: detectVerifyError }) : t('settings.verifyDetecting');
    box.appendChild(status);
    if (detectVerifyError) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'ghost small';
      retry.textContent = t('msg.retry');
      retry.onclick = () => { void refreshVerifySuggestions(); };
      box.appendChild(retry);
    }
    return;
  }
  if (!missing.length) {
    box.hidden = true;
    return;
  }
  const label = document.createElement('span');
  label.className = 'verify-suggest-label';
  label.textContent = t('settings.verifyDetected');
  box.appendChild(label);
  for (const cmd of missing) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost small verify-chip';
    btn.textContent = `+ ${cmd}`;
    btn.onclick = () => {
      const current = input.value.split('\n').map((line) => line.trim()).filter(Boolean);
      if (!current.includes(cmd)) current.push(cmd);
      input.value = current.join('\n');
      saveSettings();
    };
    box.appendChild(btn);
  }
  if (missing.length > 1) {
    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'ghost small verify-chip verify-chip-all';
    allBtn.textContent = `+ ${t('settings.verifyAddAll')}`;
    allBtn.onclick = () => {
      const current = input.value.split('\n').map((line) => line.trim()).filter(Boolean);
      for (const cmd of missing) if (!current.includes(cmd)) current.push(cmd);
      input.value = current.join('\n');
      saveSettings();
    };
    box.appendChild(allBtn);
  }
}

function openSettings(tab = 'general'): void {
  renderSidebar();
  showSettingsTab(tab);
  $('#settings-saved').hidden = true;
  $<HTMLDivElement>('#settings').classList.remove('hidden');
  void refreshVerifySuggestions();
  // 使用者正要依燈號判斷「哪一位能用」,這時才值得花一次網路往返真的驗證 key。
  // 不 await:畫面先開,狀態回來再重畫。
  void checkClis({ probeCredentialed: true });
}

// shell.openPath 打不開時不會丟例外,而是回一段訊息(路徑不存在、沒有權限)。
// 以前那段訊息被丟掉:按下去什麼都沒發生,也沒有人說為什麼。
async function openFolder(open: () => Promise<string | void>): Promise<void> {
  try {
    const message = await open();
    if (message) alert(t('folder.openFailed', { reason: String(message) }));
  } catch (error) {
    alert(t('folder.openFailed', { reason: cleanIpcError(error) }));
  }
}

function closeSettings() { $<HTMLDivElement>('#settings').classList.add('hidden'); }

function showSettingsTab(tab: string): void {
  document.querySelectorAll<HTMLElement>('.settings-tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll<HTMLElement>('.settings-page').forEach((el) => { el.hidden = el.dataset.page !== tab; });
  $('#settings-title').textContent = ['general', 'clis', 'appearance', 'data'].includes(tab) ? t(`settings.tab.${tab}`) : t('settings.title');
}

let savedHintTimer: ReturnType<typeof setTimeout> | undefined;
// 設定寫入失敗(磁碟滿了、沒有權限)時,介面以前照樣顯示「已儲存」,下次開 app 設定就不見了。
// 一律走這裡:等寫入真的完成才說成功,失敗就把原因顯示出來。
async function saveConfig({ saved = false }: { saved?: boolean } = {}): Promise<boolean> {
  try {
    await window.api.saveConfig(config);
    if (saved) flashSaved();
    return true;
  } catch (error) {
    showSaveFailed(cleanIpcError(error));
    return false;
  }
}

function showSaveFailed(detail: string): void {
  const el = $('#settings-saved');
  el.hidden = false;
  el.classList.add('failed');
  el.textContent = t('settings.saveFailed', { error: detail });
  clearTimeout(savedHintTimer);
  // 失敗訊息留久一點:使用者要看得完,也要知道剛才那一下沒有存到
  savedHintTimer = setTimeout(() => { el.hidden = true; }, 8000);
  console.error('儲存設定失敗', detail);
}

function flashSaved() {
  const el = $('#settings-saved');
  el.hidden = false;
  el.classList.remove('failed');
  el.textContent = t('settings.saved');
  clearTimeout(savedHintTimer);
  savedHintTimer = setTimeout(() => { el.hidden = true; }, 1600);
}

// Esc 或點背景時關掉最上層的視窗;回傳是否有關掉
function closeTopModal() {
  const open = [...document.querySelectorAll<HTMLElement>('.modal:not(.hidden)')];
  const top = open[open.length - 1];
  if (!top || top.id === 'ext-editor') return false; // 擴充編輯器有未儲存的程式碼,不用 Esc 關
  if (top.id === 'install-modal' && isInstallRunning()) return true;
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
  // 終端有自己的色盤(xterm 認不得 CSS 變數),跟著主題一起換
  syncTerminalTheme();
}

function saveAppearance() {
  const theme = document.querySelector<HTMLInputElement>('input[name="theme"]:checked');
  const size = document.querySelector<HTMLInputElement>('input[name="font-size"]:checked');
  const locale = document.querySelector<HTMLInputElement>('input[name="ui-locale"]:checked');
  if (theme) config.settings.theme = theme.value;
  if (size) config.settings.fontSize = Number(size.value);
  if (locale) config.settings.uiLocale = locale.value as AppConfig['settings']['uiLocale'];
  applyAppearance();
  void saveConfig({ saved: true });
  if (locale) relocalize();
}

// 切換介面語言:靜態文案重填、側欄與時間軸重畫;訊息資料都還在 messageData,直接重新 render
function relocalize(): void {
  applyStaticText();
  relocalizeTerminal();
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
  refreshHistoryUI();
  renderJobs();
  refreshQueueControls();
  renderVerifySuggestions();
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
  ensureStagePin();
  updateUsageTotal();
  updateSpeakingHighlight();
}

function emptyEl() {
  const d = document.createElement('div');
  d.id = 'empty'; d.className = 'empty';
  d.innerHTML = `<img class="empty-icon" src="icon.png" width="84" height="84" alt="" aria-hidden="true" /><div class="empty-title">${escapeHtml(t('empty.title'))}</div><div class="empty-sub">${escapeHtml(t('empty.sub'))}</div><div class="empty-steps"><span>${escapeHtml(t('stage.discuss'))}</span><span class="arrow">→</span><span>${escapeHtml(t('stage.execute'))}</span><span class="arrow">→</span><span>${escapeHtml(t('stage.review'))}</span></div>`;
  return d;
}

// probeCredentialed:打開設定時帶 true,真的連線驗證有 key 的雲端 API。
// 啟動時不帶,避免每開一次 app 就打一輪付費端點。
async function checkClis(opts: { probeCredentialed?: boolean } = {}) {
  cliStatus = await window.api.checkCli(opts);
  resetCapabilities(); // 例如 Ollama 晚一點才開:健康狀態變了,能力要重問
  // 側邊欄也要重畫:成員卡上的健康徽章讀的就是 cliStatus,不重畫的話它永遠停在
  // 「還沒檢查」那一刻的樣子——也就是什麼警告都不顯示。
  renderSidebar();
  renderExtensions();
  renderCliSummary();
  // 成員編輯視窗開著時,裡面那張狀態卡也要跟著更新:健康檢查是非同步的,
  // 不重畫的話使用者看到的是「還沒檢查」那一刻的樣子
  if (!$('#modal').classList.contains('hidden')) updateCliStatusNote($<HTMLSelectElement>('#f-cli').value);
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
async function refreshCatalog() {
  [cliTypes, extSummary] = await Promise.all([window.api.cliTypes(), window.api.ext.list()]);
  resetCapabilities(); // 擴充可能改了端點或模型清單
  renderSidebar();
  renderExtensions();
  renderCliSummary();
  checkClis();
}

// ---------- 側欄 ----------
function renderSidebar() {
  const list = $<HTMLDivElement>('#agent-list');
  list.innerHTML = '';
  const lead = config.settings.leadAgentId || config.agents.find((a) => a.enabled !== false)?.id;
  for (const a of config.agents) {
    const el = document.createElement('div');
    el.className = 'agent-card' + (a.enabled === false ? ' disabled' : '');
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', a.name);
    el.dataset.agentId = a.id;
    el.style.setProperty('--c', a.color); // 頭像外圈的成員色淡光
    if (a.persona) el.title = a.persona;
    // 健康狀態要畫在成員卡上。以前只在「轉接器沒註冊」時給徽章,所以綁到一個沒安裝的
    // CLI 的成員看起來完全正常——使用者要等送出任務失敗才知道,而那時已經浪費一輪。
    const health = cliTypes[a.cli] ? cliStatus[a.cli] : null;
    const healthBadge = !cliTypes[a.cli]
      ? `<span class="badge bad">${escapeHtml(t('agent.cliMissing'))}</span>`
      : health && health.state === 'missing'
        ? `<span class="badge bad" title="${escapeHtml(health.error || '')}">${escapeHtml(t('agent.notInstalled'))}</span>`
        : health && health.state === 'unauthenticated'
          // 同樣是 unauthenticated:API 缺的是 key,CLI 缺的是登入。說錯的話使用者會去找不存在的東西。
          ? `<span class="badge warn" title="${escapeHtml(health.hint || health.error || '')}">${escapeHtml(t(cliTypes[a.cli].type === 'openai' ? 'agent.needsKey' : 'agent.needsLogin'))}</span>`
          : health && health.state === 'unreachable'
            ? `<span class="badge warn" title="${escapeHtml(health.hint || health.error || '')}">${escapeHtml(t('agent.offline'))}</span>`
            : '';
    const editBadge = cliTypes[a.cli] && !(a.canEdit && cliTypes[a.cli].supportsEdit)
      ? `<span class="badge">${escapeHtml(t('agent.readOnly'))}</span>` : '';
    ensureCapability(a.cli, a.model, renderSidebar);
    el.innerHTML = `
      <div class="avatar" style="background:${a.color}">${initials(a.name)}</div>
      <div class="agent-info">
        <div class="agent-name">${escapeHtml(a.name)} ${a.id === lead ? `<span class="badge lead">${escapeHtml(t('agent.lead'))}</span>` : ''} ${healthBadge}${editBadge}${capabilityBadges(a)}</div>
        <div class="agent-meta">${escapeHtml([cliLabel(cliTypes[a.cli], a.cli), a.model, a.effort ? effortLabel(a.effort) : ''].filter(Boolean).join(' · '))}</div>
      </div>`;
    el.onclick = () => openModal(a.id);
    el.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openModal(a.id); }
    };
    list.appendChild(el);
  }
  $<HTMLInputElement>('#work-dir').value = config.settings.workDir || '';
  $<HTMLInputElement>('#max-rounds').value = String(config.settings.maxRounds || 3);
  $<HTMLSelectElement>('#discussion-mode').value = config.settings.discussionMode === 'independent-first' ? 'independent-first' : 'sequential';
  $<HTMLInputElement>('#max-rounds').min = config.settings.discussionMode === 'independent-first' ? '2' : '1';
  $<HTMLInputElement>('#language').value = config.settings.language || '繁體中文';
  $<HTMLSelectElement>('#default-mode').value = config.settings.mode || 'divide';
  $<HTMLInputElement>('#max-transcript').value = String(config.settings.maxTranscriptChars ?? 60000);
  $<HTMLInputElement>('#max-parallel').value = String(config.settings.maxParallelJobs || 2);
  $<HTMLInputElement>('#max-task-cost').value = config.settings.maxTaskCostUsd && config.settings.maxTaskCostUsd > 0 ? String(config.settings.maxTaskCostUsd) : '';
  $<HTMLTextAreaElement>('#verify-command').value = config.settings.verifyCommand || '';
  $<HTMLInputElement>('#allow-git').checked = config.settings.allowGitCommit === true;
  $<HTMLInputElement>('#allow-git-push').checked = config.settings.allowGitPush === true;
  renderWorkdirChip();
  const sel = $<HTMLSelectElement>('#lead-agent');
  sel.innerHTML = config.agents.filter((a) => a.enabled !== false).map((a) => `<option value="${a.id}" ${a.id === lead ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('');
  updateSpeakingHighlight();
  renderLineupButton(); // 成員、角色、主持人或流程改了,陣容可能變成「已修改」
}

function saveSettings() {
  const previousWorkDir = config.settings.workDir;
  config.settings.workDir = $<HTMLInputElement>('#work-dir').value.trim();
  config.settings.discussionMode = $<HTMLSelectElement>('#discussion-mode').value === 'independent-first' ? 'independent-first' : 'sequential';
  config.settings.maxRounds = Math.max(config.settings.discussionMode === 'independent-first' ? 2 : 1, Number($<HTMLInputElement>('#max-rounds').value) || 3);
  config.settings.language = $<HTMLInputElement>('#language').value.trim() || '繁體中文';
  config.settings.leadAgentId = $<HTMLSelectElement>('#lead-agent').value || null;
  config.settings.mode = $<HTMLSelectElement>('#default-mode').value || 'divide';
  config.settings.verifyCommand = $<HTMLTextAreaElement>('#verify-command').value.trim();
  config.settings.allowGitCommit = $<HTMLInputElement>('#allow-git').checked;
  config.settings.allowGitPush = $<HTMLInputElement>('#allow-git-push').checked;
  const maxTranscript = Number($<HTMLInputElement>('#max-transcript').value);
  config.settings.maxTranscriptChars = Number.isFinite(maxTranscript) && maxTranscript >= 0 ? maxTranscript : 60000;
  config.settings.maxParallelJobs = Math.min(6, Math.max(1, Math.round(Number($<HTMLInputElement>('#max-parallel').value) || 2)));
  const maxCost = Number($<HTMLInputElement>('#max-task-cost').value);
  if (Number.isFinite(maxCost) && maxCost > 0) config.settings.maxTaskCostUsd = Math.round(maxCost * 1000) / 1000;
  else delete config.settings.maxTaskCostUsd;
  $<HTMLSelectElement>('#mode').value = config.settings.mode;
  // 畫面照記憶體裡的設定重畫;存不進去的事由 saveConfig 自己說,不要讓畫面跟著卡住
  void saveConfig({ saved: true });
  renderSidebar();
  if (config.settings.workDir !== previousWorkDir) void refreshVerifySuggestions();
  else renderVerifySuggestions();
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
  // 使用者可能剛在終端裡登入或裝好 CLI:每次打開都重新檢查一次,卡片才不會停在舊狀態。
  // 帶 probeCredentialed:正要為這位成員挑模型,這時才值得花一次往返真的驗證端點與 key
  // (和打開設定畫面同一個理由)。
  void checkClis({ probeCredentialed: true });
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
    + models.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml((m.label !== m.id ? `${m.id}(${m.label})` : m.id) + (m.lowCost ? t('agent.lowCost') : ''))}</option>`).join('')
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
  updateCliStatusNote(cli);
  refreshModelDependents(effort);
  updateCapabilityRow();
}

// 在「選模型」的地方就把這個 CLI / API 的狀態說清楚。
// 以前這裡只有一排模型可以選:CLI 沒裝、沒登入、端點連不上、模型清單讀不到時,畫面照樣
// 讓人挑好模型按儲存,要送出任務、等它失敗才知道。說法與修復方式和設定頁共用同一份。
function updateCliStatusNote(cli: string): void {
  const box = $<HTMLDivElement>('#f-cli-status');
  const described = describeCliHealth(cliStatus[cli], cliTypes[cli]);
  // 一切正常時不佔版面。模型清單讀不到另有說明(#f-model-desc 就在模型欄位底下),
  // 這張卡片只講「這個 CLI / API 本身能不能用」,不重複同一件事。
  if (described.tone === 'ok' || described.tone === '') { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `<div class="cli-status-line"><span class="status-dot ${described.tone}"></span><span title="${escapeHtml(described.detail)}">${escapeHtml(described.text)}</span></div>`
    + envFixHtml(described.fix);
  bindEnvFix(box);
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
  updateCapabilityRow();
}

// ---------- 模型能力(API 成員) ----------
// 同一個範本可以選到能力不同的模型:Ollama 上的 qwen 會呼叫工具,gemma3 不會。
// 知道了就顯示出來,流程也照著安排(不能呼叫工具的當唯讀成員、審查時附上內容);不知道就不顯示,不猜。
// 主程序只用免費的來源自動查(Ollama 回報、端點的模型資料);付費端點要使用者按「測試」。
const modelCaps = new Map<string, ModelCapability | null>();
const capsPending = new Set<string>();
// 轉接器清單或健康狀態更新(改了擴充的端點、Ollama 晚一點才開)、按了「測試」之後,整批重問主程序。
// 主程序有自己的快取,重問很便宜;不重問的話,卡片會一直停在舊的結果。
// 重問期間照舊顯示舊的結果,新的回來再換:先清空的話,每次健康檢查完成徽章都會閃一下。
// 世代編號讓重問之前發出、之後才回來的舊回應不會蓋掉新的。
const capsStale = new Set<string>();
let capsGeneration = 0;
function resetCapabilities(): void {
  capsGeneration++;
  for (const key of modelCaps.keys()) capsStale.add(key);
}
const capKey = (cli: string, model: string) => `${cli}\n${model || ''}`;
const isApiCli = (cli: string) => !!(cliTypes[cli] && cliTypes[cli].type === 'openai');

function ensureCapability(cli: string, model: string, onDone: () => void): void {
  if (!isApiCli(cli)) return;
  const key = capKey(cli, model);
  if ((modelCaps.has(key) && !capsStale.has(key)) || capsPending.has(key)) return;
  capsPending.add(key);
  const generation = capsGeneration;
  const settle = (cap: ModelCapability | null) => {
    if (generation !== capsGeneration) return; // 過期的回應:留著舊值,onDone 重畫時會再問一次
    modelCaps.set(key, cap);
    capsStale.delete(key);
  };
  window.api.modelCapability({ adapterId: cli, model: model || '' })
    .then(settle, () => settle(null))
    .finally(() => { capsPending.delete(key); onDone(); });
}

// 成員卡片只標限制:能做到的是預期,做不到的才需要使用者知道
function capabilityBadges(a: AgentConfig): string {
  const cap = modelCaps.get(capKey(a.cli, a.model));
  if (!cap) return '';
  const out: string[] = [];
  if (cap.tools === false) out.push(`<span class="badge warn" title="${escapeHtml(t('cap.noToolsTitle'))}">${escapeHtml(t('cap.noTools'))}</span>`);
  // 範本本來就不送圖的,「不能看圖」不是新資訊
  const sendsImages = (cliTypes[a.cli]?.capabilities?.attachments || []).includes('imageInline');
  if (cap.images === false && sendsImages) out.push(`<span class="badge" title="${escapeHtml(t('cap.noImagesTitle'))}">${escapeHtml(t('cap.noImages'))}</span>`);
  return out.join('');
}

// 能力、來源(淡色)、影響(只有不能呼叫工具時,警示色)。這次測試沒完成、但之前知道的保留時,再加一行說明
function describeCapability(cap: ModelCapability | null): { text: string; source: string; effect: string; error?: string } {
  if (!cap) return { text: t('cap.unknown'), source: '', effect: '' };
  if (cap.error && cap.tools === undefined && cap.images === undefined) return { text: t('cap.failed', { error: cap.error }), source: '', effect: '' };
  const text = [
    t(cap.tools === true ? 'cap.tools.yes' : cap.tools === false ? 'cap.tools.no' : 'cap.tools.unknown'),
    t(cap.images === true ? 'cap.images.yes' : cap.images === false ? 'cap.images.no' : 'cap.images.unknown'),
  ].join(' · ');
  const source = cap.source === 'probe'
    ? t('cap.source.probe', { time: new Date(cap.at).toLocaleString(localeTag(), { dateStyle: 'short', timeStyle: 'short' }) })
    : t(`cap.source.${cap.source}`);
  return { text, source, effect: cap.tools === false ? t('cap.effect.noTools') : '', ...(cap.error ? { error: t('cap.failedKept', { error: cap.error }) } : {}) };
}

function showCapability(parts: { text: string; source: string; effect: string; error?: string }): void {
  const error = $<HTMLDivElement>('#f-cap-error');
  error.textContent = parts.error || '';
  error.hidden = !parts.error;
  $<HTMLDivElement>('#f-cap-text').textContent = parts.text;
  const source = $<HTMLDivElement>('#f-cap-source');
  source.textContent = parts.source;
  source.hidden = !parts.source;
  const effect = $<HTMLDivElement>('#f-cap-effect');
  effect.textContent = parts.effect;
  effect.hidden = !parts.effect;
}

function updateCapabilityRow(): void {
  const cli = $<HTMLSelectElement>('#f-cli').value;
  const wrap = $<HTMLDivElement>('#f-cap');
  wrap.hidden = !isApiCli(cli);
  if (wrap.hidden) return;
  const model = currentModel();
  const key = capKey(cli, model);
  if (!modelCaps.has(key) || capsStale.has(key)) ensureCapability(cli, model, () => { updateCapabilityRow(); renderSidebar(); });
  showCapability(modelCaps.has(key) ? describeCapability(modelCaps.get(key) || null) : { text: t('cap.checking'), source: '', effect: '' });
}

async function testCapability(): Promise<void> {
  const cli = $<HTMLSelectElement>('#f-cli').value;
  const model = currentModel();
  const key = capKey(cli, model);
  const btn = $<HTMLButtonElement>('#f-cap-test');
  btn.disabled = true;
  btn.textContent = t('cap.testing');
  showCapability({ text: t('cap.testing'), source: '', effect: '' });
  let result: ModelCapability | null;
  try {
    result = await window.api.modelCapability({ adapterId: cli, model, live: true });
  } catch (error) {
    result = { model, source: 'probe', at: Date.now(), error: cleanIpcError(error) };
  }
  try {
    // 成員卡片存的可能是別名或空字串(範本預設),和這裡選的完整名稱是不同的 key:整批重問,
    // 主程序會把它們對應到同一筆剛測好的結果
    resetCapabilities();
    modelCaps.set(key, result);
    capsStale.delete(key);
  } finally {
    btn.disabled = false;
    btn.textContent = t('cap.test');
    updateCapabilityRow();
    renderSidebar();
  }
}

// 思考強度的選項在介面上要是人話:範本寫的是 none/low/high 這種值,
// 不寫程式的人看不出 none 就是「不要思考」。沒有對應翻譯的自訂值就照原字顯示。
function effortLabel(effort: string): string {
  const text = t(`effort.${effort}`);
  return text === `effort.${effort}` ? effort : text;
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
      : `<option value="">${escapeHtml(info && info.defaultEffort ? t('agent.effortDefaultOf', { effort: effortLabel(info.defaultEffort) }) : t('agent.effortDefault'))}</option>` + efforts.map((e) => `<option value="${escapeHtml(e)}">${escapeHtml(effortLabel(e))}</option>`).join('');
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
  void saveConfig();
  renderSidebar();
  closeModal();
}
function deleteAgent() {
  if (!editingId || !confirm(t('agent.confirmDelete'))) return;
  config.agents = config.agents.filter((x) => x.id !== editingId);
  if (config.settings.leadAgentId === editingId) config.settings.leadAgentId = null;
  void saveConfig();
  renderSidebar();
  closeModal();
}

// ---------- 對話 ----------
async function sendMessage() {
  if (switchingJobs) return;
  const owner = shownJobId;
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
    if (owner !== shownJobId || owner !== window.api.jobs.current()) {
      if (owner) drafts.set(owner, text);
      revokeThumbUrls(toClear);
      return;
    }
    pendingAttachments.unshift(...toClear);
    renderAttachChips();
    if (!$<HTMLTextAreaElement>('#input').value) { $<HTMLTextAreaElement>('#input').value = text; updateComposerHint(); }
    showAttachError(cleanIpcError(error) || t('composer.sendFailed'));
  }
}

function setState(s: ChatState): void {
  running = !!s.running;
  const pill = $<HTMLDivElement>('#phase-pill');
  pill.textContent = running ? phaseText(s.phase) : t('phase.idle');
  pill.className = 'phase ' + (running ? 'busy' : 'idle');
  refreshQueueControls();
  updateComposerHint();
  updateResumeButton();
  updateSpeakingHighlight();
  renderLineupButton(); // 會議進行中不能換陣容
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
  const mode = $<HTMLSelectElement>('#mode');
  mode.title = t(`mode.${mode.value}`);
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
      // 範本會送圖,但已知這個模型不能看圖,一樣收不到
      const images = modes.includes('imageInline') && modelCaps.get(capKey(agent.cli, agent.model))?.images !== false;
      return !images && !modes.includes('filePath');
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
    // 讓每則訊息在 DOM 上可以被定位(除錯與 harness 都用得到);元素本身仍以 msgEls 為準
    el.dataset.msgId = m.id;
    msgEls.set(m.id, el);
    placed = placeMessage(el, m);
    if (animate) {
      el!.classList.add('enter');
      el!.addEventListener('animationend', () => el!.classList.remove('enter'), { once: true });
    }
  }
  el.className = `msg ${m.kind} ${m.level || ''} ${m.kind === 'system' && m.tag ? `tag-${m.tag}` : ''} ${m.status === 'running' ? 'streaming' : ''}${el.classList.contains('enter') ? ' enter' : ''}${el.classList.contains('msg-continue') ? ' msg-continue' : ''}`;
  if (m.agentId) el.dataset.agentId = m.agentId;
  else delete el.dataset.agentId;
  if (m.kind === 'agent') renderAgentMessage(el, m);
  else if (m.kind === 'user') renderUserMessage(el, m);
  else if (m.tag === 'task-summary' && m.taskSummary) renderTaskSummary(el, m.taskSummary, m.id, m.planResumable === true);
  else { el.innerHTML = systemHtml(m); bindEnvFix(el); }
  if (isNew && placed!.isNewNode) insertTimelineMarkers(placed!.node, m);
  if (el.parentElement && el.parentElement.classList.contains('msg-group')) el.classList.remove('msg-continue');
  else updateContinuation(el);
  updateSpeakingHighlight();
  if (atBottom) tl.scrollTop = tl.scrollHeight;
  scheduleStagePin();
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
  divide: 'execute', tests: 'execute', execute: 'execute',
  review: 'review', repair: 'review', summary: 'review',
};

// ---------- 多件任務 ----------
function selectedJob(): JobSummary | null {
  return jobsState ? jobsState.jobs.find((job) => job.id === jobsState!.selectedId) || null : null;
}

function jobStatusText(job: JobSummary): string {
  if (job.status === 'queued') {
    return job.waitingFor ? t(`jobs.waiting.${job.waitingFor}`, { n: jobsState ? jobsState.maxParallel : 0 }) : t('jobs.status.queued');
  }
  if (job.status === 'running') return phaseText(job.phase) || t('jobs.status.running');
  return t(`jobs.status.${job.status}`);
}

function renderJobs(): void {
  const list = $<HTMLDivElement>('#job-list');
  list.innerHTML = '';
  if (!jobsState) return;
  const closable = jobsState.jobs.length > 1;
  for (const job of [...jobsState.jobs].sort((a, b) => b.createdAt - a.createdAt)) {
    const active = job.id === jobsState.selectedId;
    const item = document.createElement('div');
    item.className = `job-item${active ? ' active' : ''}`;
    item.dataset.jobId = job.id;
    const open = document.createElement('button');
    open.className = 'job-open';
    if (active) open.setAttribute('aria-current', 'true');
    const title = document.createElement('span');
    title.className = 'job-title';
    title.innerHTML = `<i class="job-dot ${escapeHtml(job.status)}" aria-hidden="true"></i><span></span>${job.unread ? '<i class="job-unread" aria-hidden="true"></i>' : ''}`;
    title.querySelector('span')!.textContent = job.title || t('jobs.untitled');
    const meta = document.createElement('span');
    meta.className = 'job-meta';
    meta.textContent = [job.status === 'queued' ? t('jobs.status.queued') : '', jobStatusText(job), job.workDir ? shortPath(job.workDir) : ''].filter(Boolean).join(' · ');
    open.append(title, meta);
    open.onclick = () => { void selectJob(job.id); };
    item.appendChild(open);
    if (closable && !['running', 'queued', 'waiting'].includes(job.status)) {
      const close = document.createElement('button');
      close.className = 'job-close';
      close.title = t('jobs.close');
      close.textContent = '✕';
      close.onclick = () => { void closeJob(job.id); };
      item.appendChild(close);
    }
    list.appendChild(item);
  }
}

function renderWorkdirChip(): void {
  const pinned = selectedJob()?.workDir || '';
  const workDir = pinned || config.settings.workDir || '';
  const chip = $<HTMLButtonElement>('#workdir-chip');
  const iconName = workDir ? 'folder' : 'folderPlus';
  const chipIcon = $('#workdir-chip .chip-icon');
  if (chipIcon.dataset.icon !== iconName) { chipIcon.dataset.icon = iconName; chipIcon.replaceChildren(icon(iconName)); }
  chip.classList.toggle('empty', !workDir);
  $('#workdir-label').textContent = workDir ? shortPath(workDir) : t('topbar.workdirUnset');
  chip.title = pinned
    ? t('jobs.workdirPinned', { dir: pinned })
    : workDir ? t('topbar.workdirTitle', { dir: workDir }) : t('topbar.workdirChoose');
}

const SIDEBAR_DEFAULT = 264;
const SIDEBAR_MIN = 220;
const COMPOSER_MIN = 60;
const COMPOSER_DEFAULT = 76;
const clamp = (value: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, value)));

function setupLayoutResize(): void {
  const sidebar = $('#sidebar');
  const input = $<HTMLTextAreaElement>('#input');
  const sidebarHandle = $('#sidebar-resize');
  const composerHandle = $('#composer-resize');
  const sidebarMax = () => Math.max(SIDEBAR_MIN, Math.min(420, window.innerWidth - ($('#terminal-panel').hidden ? 0 : $('#terminal-panel').offsetWidth) - 560));
  const composerMax = () => Math.max(COMPOSER_MIN, Math.round(window.innerHeight * 0.45));
  const applySidebar = (value: number) => {
    const width = clamp(value, SIDEBAR_MIN, sidebarMax());
    sidebar.style.width = `${width}px`;
    sidebarHandle.setAttribute('aria-valuenow', String(width));
    sidebarHandle.setAttribute('aria-valuemax', String(sidebarMax()));
    return width;
  };
  const applyComposer = (value: number) => {
    const height = clamp(value, COMPOSER_MIN, composerMax());
    input.style.height = `${height}px`;
    composerHandle.setAttribute('aria-valuenow', String(height));
    composerHandle.setAttribute('aria-valuemax', String(composerMax()));
    scheduleStagePin();
    return height;
  };
  const saveSize = (key: 'sidebarWidth' | 'composerHeight', value: number | undefined) => {
    if (config.settings[key] === value) return;
    if (value) config.settings[key] = value; else delete config.settings[key];
    void saveConfig();
  };
  bindResizeHandle(sidebarHandle, {
    axis: 'x', direction: 1, get: () => sidebar.offsetWidth, apply: applySidebar,
    save: (value) => saveSize('sidebarWidth', value),
    reset: () => { sidebar.style.width = ''; sidebarHandle.setAttribute('aria-valuenow', String(sidebar.offsetWidth)); saveSize('sidebarWidth', undefined); },
  });
  bindResizeHandle(composerHandle, {
    axis: 'y', direction: -1, get: () => input.offsetHeight, apply: applyComposer,
    save: (value) => saveSize('composerHeight', value),
    reset: () => { applyComposer(COMPOSER_DEFAULT); saveSize('composerHeight', undefined); },
  });
  const restore = () => {
    if (config.settings.sidebarWidth) applySidebar(Number(config.settings.sidebarWidth) || SIDEBAR_DEFAULT);
    applyComposer(Number(config.settings.composerHeight) || COMPOSER_DEFAULT);
  };
  restore();
  window.addEventListener('resize', restore);
}

// 排隊中的任務還沒有會議狀態,停止鈕與階段膠囊要靠任務清單來說
function refreshQueueControls(): void {
  const job = selectedJob();
  const queued = job?.status === 'queued';
  $<HTMLButtonElement>('#stop-btn').disabled = !running && !queued;
  const note = $<HTMLDivElement>('#job-queue-note');
  note.hidden = !queued;
  note.textContent = queued && job ? t('jobs.queueNote', { reason: jobStatusText(job) }) : '';
  if (queued && !running) {
    const pill = $<HTMLDivElement>('#phase-pill');
    pill.textContent = t('phase.queued');
    pill.className = 'phase busy';
  }
}

function onJobsChanged(state: JobsState): void {
  const before = new Map((jobsState ? jobsState.jobs : []).map((job) => [job.id, job.status]));
  jobsState = { ...state, selectedId: window.api.jobs.current() || state.selectedId };
  renderJobs();
  renderWorkdirChip();
  const job = selectedJob();
  if (job && job.status !== 'queued' && !running) setState({ running: false });
  else refreshQueueControls();
  const finished = state.jobs.some((j) => before.has(j.id) && before.get(j.id) !== j.status && ['done', 'stopped', 'error'].includes(j.status));
  if (finished && isHistoryLoaded()) void loadHistory(true, { quiet: true });
}

function applyJobSwitch({ state, snapshot }: JobSelectResult): void {
  if (state.selectedId !== window.api.jobs.current()) return;
  const switched = shownJobId !== state.selectedId;
  jobsState = state;
  shownJobId = state.selectedId;
  if (switched) {
    $<HTMLDivElement>('#diff-modal').classList.add('hidden');
    clearTimeline();
    revokeThumbUrls(pendingAttachments.splice(0, pendingAttachments.length));
    renderAttachChips();
    clearAttachError();
    setActiveSessionId(snapshot.sessionId || null);
    snapshot.messages.forEach((m) => renderMessage(m, { animate: false }));
    $<HTMLTextAreaElement>('#input').value = drafts.get(state.selectedId) || '';
    void syncPendingAttachments();
    if (isHistoryLoaded()) renderHistoryList();
    $<HTMLDivElement>('#timeline').scrollTop = $<HTMLDivElement>('#timeline').scrollHeight;
  }
  setState(snapshot);
  renderJobs();
  renderWorkdirChip();
  $<HTMLTextAreaElement>('#input').focus();
}

async function selectJob(id: string): Promise<void> {
  if (!jobsState || id === shownJobId || switchingJobs) return;
  switchingJobs = true;
  if (shownJobId) drafts.set(shownJobId, $<HTMLTextAreaElement>('#input').value);
  try { applyJobSwitch(await window.api.jobs.select(id)); } catch (error) { alert(cleanIpcError(error)); }
  finally { switchingJobs = false; }
}

async function createJob(): Promise<void> {
  if (switchingJobs) return;
  switchingJobs = true;
  if (shownJobId) drafts.set(shownJobId, $<HTMLTextAreaElement>('#input').value);
  try { applyJobSwitch(await window.api.jobs.create()); } catch (error) { alert(cleanIpcError(error)); }
  finally { switchingJobs = false; }
}

async function closeJob(id: string): Promise<void> {
  if (switchingJobs) return;
  switchingJobs = true;
  try {
    const state = await window.api.jobs.close(id);
    drafts.delete(id);
    const current = window.api.jobs.current();
    if (current && current !== shownJobId) applyJobSwitch(await window.api.jobs.select(current));
    else { jobsState = { ...state, selectedId: current || state.selectedId }; renderJobs(); }
  } catch (error) { alert(cleanIpcError(error)); }
  finally { switchingJobs = false; }
}

// 排隊中按停止 = 取消排隊:送出的字與附件回到輸入框
async function stopSelected(): Promise<void> {
  if (switchingJobs) return;
  const owner = shownJobId;
  const result = await window.api.stop();
  if (result && typeof result.canceledText === 'string') {
    if (owner !== shownJobId || owner !== window.api.jobs.current()) {
      if (owner && !drafts.get(owner)?.trim()) drafts.set(owner, result.canceledText);
      return;
    }
    const input = $<HTMLTextAreaElement>('#input');
    if (!input.value.trim()) input.value = result.canceledText;
    await syncPendingAttachments();
    updateComposerHint();
  }
}

// 顯示文字一律在 renderer 這側依介面語言組出。
const PHASE_CODES = new Set(['idle', 'direct', 'discuss', 'ask', 'divide', 'tests', 'execute', 'review', 'repair', 'summary']);

// 發言標題只留上方階段分隔沒講到的階段(例如審查階段裡的修復、接力的第幾棒)
function headPhaseText(m: ChatMessage): string {
  const phase = m.phase;
  if (!isPhaseInfo(phase)) return phaseText(phase);
  if (phase.code === 'discuss' || phase.code === 'review') return '';
  if (phase.code === 'execute' && !(Number(phase.maxRounds) > 1)) return '';
  return phaseText(phase);
}

// 反例評估的 JSON 票改成人看得懂的一小塊;不是票就回傳 null,照原文顯示
function counterexampleVoteHtml(text: string): string | null {
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text.trim());
  let vote: any;
  try { vote = JSON.parse(fenced ? fenced[1] : text.trim()); } catch { return null; }
  const decisions = ['retain_counterexample', 'withdraw_counterexample', 'uncertain_counterexample'];
  if (!vote || typeof vote !== 'object' || !decisions.includes(vote.decision)) return null;
  const tone = { retain_counterexample: 'retain', withdraw_counterexample: 'withdraw', uncertain_counterexample: 'uncertain' }[vote.decision as string];
  const quote = typeof vote.requirement === 'string' && vote.requirement.trim() ? `<blockquote>${escapeHtml(vote.requirement.trim())}</blockquote>` : '';
  const reason = typeof vote.reason === 'string' ? `<p>${escapeHtml(vote.reason.trim())}</p>` : '';
  return `<div class="ce-vote"><span class="ce-vote-decision ${tone}">${escapeHtml(t(`ce.vote.${tone}`))}</span>${quote}${reason}</div>`;
}

function phaseText(phase: PhaseValue | undefined | null): string {
  if (!phase) return '';
  if (!isPhaseInfo(phase)) return phase; // 舊 session 存的是現成字串,原樣顯示
  const label = PHASE_CODES.has(phase.code) ? t(`phase.${phase.code}`) : phase.code;
  if (phase.code === 'discuss' && phase.round) {
    return phase.maxRounds ? t('phase.discussRound', { label, round: phase.round, max: phase.maxRounds }) : t('phase.discussR', { label, round: phase.round });
  }
  if (phase.code === 'direct' && phase.names && phase.names.length) return `${label} ${joinNames(phase.names)}`;
  if (phase.code === 'execute' && phase.round && phase.maxRounds) return t('phase.relayStep', { label, round: phase.round, max: phase.maxRounds });
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

// 捲過階段分隔線後,頂端只留一顆「目前階段」;下一條分隔線靠近時先淡出,兩個標題不會疊在一起
const STAGE_HANDOFF_PX = 56;
let stagePinFrame = 0;

function ensureStagePin(): HTMLElement {
  const timeline = $<HTMLDivElement>('#timeline');
  let pin = timeline.parentElement!.querySelector<HTMLElement>(':scope > .stage-pin');
  if (!pin) {
    pin = document.createElement('div');
    pin.className = 'stage-pin';
    pin.hidden = true;
    pin.setAttribute('aria-hidden', 'true');
    pin.innerHTML = '<span class="tl-stage-label"></span>';
    timeline.before(pin);
    timeline.addEventListener('scroll', scheduleStagePin, { passive: true });
  }
  return pin;
}

function scheduleStagePin(): void {
  if (stagePinFrame) return;
  stagePinFrame = requestAnimationFrame(() => { stagePinFrame = 0; updateStagePin(); });
}

function updateStagePin(): void {
  const timeline = $<HTMLDivElement>('#timeline');
  const pin = ensureStagePin();
  pin.hidden = !timeline.querySelector(':scope > .tl-stage');
  const top = timeline.getBoundingClientRect().top;
  let current: HTMLElement | null = null;
  let next: HTMLElement | null = null;
  for (const marker of Array.from(timeline.querySelectorAll<HTMLElement>(':scope > .tl-stage, .ts-end'))) {
    if (marker.getBoundingClientRect().top < top) current = marker.classList.contains('tl-stage') ? marker : null;
    else { next = marker; break; }
  }
  const handoff = !!next && next.getBoundingClientRect().top - top < STAGE_HANDOFF_PX;
  if (current) pin.firstElementChild!.textContent = current.textContent;
  pin.classList.toggle('on', !!current && !handoff);
}

function insertTimelineMarkers(el: HTMLElement, m: ChatMessage): void {
  const prev = adjacentMsg(el, -1);
  const inherited = prev ? prev.dataset.stage : '';
  let stage = stageFromMessage(m) || inherited || (m.kind === 'user' ? 'discuss' : '');
  // 計畫審核發生在分工之後,歸在「分工執行」裡,不要跳回「討論」
  if (stage === 'discuss' && inherited === 'execute' && m.kind !== 'user') stage = inherited;
  const round = stage === 'discuss' ? roundFromMessage(m) : 0;
  el.dataset.stage = stage || '';
  el.dataset.round = round ? String(round) : (stage && stage === inherited ? (prev && prev.dataset.round) || '' : '');
  if (stage && stage !== inherited) {
    const divider = document.createElement('div');
    divider.className = 'tl-stage';
    divider.innerHTML = `<span class="tl-stage-label">${escapeHtml(['discuss', 'execute', 'review', 'direct'].includes(stage) ? t(`stage.${stage}`) : stage)}</span>`;
    el.before(divider);
  }
  if (round && String(round) !== (prev && prev.dataset.round || '')) {
    const maxRounds = Number(typeof m.phase === 'object' ? m.phase?.maxRounds : 0) || Number(config && config.settings && config.settings.maxRounds) || 0;
    if (maxRounds === 1) return;
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
  // 系統訊息也可能帶「照做就能修好」的下一步(例如驗證指令根本不存在 → 打開設定)
  return `<div class="bubble"><div class="body">${md(m.text || '')}</div>${envFixHtml(m.fix)}</div>`;
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

function renderAgentMessage(el: HTMLElement, m: ChatMessage): void {
  const agreed = Marker.hasAgreement(m.text || '', 'AGREED');
  // 審查結論改用徽章表示,[NO_ISSUES] 這個給程式看的標記不顯示
  const text = m.review ? Marker.stripMarker(Marker.stripAgreement(m.text || '', 'AGREED'), 'NO_ISSUES') : Marker.stripAgreement(m.text || '', 'AGREED');
  // 結論與流程(要不要進修復回合)是同一個判斷,由主程序寫進訊息,介面不自己猜
  const verdict = m.review && !m.review.coverage && m.status !== 'running' ? m.review.verdict : undefined;
  const verdictBadge = (m.review?.coverage ? `<span class="badge recheck" title="${escapeHtml(t('review.coverageTitle'))}">${escapeHtml(t('review.coverage'))}</span>` : '')
    + (m.review?.recheck ? `<span class="badge recheck" title="${escapeHtml(t('review.recheckTitle'))}">${escapeHtml(t('review.recheck'))}</span>` : '')
    + (verdict
      ? `<span class="badge verdict ${escapeHtml(verdict)}" title="${escapeHtml(t(`review.verdictTitle.${verdict}`))}">${escapeHtml(t(`review.verdict.${verdict}`))}</span>`
      : '');
  const status = m.status === 'running' ? `<span class="spinner" title="${escapeHtml(t('msg.generating'))}"></span>` : '';
  const shell = ensureAgentShell(el);
  shell.avatar.style.background = m.color || '#6c8cff';
  setTextIfChanged(shell.avatar, initials(m.agentName));
  shell.bubble.style.setProperty('--c', m.color || '#6c8cff');
  setHtmlIfChanged(shell.head, `<span class="avatar head-avatar" style="background:${escapeHtml(m.color || '#6c8cff')}">${escapeHtml(initials(m.agentName))}</span><b title="${escapeHtml(cliLabel(cliTypes[m.cli || ''], m.cli || ''))}${m.model ? ' · ' + escapeHtml(m.model) : ''}">${escapeHtml(m.agentName)}</b>${headPhaseText(m) ? `<span class="phase-badge">${escapeHtml(headPhaseText(m))}</span>` : ''}${verdictBadge}${agreed ? `<span class="badge agreed">${escapeHtml(t('msg.agreed'))}</span>` : ''}${m.unreviewed ? `<span class="badge unreviewed" title="${escapeHtml(t('review.unreviewedTitle'))}">${escapeHtml(t('review.unreviewed'))}</span>` : ''}${status}`);
  renderReviewScope(shell.reviewScope, m.review);
  renderThinking(shell.thinking, m.thinking || '');
  renderActivities(shell.activities, m.activities || []);
  // 回合結束卻沒有任何內容時,以前留下一個完全空白的泡泡——使用者無從判斷是
  // 成員沒話說、還是出了什麼事。討論與總結階段都會這樣收尾,必須講出來。
  // 分工原文已經解析成下方的「分工結果」卡片:只留一句說明,原文收進可展開的區塊
  const body = text && m.rawPlan && m.status !== 'running'
    ? `<span class="hint raw-plan-note">${escapeHtml(t('plan.rawNote'))}</span><details class="raw-plan"><summary>${escapeHtml(t('plan.rawShow'))}</summary><div class="raw-plan-body">${md(text)}</div></details>`
    : text && m.status !== 'running' && counterexampleVoteHtml(text)
      ? counterexampleVoteHtml(text)!
    : text
      ? md(text)
      : m.status === 'running' ? '<span class="hint">…</span>'
        : m.error || agreed || verdict === 'pass' ? '' : `<span class="hint">${escapeHtml(t('msg.emptyReply'))}</span>`;
  if (!hasSelectionInside(shell.body)) setHtmlIfChanged(shell.body, body);
  // 一句話的發言(同意、通過)縮成一列,不佔一整張大卡片
  const plain = (text || '').trim();
  el.classList.toggle('short', m.status !== 'running' && !m.error && !m.rawPlan && !m.thinking && !(m.activities || []).length
    && !m.review && !plain.includes('\n') && plain.length <= 60 && !counterexampleVoteHtml(plain));
  shell.error.hidden = !m.error;
  setTextIfChanged(shell.error, m.error ? `⚠ ${m.error}` : '');
  // 失敗如果是環境問題,錯誤訊息底下直接給下一步:和設定頁、檔案改動同一張卡片。
  // 使用者不必看懂一段英文 stderr,也不必自己去別的地方找該做什麼。
  if (shell.fix) {
    const html = m.error ? envFixHtml(m.fix || null) : '';
    if (shell.fix.innerHTML !== html) {
      shell.fix.innerHTML = html;
      bindEnvFix(shell.fix);
    }
    shell.fix.hidden = !html;
  }
  if (shell.retry) {
    const retry = shell.retry;
    retry.hidden = !m.retryable;
    retry.textContent = t('msg.retry');
    retry.onclick = async () => {
      retry.disabled = true;
      const result = await window.api.retry(m.id);
      // 成功時 orchestrator 會把 retryable 清掉,按鈕隨下一次渲染消失;失敗才需要在這裡復原
      if (!result.ok) { retry.disabled = false; retry.title = result.error || ''; }
    };
  }
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
  // 等待狀態。本機模型一回合要 1~3 分鐘,只有轉圈的話,使用者分不出它是在載入模型、
  // 在思考、在跑工具,還是已經卡住——而最後一種才需要他去按停止。
  const waitState = text ? 'streaming'
    : m.thinking ? 'thinking'
      : (m.activities || []).some((a) => a.status === 'running') ? 'tool' : 'waiting';
  // 內容有變就算有進度。串流的文字、思考、工具動作任何一項長了都算。
  const progress = `${(m.text || '').length}:${(m.thinking || '').length}:${(m.activities || []).length}`;
  if (el.dataset.progress !== progress) { el.dataset.progress = progress; el.dataset.progressAt = String(Date.now()); }
  el.dataset.waitState = waitState;
  el.dataset.startedAt = String(Number(m.ts) || Date.now());
  updateStatusLine(el);
  if (m.status === 'running') ensureProgressTicker();
}

// 沒有新內容多久之後標示出來。本機模型第一個字可能要 30 秒以上(載入模型),
// 太早提醒會讓人以為壞了。
const STALE_AFTER_S = 60;
let progressTimer: ReturnType<typeof setInterval> | undefined;

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function updateStatusLine(el: HTMLElement): void {
  const line = el.querySelector<HTMLElement>('.bubble-status');
  if (!line) return;
  const now = Date.now();
  const elapsed = formatElapsed(now - (Number(el.dataset.startedAt) || now));
  const idle = Math.floor((now - (Number(el.dataset.progressAt) || now)) / 1000);
  const stale = idle >= STALE_AFTER_S;
  const label = t(`msg.wait.${el.dataset.waitState || 'streaming'}`);
  line.textContent = stale ? `${label} · ${elapsed} · ${t('msg.stale', { n: idle })}` : `${label} · ${elapsed}`;
  line.classList.toggle('stale', stale);
}

// 一個計時器更新所有進行中的泡泡;沒有進行中的就自己停掉,閒置時不耗電。
function ensureProgressTicker(): void {
  if (progressTimer) return;
  progressTimer = setInterval(() => {
    const running = document.querySelectorAll<HTMLElement>('#timeline .msg.streaming');
    if (!running.length) { clearInterval(progressTimer); progressTimer = undefined; return; }
    running.forEach(updateStatusLine);
  }, 1000);
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
    // 交叉審查:這位審查者審誰、看了哪些檔案。放在內容之前,讀審查意見前先知道它的依據
    const reviewScope = document.createElement('div');
    reviewScope.className = 'review-scope';
    reviewScope.hidden = true;
    const body = document.createElement('div');
    body.className = 'body';
    const error = document.createElement('div');
    error.className = 'error-text';
    // 環境問題(沒登入、沒裝、連不上…)的修復卡片,和設定頁、檔案改動用的是同一張
    const fix = document.createElement('div');
    fix.className = 'msg-fix';
    fix.hidden = true;
    // 失敗的 @ 指定回覆可以一鍵重試;能不能重試由 orchestrator 決定(message.retryable)
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'small retry-btn';
    retry.hidden = true;
    // 「沒有人審查過這次改動」是這個產品最不希望被忽略的訊號,不能只靠標頭一個小徽章。
    const unreviewed = document.createElement('div');
    unreviewed.className = 'unreviewed-note';
    unreviewed.hidden = true;
    const usage = document.createElement('div');
    usage.className = 'usage';
    const statusLine = document.createElement('div');
    statusLine.className = 'bubble-status';
    statusLine.textContent = t('msg.streaming');
    bubble.append(head, reviewScope, thinking, activities, body, error, fix, retry, unreviewed, usage, statusLine);
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
    fix: el.querySelector<HTMLElement>('.msg-fix'),
    unreviewed: el.querySelector<HTMLElement>('.unreviewed-note'),
    reviewScope: el.querySelector<HTMLElement>('.review-scope') || insertReviewScope(el),
    retry: el.querySelector<HTMLButtonElement>('.retry-btn'),
    usage: el.querySelector<CachedEl>('.usage')!,
    statusLine: el.querySelector<CachedEl>('.bubble-status')!,
  };
}

// 這個版本之前建立的訊息節點沒有審查範圍列,補在標題列後面
function insertReviewScope(el: HTMLElement): HTMLElement {
  const scope = document.createElement('div');
  scope.className = 'review-scope';
  scope.hidden = true;
  el.querySelector<HTMLElement>('.bubble-head')!.after(scope);
  return scope;
}

// 「審查 Alice · 附上 3 個檔案的內容 · 另有 2 個沒附上」+ 可點的檔案名稱。
// 審查意見有多少分量,取決於審查者實際看到了什麼;看不到改動的審查要一眼看得出來。
const REVIEW_CHIPS_MAX = 6;
function renderReviewScope(slot: HTMLElement, review: ReviewInfo | undefined): void {
  slot.hidden = !review;
  if (!review) return;
  const key = JSON.stringify([review.target, review.access, review.scope, review.files, review.more, review.omitted, review.unreadable, getLocale()]);
  if (slot.dataset.key === key) return;
  slot.dataset.key = key;
  slot.textContent = '';
  slot.dataset.scope = review.scope;
  const unreadable = review.unreadable || [];
  const attached = Math.max(0, review.files.length - review.omitted.length - unreadable.length);
  const how = review.scope !== 'listed' ? t(`review.scope.${review.scope}`, { name: review.target })
    : review.access === 'open' ? t('review.scope.open')
      : t(review.access === 'tool' ? 'review.scope.tool' : 'review.scope.inline', { n: attached });
  const parts = [t('review.scope.target', { name: review.target }), how];
  if (review.scope === 'listed' && review.access !== 'open' && review.omitted.length) parts.push(t('review.scope.omitted', { n: review.omitted.length }));
  if (review.scope === 'listed' && review.access !== 'open' && unreadable.length) parts.push(t('review.scope.unreadable', { n: unreadable.length }));
  const line = document.createElement('span');
  line.className = 'review-scope-text';
  line.textContent = parts.join(' · ');
  slot.appendChild(line);
  if (!review.files.length) return;
  const chips = document.createElement('span');
  chips.className = 'review-files';
  for (const file of review.files.slice(0, REVIEW_CHIPS_MAX)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'review-file';
    // 沒附上內容、讀不到的檔案要看得出來:審查者對它的判斷沒有根據
    const omitted = review.access !== 'open' && review.omitted.includes(file);
    const missing = review.access !== 'open' && unreadable.includes(file);
    if (omitted || missing) chip.classList.add('omitted');
    chip.textContent = file;
    chip.title = t(missing ? 'review.fileUnreadableTitle' : omitted ? 'review.fileOmittedTitle' : 'review.fileTitle');
    chip.onclick = () => { void openDiff(file); };
    chips.appendChild(chip);
  }
  const rest = review.files.length - REVIEW_CHIPS_MAX + review.more;
  if (rest > 0) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'review-file more';
    more.textContent = t('review.scope.more', { n: rest });
    more.onclick = () => { void openDiff(); };
    chips.appendChild(more);
  }
  slot.appendChild(chips);
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
  if (hasNumber(u.costUsd)) parts.push(t('usage.knownCost', { n: numeric(u.costUsd).toFixed(3) }));
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
  const costs = summarizeCosts(messageData.values());
  if (costs.costUsd !== null) {
    compact.push(t('usage.knownCost', { n: costs.costUsd.toFixed(3) }));
    if (costs.turnsWithCost < costs.turns) compact.push(t('usage.costCoverage', { a: costs.turnsWithCost, b: costs.turns }), t('usage.costMissing', { n: costs.turns - costs.turnsWithCost }));
  }
  if (unknownTurns) compact.push(t('usage.unknownTurns', { n: unknownTurns }));

  const details = [];
  for (const [key, metric] of Object.entries(metrics)) {
    if (!metric.turns) continue;
    const total = exactNumber(metric.total);
    details.push(t('usage.detail', { label: t(`usage.label.${key}`), total, a: metric.agents.size, b: usageAgents.size, c: metric.turns, d: usageTurns }));
  }
  if (unknownTurns) details.push(t('usage.unknownDetail', { a: unknownTurns, b: usageTurns }));
  if (costs.costUsd !== null) details.push(t('usage.knownCost', { n: costs.costUsd.toFixed(6) }), t('task.costTitle'));
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

init();
