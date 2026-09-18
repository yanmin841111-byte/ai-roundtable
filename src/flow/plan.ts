// 主持人的分工:從模型輸出挑出 JSON、把寫法各異的成員名稱對回成員
import type { AgentConfig } from '../ipc-types';

// ---------- JSON 解析 ----------
// 從 start 的「{」往後找到配對的「}」,會正確跳過字串內的括號與跳脫字元
function matchBrace(s: string, start: number) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// 掃描出所有「括號平衡」的候選片段逐一嘗試,模型在 JSON 前後多寫說明文字也不會壞
export function extractJson(text: unknown): any {
  if (!text) return null;
  const s = String(text).replace(/```(?:json)?/gi, '');
  const candidates: string[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    const end = matchBrace(s, i);
    if (end > i) candidates.push(s.slice(i, end + 1));
  }
  candidates.sort((a, b) => b.length - a.length); // 外層物件優先
  const parsed: any[] = [];
  for (const c of candidates) {
    try {
      const o = JSON.parse(c);
      if (o && typeof o === 'object' && !Array.isArray(o)) parsed.push(o);
    } catch {}
  }
  return parsed.find((o: any) => Array.isArray(o.assignments)) || parsed[0] || null;
}

// ---------- 成員比對 ----------
const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/\s+/g, '').replace(/[「」『』"'`【】\[\]()()]/g, '');

// 先比對 A1/A2 代號,再退回正規化後的名稱,最後才做寬鬆的包含比對
export function resolveAgent(token: unknown, codes: Map<string, AgentConfig>, agents: AgentConfig[]): AgentConfig | null {
  const raw = String(token ?? '').trim();
  if (!raw) return null;
  const byCode = codes.get(raw.toUpperCase());
  if (byCode) return byCode;
  const n = norm(raw);
  if (!n) return null;
  for (const [code, a] of codes) if (norm(code) === n) return a;
  const exact = agents.find((a) => norm(a.name) === n);
  if (exact) return exact;
  if (n.length < 2) return null;
  return agents.find((a) => {
    const an = norm(a.name);
    return an.length >= 2 && (an.includes(n) || n.includes(an));
  }) || null;
}
