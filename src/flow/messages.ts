// 訊息的轉換與還原:adapter 的工具紀錄 → 稽核紀錄、從存檔還原訊息
import crypto from 'crypto';
import { tx, joinNames } from '../text';
import type { TextLocale } from '../text';
import type { ChatMessage, ReviewInfo, ToolAuditEntry } from '../ipc-types';
import type { LiveMessage } from './types';
import { REVIEW_FILES_MAX } from './review';
import { restoreTaskSummary } from './task-summary';

const MESSAGE_KINDS = new Set(['user', 'agent', 'system']);

// adapter 回傳的工具紀錄 → 稽核紀錄。
// 這裡是唯一會碰到 adapter 內部形狀的地方,刻意放在轉換層:file-tools 的欄位改名時
// 只需要改這一個函式,orchestrator 與介面看到的形狀不變。
export function toAuditEntries(raw: unknown): ToolAuditEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((e: any) => {
    const r = e?.result || {};
    const entry: ToolAuditEntry = { tool: e?.name || '', ok: !!e?.ok };
    if (e?.path) entry.path = e.path;
    if (r.error) entry.error = r.error;
    // 寫入類工具回傳 newSha256;read_file 回傳 sha256(它就是之後寫入要帶的 expectedSha256)
    if (r.newSha256) entry.shaAfter = r.newSha256;
    else if (r.sha256) entry.shaAfter = r.sha256;
    if (r.shaBefore) entry.shaBefore = r.shaBefore;
    if (typeof r.added === 'number') entry.added = r.added;
    if (typeof r.removed === 'number') entry.removed = r.removed;
    // 近似旗標一定要跟著數字走。少了它,退化成整檔行數的統計看起來仍然精確,
    // 審查者會拿一個高估好幾個數量級的數字當事實。
    if (r.statsApproximate) entry.statsApproximate = true;
    if (typeof r.replacements === 'number') entry.replacements = r.replacements;
    if (r.reason) entry.reason = r.reason;
    if (r.replaced) entry.replaced = r.replaced;
    return entry;
  });
}

// 「[使用者 → @Codex]」:讓每位成員都看得出這則訊息指定給誰
export function mentionLabel(m: ChatMessage, locale: TextLocale = 'zh-Hant') {
  const names = Array.isArray(m.mentions) ? m.mentions.map((x) => x && x.name).filter(Boolean) : [];
  return names.length ? ` → ${joinNames(locale, names.map((n) => `@${n}`))}` : '';
}

// 從紀錄還原訊息:補齊欄位;存檔時還在輸出中的訊息不可能再完成,標成中斷
export function restoreMessage(m: any, locale: TextLocale = 'zh-Hant'): LiveMessage {
  const kind: ChatMessage['kind'] = MESSAGE_KINDS.has(m.kind) ? m.kind : 'system';
  const msg: LiveMessage = {
    ...m,
    id: typeof m.id === 'string' && m.id ? m.id : crypto.randomUUID(),
    kind,
    text: typeof m.text === 'string' ? m.text : String(m.text ?? ''),
    thinking: typeof m.thinking === 'string' ? m.thinking : '',
    activities: Array.isArray(m.activities) ? m.activities : [],
    status: m.status === 'error' ? 'error' : 'done',
  };
  if (m.status === 'running') { msg.status = 'error'; msg.error = m.error || tx(locale, 'sys.unfinishedOnSave'); }
  // 載入的歷史對話不提供重試:附件與 CLI 的 session 都已經跟當時不同,重跑的不是同一件事
  msg.retryable = false;
  // 修復建議是當下的環境狀態,不是紀錄的一部分:存檔之後可能早就修好了,
  // 而紀錄檔可能被手動改過——不能讓它決定按鈕上填進終端的指令
  delete (msg as { fix?: unknown }).fix;
  const review = restoreReviewInfo(m.review);
  if (review) msg.review = review; else delete msg.review;
  if (m.rawPlan === true) msg.rawPlan = true; else delete msg.rawPlan;
  const summary = restoreTaskSummary(m.taskSummary);
  if (summary) msg.taskSummary = summary; else delete msg.taskSummary;
  return msg;
}

// 紀錄檔可能被手動改過或來自舊版本:形狀不對就整個丟掉,介面不顯示,也不會壞掉
const REVIEW_ACCESS = new Set(['open', 'tool', 'inline']);
const REVIEW_SCOPES = new Set(['listed', 'none', 'untouched', 'unknown', 'readonly']);
const REVIEW_VERDICTS = new Set(['pass', 'issues', 'failed']);
function restoreReviewInfo(raw: any): ReviewInfo | null {
  if (!raw || typeof raw !== 'object' || typeof raw.target !== 'string' || !raw.target.trim()) return null;
  if (!REVIEW_ACCESS.has(raw.access) || !REVIEW_SCOPES.has(raw.scope)) return null;
  const paths = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.trim() !== ''))] : []);
  const files = paths(raw.files).slice(0, REVIEW_FILES_MAX);
  // 沒附上 / 讀不到的一定是清單裡的檔案,而且兩者不重疊;否則「附上 -1 個檔案」這種話就會出現
  const omitted = paths(raw.omitted).filter((f) => files.includes(f));
  const unreadable = paths(raw.unreadable).filter((f) => files.includes(f) && !omitted.includes(f));
  return {
    target: raw.target,
    access: raw.access,
    scope: raw.scope,
    files,
    more: Number.isInteger(raw.more) && raw.more > 0 ? raw.more : 0,
    omitted,
    unreadable,
    ...(REVIEW_VERDICTS.has(raw.verdict) ? { verdict: raw.verdict } : {}),
    ...(raw.recheck === true ? { recheck: true } : {}),
  };
}
