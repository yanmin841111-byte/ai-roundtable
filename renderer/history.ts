// 歷史對話面板與預覽視窗。
import { t, joinNames, localeTag } from './i18n';
import { $, escapeHtml, cleanIpcError } from './util';
import type { AttachmentMeta, ChatMessage, ChatState, PhaseValue, SessionSummary, UsageInfo } from './api';

export interface HistoryOptions {
  running: () => boolean;
  md: (text: string) => string;
  phaseText: (phase: PhaseValue | undefined | null) => string;
  usageText: (usage: UsageInfo | null | undefined) => string;
  attachmentsMarkup: (list: AttachmentMeta[] | undefined) => string;
  hydrateAttachmentThumbs: (root: HTMLElement | null, list: AttachmentMeta[] | undefined) => void;
  onResumed: (payload: { id: string; messages: ChatMessage[]; snapshot: ChatState }) => Promise<void>;
}

let opts: HistoryOptions | null = null;
let historyLoaded = false;
let historySessions: SessionSummary[] = [];
let openHistoryId: string | null = null;
let activeSessionId: string | null = null;
const historyErrors = new Map<string, string>();

export function setupHistory(options: HistoryOptions): void {
  opts = options;
  $<HTMLButtonElement>('#history-toggle').onclick = () => { void toggleHistory(); };
  $<HTMLButtonElement>('#history-refresh').onclick = () => { void loadHistory(true); };
  document.getElementById('history-search')?.addEventListener('input', renderHistoryList);
  $<HTMLButtonElement>('#history-modal-close').onclick = closeHistoryModal;
  $<HTMLButtonElement>('#history-resume').onclick = () => { void resumeHistory(); };
}

export function setActiveSessionId(id: string | null): void {
  activeSessionId = id;
}

export function getActiveSessionId(): string | null {
  return activeSessionId;
}

export function isHistoryLoaded(): boolean {
  return historyLoaded;
}

export function refreshHistoryUI(): void {
  if (historyLoaded) renderHistoryList();
  if (openHistoryId) updateResumeButton();
}

export async function toggleHistory(): Promise<void> {
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

export async function loadHistory(force = false, { quiet = false }: { quiet?: boolean } = {}): Promise<void> {
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

export function renderHistoryList(): void {
  const list = $<HTMLDivElement>('#history-list');
  const searchEl = document.getElementById('history-search') as HTMLInputElement | null;
  list.innerHTML = '';
  if (searchEl) searchEl.hidden = historySessions.length < 3 && !searchEl.value.trim();
  if (!historySessions.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = t('history.empty');
    list.appendChild(empty);
    return;
  }
  const query = (searchEl?.value || '').trim().toLowerCase();
  const visible = query
    ? historySessions.filter((s) => {
      const hay = [s.title || '', ...(Array.isArray(s.agents) ? s.agents : [])].join(' ').toLowerCase();
      return hay.includes(query);
    })
    : historySessions;
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = t('history.noMatch');
    list.appendChild(empty);
    return;
  }
  for (const session of visible) {
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
    main.onclick = () => { void openHistory(session); };
    const remove = document.createElement('button');
    remove.className = 'history-delete';
    remove.title = t('history.delete');
    remove.textContent = '✕';
    remove.onclick = () => { void removeHistory(session); };
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
  if (!opts) return;
  const preview = $<HTMLDivElement>('#history-preview');
  preview.innerHTML = '';
  const list = Array.isArray(messages) ? messages : [];
  for (const rawMessage of list) {
    const message: Partial<ChatMessage> = rawMessage && typeof rawMessage === 'object'
      ? rawMessage as Partial<ChatMessage>
      : { kind: 'system', text: rawMessage == null ? '' : String(rawMessage) };
    const card = document.createElement('article');
    card.className = `history-message ${message.kind || 'system'} ${message.level || ''}`;
    const head = document.createElement('div');
    head.className = 'history-message-head';
    const who = message.kind === 'user' ? t('who.user') : message.kind === 'agent' ? (message.agentName || t('who.agent')) : t('who.system');
    head.textContent = [who, opts.phaseText(message.phase), message.model, formatHistoryTime(message.ts)].filter(Boolean).join(' · ');
    const body = document.createElement('div');
    body.className = 'body';
    body.innerHTML = opts.md(String(message.text || ''));
    card.append(head, body);
    if (Array.isArray(message.attachments) && message.attachments.length) {
      const wrap = document.createElement('div');
      wrap.innerHTML = opts.attachmentsMarkup(message.attachments);
      if (wrap.firstChild) card.appendChild(wrap.firstChild);
      opts.hydrateAttachmentThumbs(card, message.attachments);
    }
    if (message.error) {
      const error = document.createElement('div');
      error.className = 'error-text';
      error.textContent = `⚠ ${message.error}`;
      card.appendChild(error);
    }
    const usage = opts.usageText(message.usage);
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

export function updateResumeButton(): void {
  if (!openHistoryId) return;
  const isRunning = opts ? opts.running() : false;
  const button = $<HTMLButtonElement>('#history-resume');
  const hint = $('#history-resume-hint');
  const current = !!openHistoryId && openHistoryId === activeSessionId;
  button.disabled = isRunning || current;
  button.textContent = current ? t('history.current') : t('history.resume');
  hint.textContent = isRunning ? t('history.hintRunning') : current ? t('history.hintCurrent') : t('history.hintResume');
}

async function resumeHistory(): Promise<void> {
  if (!opts) return;
  const id = openHistoryId;
  if (!id || opts.running()) return;
  const button = $<HTMLButtonElement>('#history-resume');
  button.disabled = true;
  try {
    const result = await window.api.resume(id);
    if (!result || !result.ok) throw new Error((result && result.error) || t('history.resumeFailed'));
    await opts.onResumed({
      id: result.id,
      messages: (result.snapshot && result.snapshot.messages) || [],
      snapshot: result.snapshot || { running: false },
    });
    closeHistoryModal();
    renderHistoryList();
  } catch (error) {
    $('#history-resume-hint').textContent = t('history.loadError', { reason: cleanIpcError(error) });
    button.disabled = false;
  }
}

export function closeHistoryModal(): void {
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
