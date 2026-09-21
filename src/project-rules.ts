// 專案規則:工作目錄裡的 CLAUDE.md / AGENTS.md,自動放進每位成員的系統提示。
//
// 為什麼:同一個專案的規範(命名、風格、不要碰哪些目錄、怎麼跑測試)每次重講一遍很浪費,
// 而且講漏一次成員就照自己的習慣做。這些檔案已經是 agentic coding 的慣例,讀它就好,
// 不必再發明一種新的設定檔。
import fs from 'fs';
import path from 'path';

// 依序找,取第一個找到的。CLAUDE.md 放前面:目前最普遍
export const RULE_FILES = ['CLAUDE.md', 'AGENTS.md', 'AGENT.md', '.roundtable.md'];
// 規則會放進每位成員、每一回合的提示詞:太長會擠掉真正的任務內容
export const RULES_MAX_CHARS = 8000;

export interface ProjectRules {
  file: string;
  text: string;
  truncated: boolean;
}

export function readProjectRules(cwd: string): ProjectRules | null {
  for (const name of RULE_FILES) {
    const full = path.join(cwd || '', name);
    try {
      if (!fs.statSync(full).isFile()) continue;
      const raw = fs.readFileSync(full, 'utf8').trim();
      if (!raw) continue;
      return { file: name, text: raw.slice(0, RULES_MAX_CHARS), truncated: raw.length > RULES_MAX_CHARS };
    } catch { /* 沒有這個檔案、或讀不到:換下一個 */ }
  }
  return null;
}
