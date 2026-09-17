'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function report(logger, message) {
  try { (logger || console).error(message); } catch {}
}

// 寫入同一目錄的暫存檔後 rename，避免留下只寫了一半的 session。
// 所有錯誤都轉成回傳值，呼叫端不需要為記錄失敗中止任務。
function writeSession(userDataDir, messages, { now = new Date(), logger } = {}) {
  const dir = path.join(userDataDir, 'sessions');
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}-${crypto.randomUUID()}.json`);
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(Array.isArray(messages) ? messages : [], null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, file };
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    report(logger, `無法儲存對話紀錄: ${error.message}`);
    return { ok: false, file: null, error: error.message };
  }
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
    if (message.text) sections.push(String(message.text));
    if (message.error) sections.push(`> 錯誤：${String(message.error).replace(/\n/g, '\n> ')}`);
    if (!message.text && !message.error) sections.push('_(無文字內容)_');
  }
  return `${sections.join('\n\n')}\n`;
}

module.exports = { writeSession, messagesToMarkdown, usageMarkdown };
