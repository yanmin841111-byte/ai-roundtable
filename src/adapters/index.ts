// CLI 轉接層入口:協調器與主程序只透過這裡使用轉接器。
// runTurn 補齊 callback、正規化 usage;型別見 ./types.ts。

import { Registry, fixFromStatus } from './registry';
import { normalizeUsage } from '../usage';
import type { AgentConfig, CliStatus, EnvFix } from '../ipc-types';
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

// 回合失敗時,順手問一次這個轉接器的健康狀態。
//
// 為什麼在這裡問:一個回合會失敗,十之八九就是沒登入、CLI 不見了、端點連不上——而使用者
// 看到的只是對話裡一段紅字。問一次就能把「照做就能修好的下一步」一起交給介面,
// 不必每個轉接器各自記得要填,也不必讓使用者自己去設定畫面翻。
// 成功的回合完全不受影響:只有失敗才問。
const FAILURE_CHECK_TTL_MS = 30000;
// 健康檢查是別人寫的程式(JS 外掛也算),不能讓它卡住這一回合的錯誤訊息
const FAILURE_CHECK_TIMEOUT_MS = 8000;
const failureChecks = new Map<string, { at: number; fix?: EnvFix }>();

async function fixForFailedTurn(adapter: { id: string; docsUrl?: string; check?: Function; testConnection?: Function }, locale: TextLocale): Promise<EnvFix | undefined> {
  const cached = failureChecks.get(adapter.id);
  // 平行階段可能同時倒好幾位成員:短時間內只問一次,不要對同一個 CLI 連開十次行程
  if (cached && Date.now() - cached.at < FAILURE_CHECK_TTL_MS) return cached.fix;
  let fix: EnvFix | undefined;
  try {
    const probe = adapter.check ? adapter.check({ locale }) : adapter.testConnection ? adapter.testConnection() : null;
    const status: CliStatus | null = probe
      ? await Promise.race([probe, new Promise<null>((resolve) => setTimeout(() => resolve(null), FAILURE_CHECK_TIMEOUT_MS))])
      : null;
    // 健康檢查說沒問題就不硬湊:這次失敗是別的原因(模型拒絕、逾時…),
    // 給一顆修不了問題的按鈕只會讓人白忙一趟。
    // 下一步用和設定畫面同一份規則推(fixFromStatus),不在這裡另外判斷一次。
    fix = fixFromStatus(adapter, status);
  } catch { /* 健康檢查本身失敗不該影響這次回合的錯誤訊息 */ }
  failureChecks.set(adapter.id, { at: Date.now(), fix });
  return fix;
}

async function runTurn(agent: AgentConfig, input: TurnInput): Promise<TurnResult> {
  const noop = () => {};
  const ctx: RunContext = { onText: noop, onThinking: noop, onActivity: noop, onSession: noop, onProc: noop, ...input };
  const locale: TextLocale = input.locale || 'zh-Hant';
  const adapter = registry.get(agent.cli);
  if (!adapter) {
    // 擴充被刪掉或載入失敗:要修的地方在設定裡,不是終端
    return { text: '', thinking: '', sessionId: null, usage: null, error: tx(locale, 'adapter.missing', { cli: agent.cli }), fix: { settingsTab: 'clis' } };
  }
  try {
    const result = await adapter.run({ ...agent, canEdit: effectiveCanEdit(agent) }, ctx);
    const r = result || {};
    const error = r.error || null;
    // 所有 usage 都在這個出口正規化,上層(orchestrator、介面、匯出)只會看到同一種形狀
    return {
      ...r,
      text: r.text || '',
      thinking: r.thinking || '',
      sessionId: r.sessionId || null,
      usage: r.usage ? normalizeUsage(r.usage, adapter.usageShape) : null,
      error,
      fix: error ? r.fix || await fixForFailedTurn(adapter, locale) : undefined,
    };
  } catch (e) {
    return {
      text: '', thinking: '', sessionId: null, usage: null,
      error: tx(locale, 'adapter.failed', { label: adapter.label, message: e instanceof Error ? e.message : String(e) }),
      fix: await fixForFailedTurn(adapter, locale),
    };
  }
}

export { runTurn, getAdapter, getRegistry, setRegistry, effectiveCanEdit, knownCapability, Registry };
