'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { deleteConversation } = require('./attachments');

const ENVELOPE_VERSION = 1;
const TITLE_MAX = 80;
const LIST_LIMIT = 50;
// 檔名白名單:只接受單一檔名,不含任何目錄成分
const ID_PATTERN = /^[\w.-]+\.json$/;

function report(logger, message) {
  try { (logger || console).error(message); } catch {}
}

const sessionsDir = (userDataDir) => path.join(userDataDir, 'sessions');

// 全 app 唯一一條「使用者輸入 → 讀檔／刪檔」的通道,所以三層都要過:
//   1. basename 砍掉所有目錄成分('../../x.json' → 'x.json')
//   2. 白名單正規式(擋掉空字串、'.'、'..'、非 .json)
//   3. 解析後的 dirname 必須嚴格等於 sessions 目錄
// 任何一層不過就回傳 null,呼叫端不得碰任何檔案。
function resolveSessionPath(userDataDir, id) {
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
function deriveTitle(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const first = list.find((m) => m && m.kind === 'user' && m.text) || list.find((m) => m && m.text);
  const text = String((first && first.text) || '').replace(/\s+/g, ' ').trim();
  if (!text) return '(無標題)';
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text;
}

// 附件目錄名就是 conversationId。舊檔沒有這個欄位時從 relPath 的第一段還原,
// 這樣即使 envelope 少了欄位,刪對話還是能連動清掉附件。
function deriveConversationId(messages) {
  for (const m of Array.isArray(messages) ? messages : []) {
    for (const a of Array.isArray(m && m.attachments) ? m.attachments : []) {
      const first = typeof a?.relPath === 'string' ? a.relPath.split('/')[0] : '';
      if (first) return first;
    }
  }
  return null;
}

function deriveAgents(messages) {
  const names = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m && m.kind === 'agent' && m.agentName && !names.includes(m.agentName)) names.push(m.agentName);
  }
  return names;
}

// 只看第一則訊息的 ts。不要「往後找第一則有 ts 的」——後面那些訊息的時間點
// 和對話開始時間沒有必然關係,拿來當 createdAt 會給出比檔案本身還離譜的值。
function deriveCreatedAt(messages, fallback) {
  const first = Array.isArray(messages) ? messages[0] : null;
  const date = first && first.ts != null ? new Date(first.ts) : null;
  if (date && !Number.isNaN(date.getTime())) return date.toISOString();
  const back = fallback instanceof Date && !Number.isNaN(fallback.getTime()) ? fallback : new Date();
  return back.toISOString();
}

// 舊檔是純陣列,新檔是 envelope;兩者都包成同一個形狀,不批次改寫舊檔
function toEnvelope(parsed, fallbackDate) {
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
  if (!parsed || typeof parsed !== 'object') throw new Error('內容不是對話紀錄');
  if (!Array.isArray(parsed.messages)) throw new Error('內容不是對話紀錄:缺少 messages 陣列');
  const messages = parsed.messages;
  return {
    version: Number.isFinite(parsed.version) ? parsed.version : ENVELOPE_VERSION,
    createdAt: parsed.createdAt || deriveCreatedAt(messages, fallbackDate),
    title: parsed.title || deriveTitle(messages),
    agents: Array.isArray(parsed.agents) ? parsed.agents : deriveAgents(messages),
    conversationId: parsed.conversationId || deriveConversationId(messages),
    messages,
  };
}

// 寫入同一目錄的暫存檔後 rename，避免留下只寫了一半的 session。
// 所有錯誤都轉成回傳值，呼叫端不需要為記錄失敗中止任務。
function writeSession(userDataDir, messages, { now, logger, conversationId } = {}) {
  // 連檔名與 envelope 的組裝都要在 try 裡:呼叫端傳進壞掉的 now 或 userDataDir 時,
  // 這裡一樣只能回傳錯誤,絕不能讓記錄失敗把整個任務炸掉。
  let tmp = null;
  try {
    const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    const dir = sessionsDir(userDataDir);
    const stamp = at.toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${stamp}-${crypto.randomUUID()}.json`);
    tmp = `${file}.tmp`;
    const list = Array.isArray(messages) ? messages : [];
    const envelope = {
      version: ENVELOPE_VERSION,
      createdAt: deriveCreatedAt(list, at),
      title: deriveTitle(list),
      agents: deriveAgents(list),
      // 附件存在 userData/attachments/<conversationId>/,刪這份紀錄時要連動清掉
      conversationId: conversationId || deriveConversationId(list),
      messages: list,
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, file };
  } catch (error) {
    if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch {} }
    report(logger, `無法儲存對話紀錄: ${error.message}`);
    return { ok: false, file: null, error: error.message };
  }
}

// 依 (檔案路徑, mtimeMs) 快取解析結果,檔案沒變就不重讀。
// 和 src/models.js 的模型快取是同一個模式。
const parseCache = new Map();

function readEnvelope(full, stat) {
  const cached = parseCache.get(full);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.result;
  let result;
  try {
    result = { ok: true, envelope: toEnvelope(JSON.parse(fs.readFileSync(full, 'utf8')), stat.mtime) };
  } catch (error) {
    result = { ok: false, error: error.message };
  }
  parseCache.set(full, { mtimeMs: stat.mtimeMs, result });
  return result;
}

// 列出最近的對話。排序只看 mtime(不讀內容),只解析最新的 limit 筆。
// 單一檔案壞掉時該筆降級顯示,不讓整份清單失效。
function listSessions(userDataDir, { limit = LIST_LIMIT } = {}) {
  const dir = sessionsDir(userDataDir);
  let entries;
  try {
    entries = fs.readdirSync(dir)
      .filter((name) => ID_PATTERN.test(name))
      .map((name) => {
        try {
          const stat = fs.statSync(path.join(dir, name));
          return stat.isFile() ? { name, stat } : null;
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  } catch (error) {
    // 目錄還不存在只代表沒有紀錄,不是錯誤
    if (error.code === 'ENOENT') return { sessions: [] };
    return { sessions: [], error: error.message };
  }

  const sessions = entries.slice(0, Math.max(0, limit)).map(({ name, stat }) => {
    const base = { id: name, size: stat.size, createdAt: stat.mtime.toISOString() };
    const parsed = readEnvelope(path.join(dir, name), stat);
    if (!parsed.ok) return { ...base, title: '(無法讀取)', agents: [], messageCount: 0, error: parsed.error };
    const e = parsed.envelope;
    const attachmentCount = e.messages.reduce((n, m) => n + (Array.isArray(m.attachments) ? m.attachments.length : 0), 0);
    return { ...base, title: e.title, agents: e.agents, createdAt: e.createdAt, messageCount: e.messages.length, conversationId: e.conversationId || null, attachmentCount };
  });
  return { sessions };
}

function readSession(userDataDir, id) {
  const full = resolveSessionPath(userDataDir, id);
  if (!full) return { ok: false, error: '無效的紀錄代號' };
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile()) return { ok: false, error: '無效的紀錄代號' };
    const parsed = readEnvelope(full, stat);
    return parsed.ok ? { ok: true, session: parsed.envelope } : { ok: false, error: parsed.error };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function deleteSession(userDataDir, id) {
  const full = resolveSessionPath(userDataDir, id);
  if (!full) return { ok: false, error: '無效的紀錄代號' };
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile()) return { ok: false, error: '無效的紀錄代號' };
    // 先讀出 conversationId 再刪檔:檔案沒了就查不到要清哪個附件目錄
    const parsed = readEnvelope(full, stat);
    const conversationId = parsed.ok ? parsed.envelope.conversationId : null;
    fs.rmSync(full);
    parseCache.delete(full);
    // 同一個 conversation 可能分段寫成多份 session;最後一份刪除後才能清附件。
    if (conversationId && !listConversationIds(userDataDir).includes(conversationId)) deleteConversation(userDataDir, conversationId);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// 給孤兒清理用:掃出所有已經寫進 session 的 conversationId,這些附件不能被清掉
function listConversationIds(userDataDir) {
  const dir = sessionsDir(userDataDir);
  const ids = new Set();
  let names;
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

function formatTime(ts) {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? '時間不明' : date.toLocaleString('zh-TW', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZoneName: 'short',
  });
}

function messageTitle(message) {
  if (message.kind === 'user') return '使用者';
  if (message.kind === 'agent') return message.agentName || 'AI 成員';
  return message.level === 'error' ? '系統錯誤' : message.level === 'warn' ? '系統警告' : '系統';
}

function hasNumber(value) { return value != null && Number.isFinite(Number(value)); }

function rawValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value == null || typeof value !== 'object') return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function usageMarkdown(usage) {
  if (!usage || typeof usage !== 'object') return '';
  if (!usage.shape || usage.shape === 'unknown') {
    const raw = usage.raw && typeof usage.raw === 'object' ? usage.raw : usage;
    const fields = Object.entries(raw)
      .filter(([key]) => !['shape', 'raw'].includes(key))
      .map(([key, value]) => `${key}: ${rawValue(value)}`);
    return `> 原始用量：${fields.length ? fields.join(' · ') : '無欄位'}`;
  }
  const fields = [];
  if (hasNumber(usage.inputTokens)) {
    const detail = [];
    if (hasNumber(usage.cachedInputTokens)) detail.push(`其中快取 ${usage.cachedInputTokens}`);
    if (hasNumber(usage.cacheWriteTokens)) detail.push(`寫入快取 ${usage.cacheWriteTokens}`);
    fields.push(`輸入: ${usage.inputTokens}${detail.length ? `（${detail.join('、')}）` : ''}`);
  } else {
    if (hasNumber(usage.cachedInputTokens)) fields.push(`快取輸入: ${usage.cachedInputTokens}`);
    if (hasNumber(usage.cacheWriteTokens)) fields.push(`寫入快取: ${usage.cacheWriteTokens}`);
  }
  if (hasNumber(usage.outputTokens)) fields.push(`輸出: ${usage.outputTokens}`);
  if (hasNumber(usage.costUsd)) fields.push(`成本: $${Number(usage.costUsd).toFixed(3)}`);
  return fields.length ? `> 用量：${fields.join(' · ')}` : '';
}

function messagesToMarkdown(messages) {
  const sections = ['# AI Roundtable 對話'];
  for (const message of Array.isArray(messages) ? messages : []) {
    const meta = [message.phase, message.model, formatTime(message.ts)].filter(Boolean).join(' · ');
    sections.push(`## ${messageTitle(message)}${meta ? ` · ${meta}` : ''}`);
    const usage = usageMarkdown(message.usage);
    if (usage) sections.push(usage);
    if (Array.isArray(message.attachments) && message.attachments.length) {
      sections.push(`> 附件：${message.attachments.map((a) => `${a.name}（${a.mime}）`).join('、')}`);
    }
    if (message.text) sections.push(String(message.text));
    if (message.error) sections.push(`> 錯誤：${String(message.error).replace(/\n/g, '\n> ')}`);
    const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;
    if (!message.text && !message.error && !hasAttachments) sections.push('_(無文字內容)_');
  }
  return `${sections.join('\n\n')}\n`;
}

module.exports = { writeSession, listSessions, readSession, deleteSession, listConversationIds, messagesToMarkdown, usageMarkdown, resolveSessionPath };
