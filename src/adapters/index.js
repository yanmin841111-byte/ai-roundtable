'use strict';
// CLI 轉接層入口:協調器與主程序只透過這裡使用轉接器。
//
// runTurn(agent, ctx) → Promise<{ text, thinking, sessionId, usage, error }>
// ctx: { prompt, systemPrompt, sessionId, cwd, timeoutMs,
//        onText(fullText), onThinking(fullText), onActivity(activity), onSession(id), onProc(handle) }

const { Registry } = require('./registry');
const { normalizeUsage } = require('../usage');

let registry = new Registry();

function setRegistry(r) { registry = r; }
function getRegistry() { return registry; }
function getAdapter(id) { return registry.get(id); }

// 成員實際能不能改檔案:成員設定允許,且轉接器支援
function effectiveCanEdit(agent) {
  const adapter = registry.get(agent.cli);
  return !!(agent.canEdit && adapter && adapter.supportsEdit);
}

async function runTurn(agent, ctx) {
  const noop = () => {};
  ctx = { onText: noop, onThinking: noop, onActivity: noop, onSession: noop, onProc: noop, ...ctx };
  const adapter = registry.get(agent.cli);
  if (!adapter) {
    return { text: '', thinking: '', sessionId: null, usage: null, error: `找不到 CLI「${agent.cli}」:對應的擴充可能已刪除或載入失敗,請到「設定 → CLI 與擴充」檢查` };
  }
  try {
    const result = await adapter.run({ ...agent, canEdit: effectiveCanEdit(agent) }, ctx);
    const merged = { text: '', thinking: '', sessionId: null, usage: null, error: null, ...(result || {}) };
    // 所有 usage 都在這個出口正規化,上層(orchestrator、介面、匯出)只會看到同一種形狀
    merged.usage = merged.usage ? normalizeUsage(merged.usage, adapter.usageShape) : null;
    return merged;
  } catch (e) {
    return { text: '', thinking: '', sessionId: null, usage: null, error: `${adapter.label} 執行失敗:${e.message}` };
  }
}

module.exports = { runTurn, getAdapter, getRegistry, setRegistry, effectiveCanEdit, Registry };
