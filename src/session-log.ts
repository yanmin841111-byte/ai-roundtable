import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { deleteConversation } from './attachments';
import type { ChatMessage, OkResult, PhaseValue, SessionReadResult, SessionSummary } from './ipc-types';
import { tx } from './text';
import type { TextLocale } from './text';

type WriteSessionResult = { ok: true; file: string; id: string } | { ok: false; file: null; error: string };

// 磁碟上的紀錄可能是舊格式或被手動改壞,訊息的欄位一律當作可能缺漏
type LooseMessage = Partial<ChatMessage> | null | undefined;

interface Envelope {
  version: number;
  createdAt: string;
  title: string;
  agents: string[];
  conversationId: string | null;
  // 沒有逐則驗證;載入繼續討論時由 orchestrator 的 restoreMessage 補齊欄位
  messages: ChatMessage[];
}

type EnvelopeResult = { ok: true; envelope: Envelope } | { ok: false; error: string };

type Logger = { error(message: string): void };

// Array.isArray 會把唯讀陣列收窄成 any[],包一層保住元素型別
function asList<T>(value: readonly T[]): readonly T[] {
  return Array.isArray(value) ? value : [];
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const ENVELOPE_VERSION = 1;
const TITLE_MAX = 80;
const LIST_LIMIT = 50;
// 檔名白名單:只接受單一檔名,不含任何目錄成分
const ID_PATTERN = /^[\w.-]+\.json$/;

function report(logger: Logger | null | undefined, message: string) {
  try { (logger || console).error(message); } catch {}
}

const sessionsDir = (userDataDir: string) => path.join(userDataDir, 'sessions');

// 全 app 唯一一條「使用者輸入 → 讀檔／刪檔」的通道,所以三層都要過:
//   1. basename 砍掉所有目錄成分('../../x.json' → 'x.json')
//   2. 白名單正規式(擋掉空字串、'.'、'..'、非 .json)
//   3. 解析後的 dirname 必須嚴格等於 sessions 目錄
// 任何一層不過就回傳 null,呼叫端不得碰任何檔案。
function resolveSessionPath(userDataDir: string, id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const dir = path.resolve(sessionsDir(userDataDir));
  const name = path.basename(id);
  if (name !== id) return null;          // 帶了目錄成分就直接拒絕,不要默默修正
  if (!ID_PATTERN.test(name)) return null;
  const full = path.resolve(dir, name);
  if (path.dirname(full) !== dir) return null;
  return full;
}

// 第一則使用者訊息的開頭當標題;沒有就退回第一則有文字的訊息
function deriveTitle(messages: readonly LooseMessage[]) {
  const list = asList(messages);
  const first = list.find((m) => m && m.kind === 'user' && m.text) || list.find((m) => m && m.text);
  const text = String((first && first.text) || '').replace(/\s+/g, ' ').trim();
  // 回空字串,交給介面顯示在地化的「未命名對話」。後端塞一個寫死的中文佔位字串,
  // 會讓 renderer 的在地化備援永遠用不到,英文介面就看到「(無標題)」。
  if (!text) return '';
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text;
}

// 附件目錄名就是 conversationId。舊檔沒有這個欄位時從 relPath 的第一段還原,
// 這樣即使 envelope 少了欄位,刪對話還是能連動清掉附件。
function deriveConversationId(messages: readonly LooseMessage[]): string | null {
  for (const m of asList(messages)) {
    const attachments = m?.attachments;
    for (const a of Array.isArray(attachments) ? attachments : []) {
      const first = typeof a?.relPath === 'string' ? a.relPath.split('/')[0] : '';
      if (first) return first;
    }
  }
  return null;
}

function deriveAgents(messages: readonly LooseMessage[]) {
  const names: string[] = [];
  for (const m of asList(messages)) {
    if (m && m.kind === 'agent' && m.agentName && !names.includes(m.agentName)) names.push(m.agentName);
  }
  return names;
}

// 只看第一則訊息的 ts。不要「往後找第一則有 ts 的」——後面那些訊息的時間點
// 和對話開始時間沒有必然關係,拿來當 createdAt 會給出比檔案本身還離譜的值。
function deriveCreatedAt(messages: readonly LooseMessage[], fallback: unknown) {
  const first = asList(messages)[0];
  const date = first && first.ts != null ? new Date(first.ts) : null;
  if (date && !Number.isNaN(date.getTime())) return date.toISOString();
  const back = fallback instanceof Date && !Number.isNaN(fallback.getTime()) ? fallback : new Date();
  return back.toISOString();
}

// 舊版會把這個中文佔位字串寫進檔案當標題。讀到時當成「沒有標題」,介面才能依語言顯示。
const LEGACY_UNTITLED = '(無標題)';

// 解析錯誤存「鍵」而不是翻好的文字:readEnvelope 的結果依 mtime 快取,
// 存翻好的文字的話,切換語言後舊檔的錯誤還會是上一個語言。輸出給介面時才翻。
const localizeError = (error: string, locale: TextLocale): string =>
  /^session\.[A-Za-z]+$/.test(error) ? tx(locale, error) : error;

// 清單是先前讀的,使用者點下去時那份檔案可能已經被刪了。原本會把 Node 的
// ENOENT 原文(含完整路徑)直接顯示在介面上。
const missingOr = (error: unknown, locale: TextLocale): string =>
  (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? tx(locale, 'session.missing') : errorMessage(error);

// 舊檔是純陣列,新檔是 envelope;兩者都包成同一個形狀,不批次改寫舊檔
function toEnvelope(parsed: any, fallbackDate: Date): Envelope {
  if (Array.isArray(parsed)) {
    return {
      version: ENVELOPE_VERSION,
      createdAt: deriveCreatedAt(parsed, fallbackDate),
      title: deriveTitle(parsed),
      agents: deriveAgents(parsed),
      conversationId: deriveConversationId(parsed),
      messages: parsed,
    };
  }
  // 任意一份合法 JSON 都不該被當成「空對話」列在清單裡,所以 messages 必須真的是陣列
  if (!parsed || typeof parsed !== 'object') throw new Error('session.notTranscript');
  if (!Array.isArray(parsed.messages)) throw new Error('session.noMessages');
  const messages = parsed.messages;
  return {
    version: Number.isFinite(parsed.version) ? parsed.version : ENVELOPE_VERSION,
    createdAt: parsed.createdAt || deriveCreatedAt(messages, fallbackDate),
    title: (parsed.title && parsed.title !== LEGACY_UNTITLED ? parsed.title : '') || deriveTitle(messages),
    agents: Array.isArray(parsed.agents) ? parsed.agents : deriveAgents(messages),
    conversationId: parsed.conversationId || deriveConversationId(messages),
    messages,
  };
}

// 寫入同一目錄的暫存檔後 rename，避免留下只寫了一半的 session。
// 所有錯誤都轉成回傳值，呼叫端不需要為記錄失敗中止任務。
// 帶 id 時覆寫同一份紀錄(同一段對話持續累積、載入歷史後繼續討論),否則新建一份。
function writeSession(
  userDataDir: string,
  messages: readonly ChatMessage[],
  { now, logger, conversationId, id }: { now?: unknown; logger?: Logger; conversationId?: string | null; id?: string | null } = {},
): WriteSessionResult {
  // 連檔名與 envelope 的組裝都要在 try 裡:呼叫端傳進壞掉的 now 或 userDataDir 時,
  // 這裡一樣只能回傳錯誤,絕不能讓記錄失敗把整個任務炸掉。
  let tmp: string | null = null;
  try {
    const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    const dir = sessionsDir(userDataDir);
    const stamp = at.toISOString().replace(/[:.]/g, '-');
    const existing = id == null ? null : resolveSessionPath(userDataDir, id);
    if (id != null && !existing) throw new Error('無效的紀錄代號');
    const file = existing || path.join(dir, `${stamp}-${crypto.randomUUID()}.json`);
    tmp = `${file}.tmp`;
    const list = asList(messages);
    const envelope: Envelope = {
      version: ENVELOPE_VERSION,
      createdAt: deriveCreatedAt(list, at),
      title: deriveTitle(list),
      agents: deriveAgents(list),
      // 附件存在 userData/attachments/<conversationId>/,刪這份紀錄時要連動清掉
      conversationId: conversationId || deriveConversationId(list),
      messages: [...list],
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, file, id: path.basename(file) };
  } catch (error) {
    if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch {} }
    report(logger, `無法儲存對話紀錄: ${errorMessage(error)}`);
    return { ok: false, file: null, error: errorMessage(error) };
  }
}

// 依 (檔案路徑, mtimeMs) 快取解析結果,檔案沒變就不重讀。
// 和 src/models.js 的模型快取是同一個模式。
const parseCache = new Map<string, { mtimeMs: number; result: EnvelopeResult }>();

function readEnvelope(full: string, stat: fs.Stats): EnvelopeResult {
  const cached = parseCache.get(full);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.result;
  let result: EnvelopeResult;
  try {
    result = { ok: true, envelope: toEnvelope(JSON.parse(fs.readFileSync(full, 'utf8')), stat.mtime) };
  } catch (error) {
    result = { ok: false, error: errorMessage(error) };
  }
  parseCache.set(full, { mtimeMs: stat.mtimeMs, result });
  return result;
}

// 列出最近的對話。排序只看 mtime(不讀內容),只解析最新的 limit 筆。
// 單一檔案壞掉時該筆降級顯示,不讓整份清單失效。
function listSessions(userDataDir: string, { limit = LIST_LIMIT, locale = 'zh-Hant' }: { limit?: number; locale?: TextLocale } = {}): { sessions: SessionSummary[]; error?: string } {
  const dir = sessionsDir(userDataDir);
  let entries: Array<{ name: string; stat: fs.Stats }>;
  try {
    entries = fs.readdirSync(dir)
      .filter((name) => ID_PATTERN.test(name))
      .map((name) => {
        try {
          const stat = fs.statSync(path.join(dir, name));
          return stat.isFile() ? { name, stat } : null;
        } catch { return null; }
      })
      .filter((entry) => entry !== null)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  } catch (error) {
    // 目錄還不存在只代表沒有紀錄,不是錯誤
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sessions: [] };
    return { sessions: [], error: errorMessage(error) };
  }

  const sessions = entries.slice(0, Math.max(0, limit)).map(({ name, stat }): SessionSummary => {
    const base = { id: name, size: stat.size, createdAt: stat.mtime.toISOString() };
    const parsed = readEnvelope(path.join(dir, name), stat);
    // 標題留空,由介面依語言顯示「無法讀取」;錯誤原因在 error 欄位
    if (!parsed.ok) return { ...base, title: '', agents: [], messageCount: 0, error: localizeError(parsed.error, locale) };
    const e = parsed.envelope;
    const attachmentCount = e.messages.reduce((n, m: LooseMessage) => n + (Array.isArray(m?.attachments) ? m.attachments.length : 0), 0);
    return { ...base, title: e.title, agents: e.agents, createdAt: e.createdAt, messageCount: e.messages.length, conversationId: e.conversationId || null, attachmentCount };
  });
  return { sessions };
}

function readSession(userDataDir: string, id: unknown, locale: TextLocale = 'zh-Hant'): SessionReadResult {
  const full = resolveSessionPath(userDataDir, id);
  if (!full) return { ok: false, error: tx(locale, 'session.badId') };
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile()) return { ok: false, error: tx(locale, 'session.badId') };
    const parsed = readEnvelope(full, stat);
    return parsed.ok ? { ok: true, session: parsed.envelope } : { ok: false, error: localizeError(parsed.error, locale) };
  } catch (error) {
    return { ok: false, error: missingOr(error, locale) };
  }
}

function deleteSession(userDataDir: string, id: unknown, locale: TextLocale = 'zh-Hant'): OkResult {
  const full = resolveSessionPath(userDataDir, id);
  if (!full) return { ok: false, error: tx(locale, 'session.badId') };
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile()) return { ok: false, error: tx(locale, 'session.badId') };
    // 先讀出 conversationId 再刪檔:檔案沒了就查不到要清哪個附件目錄
    const parsed = readEnvelope(full, stat);
    const conversationId = parsed.ok ? parsed.envelope.conversationId : null;
    fs.rmSync(full);
    parseCache.delete(full);
    // 同一個 conversation 可能分段寫成多份 session;最後一份刪除後才能清附件。
    if (conversationId && !listConversationIds(userDataDir).includes(conversationId)) deleteConversation(userDataDir, conversationId);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: missingOr(error, locale) };
  }
}

// 給孤兒清理用:掃出所有已經寫進 session 的 conversationId,這些附件不能被清掉
function listConversationIds(userDataDir: string): string[] {
  const dir = sessionsDir(userDataDir);
  const ids = new Set<string>();
  let names: string[];
  try { names = fs.readdirSync(dir).filter((name) => ID_PATTERN.test(name)); } catch { return []; }
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      const parsed = readEnvelope(full, stat);
      if (parsed.ok && parsed.envelope.conversationId) ids.add(parsed.envelope.conversationId);
    } catch {}
  }
  return [...ids];
}

function formatTime(ts: string | number | undefined, locale: TextLocale) {
  const unknown = tx(locale, 'export.timeUnknown');
  if (ts == null) return unknown;
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? unknown : date.toLocaleString(locale === 'en' ? 'en-US' : 'zh-TW', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZoneName: 'short',
  });
}

function messageTitle(message: ChatMessage, locale: TextLocale) {
  if (message.kind === 'user') return tx(locale, 'export.user');
  if (message.kind === 'agent') return message.agentName || tx(locale, 'export.agent');
  return tx(locale, message.level === 'error' ? 'export.systemError' : message.level === 'warn' ? 'export.systemWarn' : 'export.system');
}

function hasNumber(value: unknown) { return value != null && Number.isFinite(Number(value)); }

function rawValue(value: unknown) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value == null || typeof value !== 'object') return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function usageMarkdown(usage: any, locale: TextLocale = 'zh-Hant'): string {
  if (!usage || typeof usage !== 'object') return '';
  if (!usage.shape || usage.shape === 'unknown') {
    const raw = usage.raw && typeof usage.raw === 'object' ? usage.raw : usage;
    const fields = Object.entries(raw)
      .filter(([key]) => !['shape', 'raw'].includes(key))
      .map(([key, value]) => `${key}: ${rawValue(value)}`);
    return tx(locale, 'export.rawUsage', { fields: fields.length ? fields.join(' · ') : tx(locale, 'export.noFields') });
  }
  const fields: string[] = [];
  if (hasNumber(usage.inputTokens)) {
    const detail: string[] = [];
    if (hasNumber(usage.cachedInputTokens)) detail.push(tx(locale, 'export.cached', { n: usage.cachedInputTokens }));
    if (hasNumber(usage.cacheWriteTokens)) detail.push(tx(locale, 'export.cacheWrite', { n: usage.cacheWriteTokens }));
    fields.push(`${tx(locale, 'export.input', { n: usage.inputTokens })}${detail.length ? (locale === 'en' ? ` (${detail.join(', ')})` : `（${detail.join('、')}）`) : ''}`);
  } else {
    if (hasNumber(usage.cachedInputTokens)) fields.push(tx(locale, 'export.cachedInput', { n: usage.cachedInputTokens }));
    if (hasNumber(usage.cacheWriteTokens)) fields.push(tx(locale, 'export.cacheWrite', { n: usage.cacheWriteTokens }));
  }
  if (hasNumber(usage.outputTokens)) fields.push(tx(locale, 'export.output', { n: usage.outputTokens }));
  if (hasNumber(usage.costUsd)) fields.push(tx(locale, 'export.cost', { n: Number(usage.costUsd).toFixed(3) }));
  return fields.length ? tx(locale, 'export.usage', { fields: fields.join(' · ') }) : '';
}

// 匯出用的 phase 文字。phase 現在是 { code, round, maxRounds } 結構,
// 舊紀錄則是純字串,兩種都要能印。
const PHASE_CODES = new Set(['idle', 'direct', 'discuss', 'divide', 'execute', 'review', 'repair', 'summary']);

function phaseToText(phase: PhaseValue | null | undefined, locale: TextLocale): string {
  if (!phase) return '';
  if (typeof phase === 'string') return phase; // 舊 session
  const label = PHASE_CODES.has(phase.code) ? tx(locale, `phase.${phase.code}`) : phase.code || '';
  return phase.round ? `${label} R${phase.round}` : label;
}

function messagesToMarkdown(messages: readonly ChatMessage[], locale: TextLocale = 'zh-Hant') {
  const sections = [tx(locale, 'export.title')];
  for (const message of asList(messages)) {
    const meta = [phaseToText(message.phase, locale), message.model, formatTime(message.ts, locale)].filter(Boolean).join(' · ');
    sections.push(`## ${messageTitle(message, locale)}${meta ? ` · ${meta}` : ''}`);
    const usage = usageMarkdown(message.usage, locale);
    if (usage) sections.push(usage);
    if (Array.isArray(message.attachments) && message.attachments.length) {
      sections.push(tx(locale, 'export.attachments', { list: message.attachments.map((a) => (locale === 'en' ? `${a.name} (${a.mime})` : `${a.name}（${a.mime}）`)).join(locale === 'en' ? ', ' : '、') }));
    }
    if (message.text) sections.push(String(message.text));
    // 「沒有人審查過這次改動」是整份紀錄最重要的品質訊號。匯出後通常是寄給別人看的,
    // 漏掉它,讀的人會把「流程跑完了」讀成「有人檢查過了」。
    if (message.unreviewed) sections.push(tx(locale, 'export.unreviewed'));
    if (message.error) sections.push(tx(locale, 'export.error', { text: String(message.error).replace(/\n/g, '\n> ') }));
    const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;
    if (!message.text && !message.error && !hasAttachments) sections.push(tx(locale, 'export.empty'));
  }
  return `${sections.join('\n\n')}\n`;
}

export { writeSession, listSessions, readSession, deleteSession, listConversationIds, messagesToMarkdown, usageMarkdown, resolveSessionPath };
