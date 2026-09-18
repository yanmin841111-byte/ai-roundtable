// CLI 轉接層入口:協調器與主程序只透過這裡使用轉接器。
// runTurn 補齊 callback、正規化 usage;型別見 ./types.ts。

import { Registry } from './registry';
import { normalizeUsage } from '../usage';
import type { AgentConfig } from '../ipc-types';
import type { RunContext, TurnCallbacks, TurnResult } from './types';
import { tx } from '../text';
import { capabilityKey, capabilityStore } from '../capabilities';
import type { TextLocale } from '../text';

let registry = new Registry();

function setRegistry(r: Registry) { registry = r; }
function getRegistry() { return registry; }
function getAdapter(id: string) { return registry.get(id); }

// 成員實際能不能改檔案:成員設定允許,且轉接器支援
function effectiveCanEdit(agent: Pick<AgentConfig, 'cli' | 'canEdit'> & Partial<Pick<AgentConfig, 'model'>>) {
  const adapter = registry.get(agent.cli);
  // 已知不能呼叫工具的模型改不了檔:給它寫入工具只會換來一個被拒絕的請求,整個執行回合失敗。
  // 當成唯讀成員,分工與審查都會照這個安排(審查時附上內容,而不是叫它自己讀檔)。
  return !!(agent.canEdit && adapter && adapter.supportsEdit && knownCapability(agent)?.tools !== false);
}

// 這位成員所用模型已知的能力;不知道就回 undefined。只查快取,不會發出任何請求。
// 模型清單還沒載入時名稱對應不完整(gemma3 還沒變成 gemma3:latest),所以完整名稱與原本的寫法都查。
function knownCapability(agent: Pick<AgentConfig, 'cli'> & Partial<Pick<AgentConfig, 'model'>>) {
  const adapter = registry.get(agent.cli);
  if (!adapter || typeof adapter.resolveModel !== 'function') return undefined;
  const store = capabilityStore();
  const raw = agent.model || '';
  const resolved = adapter.resolveModel(raw);
  return (resolved ? store.get(capabilityKey(adapter.id, adapter.endpoint, resolved)) : undefined)
    ?? (raw && raw !== resolved ? store.get(capabilityKey(adapter.id, adapter.endpoint, raw)) : undefined);
}

type TurnInput = Omit<RunContext, keyof TurnCallbacks> & Partial<TurnCallbacks> & { locale?: TextLocale };

async function runTurn(agent: AgentConfig, input: TurnInput): Promise<TurnResult> {
  const noop = () => {};
  const ctx: RunContext = { onText: noop, onThinking: noop, onActivity: noop, onSession: noop, onProc: noop, ...input };
  const adapter = registry.get(agent.cli);
  if (!adapter) {
    return { text: '', thinking: '', sessionId: null, usage: null, error: tx(input.locale || 'zh-Hant', 'adapter.missing', { cli: agent.cli }) };
  }
  try {
    const result = await adapter.run({ ...agent, canEdit: effectiveCanEdit(agent) }, ctx);
    const r = result || {};
    // 所有 usage 都在這個出口正規化,上層(orchestrator、介面、匯出)只會看到同一種形狀
    return {
      ...r,
      text: r.text || '',
      thinking: r.thinking || '',
      sessionId: r.sessionId || null,
      usage: r.usage ? normalizeUsage(r.usage, adapter.usageShape) : null,
      error: r.error || null,
    };
  } catch (e) {
    return { text: '', thinking: '', sessionId: null, usage: null, error: tx(input.locale || 'zh-Hant', 'adapter.failed', { label: adapter.label, message: e instanceof Error ? e.message : String(e) }) };
  }
}

export { runTurn, getAdapter, getRegistry, setRegistry, effectiveCanEdit, knownCapability, Registry };
