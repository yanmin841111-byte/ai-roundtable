// CLI 轉接層入口:協調器與主程序只透過這裡使用轉接器。
// runTurn 補齊 callback、正規化 usage;型別見 ./types.ts。

import { Registry } from './registry';
import { normalizeUsage } from '../usage';
import type { AgentConfig } from '../ipc-types';
import type { RunContext, TurnCallbacks, TurnResult } from './types';

let registry = new Registry();

function setRegistry(r: Registry) { registry = r; }
function getRegistry() { return registry; }
function getAdapter(id: string) { return registry.get(id); }

// 成員實際能不能改檔案:成員設定允許,且轉接器支援
function effectiveCanEdit(agent: Pick<AgentConfig, 'cli' | 'canEdit'>) {
  const adapter = registry.get(agent.cli);
  return !!(agent.canEdit && adapter && adapter.supportsEdit);
}

type TurnInput = Omit<RunContext, keyof TurnCallbacks> & Partial<TurnCallbacks>;

async function runTurn(agent: AgentConfig, input: TurnInput): Promise<TurnResult> {
  const noop = () => {};
  const ctx: RunContext = { onText: noop, onThinking: noop, onActivity: noop, onSession: noop, onProc: noop, ...input };
  const adapter = registry.get(agent.cli);
  if (!adapter) {
    return { text: '', thinking: '', sessionId: null, usage: null, error: `找不到 CLI「${agent.cli}」:對應的擴充可能已刪除或載入失敗,請到「設定 → CLI 與擴充」檢查` };
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
    return { text: '', thinking: '', sessionId: null, usage: null, error: `${adapter.label} 執行失敗:${e instanceof Error ? e.message : String(e)}` };
  }
}

export { runTurn, getAdapter, getRegistry, setRegistry, effectiveCanEdit, Registry };
