// 陣容:存下「誰上場、各自扮演什麼角色、誰主持、跑什麼流程、討論幾輪」,之後一鍵換回來。
// 陣容只記成員的 id,不複製成員本身:CLI、模型、金鑰這些設定仍以成員為準,
// 換陣容只改「誰啟用」與角色描述,不會悄悄換掉誰的模型。
// 主程序(載入設定時清理)與介面(套用、比對)共用這一份,不得 import electron 或 node 模組。
import type { AppConfig, Lineup } from './ipc-types';

export const LINEUPS_MAX = 30;
export const LINEUP_NAME_MAX = 40;
const MODES = new Set(['divide', 'tdd', 'discuss']);
const ROUNDS_MIN = 1;
const ROUNDS_MAX = 10; // 與設定視窗「最大討論回合」的上限一致

// 實際的主持人:沒指定、或指定的人沒啟用時,由第一位啟用的成員主持(與介面、流程的判斷相同)
export function effectiveLead(config: AppConfig): string | null {
  const enabled = config.agents.filter((a) => a.enabled !== false);
  const chosen = config.settings.leadAgentId;
  return enabled.some((a) => a.id === chosen) ? chosen : enabled[0]?.id ?? null;
}

// 把目前的設定存成一個陣容
export function lineupFromConfig(config: AppConfig, name: string, id: string): Lineup {
  const members = config.agents.filter((a) => a.enabled !== false).map((a) => ({ id: a.id, persona: a.persona || '' }));
  return {
    id,
    name: name.trim().slice(0, LINEUP_NAME_MAX),
    members,
    leadAgentId: effectiveLead(config),
    mode: MODES.has(config.settings.mode) ? config.settings.mode : 'divide',
    maxRounds: clampRounds(config.settings.maxRounds),
    workStyle: config.settings.workStyle === 'general' ? 'general' : 'code',
  };
}

export interface LineupApplied {
  config: AppConfig;
  // 陣容裡已經被刪掉的成員數。套用照樣進行,但要告訴使用者少了誰
  missing: number;
}

// 套用陣容:陣容裡的成員啟用並換上當時的角色,其他成員停用。
// 陣容裡的成員全都被刪掉時回 null:套用下去會變成一個人都沒有的圓桌
export function applyLineup(config: AppConfig, lineup: Lineup): LineupApplied | null {
  const byId = new Map(lineup.members.map((m) => [m.id, m]));
  const present = config.agents.filter((a) => byId.has(a.id));
  if (!present.length) return null;
  const agents = config.agents.map((a) => {
    const m = byId.get(a.id);
    return m ? { ...a, enabled: true, persona: m.persona } : { ...a, enabled: false };
  });
  const lead = present.some((a) => a.id === lineup.leadAgentId) ? lineup.leadAgentId : present[0].id;
  return {
    config: {
      ...config,
      agents,
      settings: { ...config.settings, leadAgentId: lead, mode: lineup.mode, maxRounds: lineup.maxRounds, workStyle: lineup.workStyle === 'general' ? 'general' : 'code', activeLineupId: lineup.id },
    },
    missing: lineup.members.length - present.length,
  };
}

// 目前的設定和陣容一樣嗎。套用之後又改了誰上場、角色、主持人、流程或回合數,就不一樣了。
// 已經被刪掉的成員不算:它們不可能再上場,不該讓陣容永遠顯示「已修改」
export function lineupMatches(config: AppConfig, lineup: Lineup): boolean {
  const existing = lineup.members.filter((m) => config.agents.some((a) => a.id === m.id));
  const enabled = config.agents.filter((a) => a.enabled !== false);
  if (!existing.length || enabled.length !== existing.length) return false;
  for (const m of existing) {
    const a = config.agents.find((x) => x.id === m.id)!;
    if (a.enabled === false || (a.persona || '') !== m.persona) return false;
  }
  const lead = existing.some((m) => m.id === lineup.leadAgentId) ? lineup.leadAgentId : existing[0].id;
  const style = (v: unknown) => (v === 'general' ? 'general' : 'code');
  return effectiveLead(config) === lead
    && config.settings.mode === lineup.mode
    && style(config.settings.workStyle) === style(lineup.workStyle)
    && clampRounds(config.settings.maxRounds) === lineup.maxRounds;
}

// 設定檔可能被手動改過或來自舊版本:形狀不對的陣容整筆丟掉,欄位不對的補成預設值
export function sanitizeLineups(raw: unknown): Lineup[] {
  if (!Array.isArray(raw)) return [];
  const out: Lineup[] = [];
  const ids = new Set<string>();
  for (const l of raw as any[]) {
    if (!l || typeof l !== 'object' || typeof l.id !== 'string' || !l.id || ids.has(l.id)) continue;
    const name = typeof l.name === 'string' ? l.name.trim().slice(0, LINEUP_NAME_MAX) : '';
    if (!name || !Array.isArray(l.members)) continue;
    const seen = new Set<string>();
    const members = l.members
      .filter((m: any) => m && typeof m.id === 'string' && m.id && !seen.has(m.id) && seen.add(m.id))
      .map((m: any) => ({ id: m.id, persona: typeof m.persona === 'string' ? m.persona : '' }));
    if (!members.length) continue;
    ids.add(l.id);
    out.push({
      id: l.id,
      name,
      members,
      leadAgentId: typeof l.leadAgentId === 'string' && members.some((m: { id: string }) => m.id === l.leadAgentId) ? l.leadAgentId : null,
      mode: MODES.has(l.mode) ? l.mode : 'divide',
      maxRounds: clampRounds(l.maxRounds),
      workStyle: l.workStyle === 'general' ? 'general' : 'code',
    });
    if (out.length >= LINEUPS_MAX) break;
  }
  return out;
}

function clampRounds(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(ROUNDS_MAX, Math.max(ROUNDS_MIN, n)) : 3;
}
