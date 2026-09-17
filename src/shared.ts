// 共用工具:orchestrator(Node)與 renderer(瀏覽器)共用同一套標記語意。
// 標準 ESM export:Node 端由 tsc 編成 CommonJS,renderer 端由 esbuild inline 進 bundle。

// 只檢查最後幾行,避免成員在內文中「提到」標記就被誤判。
export const TAIL_LINES = 3;

// findMentions 只看得到名稱;回傳型別用泛型帶回呼叫端自己的成員型別。
export interface MentionAgent {
  name: string;
}

function tagText(tag: unknown): string {
  return '[' + String(tag || '').trim() + ']';
}

// 標記必須單獨成一行,且出現在文字結尾的最後 TAIL_LINES 行之內。
export function hasMarker(text: unknown, tag: unknown): boolean {
  if (!text || !tag) return false;
  const want = tagText(tag);
  const lines = String(text).replace(/\r\n/g, '\n').trimEnd().split('\n');
  const tail = lines.slice(-TAIL_LINES);
  for (const line of tail) if (line.trim() === want) return true;
  return false;
}

// 移除所有「單獨成行」的該標記(不限最後幾行),回傳 trim 後的文字。
export function stripMarker(text: unknown, tag: unknown): string {
  if (!text) return '';
  if (!tag) return String(text).trim();
  const want = tagText(tag);
  return String(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => l.trim() !== want)
    .join('\n')
    .trim();
}

// 找出文字裡「@名稱」指定的成員(全形 ＠ 也算),依第一次出現的順序回傳、不重複。
// 名稱長的先比,避免「Codex」被「Code」搶先配對;名稱後面緊接英數字時不算(「@Codex2」不是「Codex」)。
// 中文名稱後面可以直接接內容,例如「@克勞德幫我看」。
export function findMentions<T extends MentionAgent>(
  text: unknown,
  agents: readonly T[] | null | undefined,
): T[] {
  const source = String(text || '').replace(/＠/g, '@');
  const lower = source.toLowerCase();
  const list = (agents || []).filter((a): a is T => !!a && typeof a.name === 'string' && !!a.name.trim());
  list.sort((a, b) => b.name.trim().length - a.name.trim().length);
  const used: Array<[number, number]> = [];
  const hits: Array<{ index: number; agent: T }> = [];
  const taken = (from: number, to: number): boolean => {
    for (const [start, end] of used) if (from < end && to > start) return true;
    return false;
  };
  for (const candidate of list) {
    const needle = '@' + candidate.name.trim().toLowerCase();
    let at = lower.indexOf(needle);
    while (at >= 0) {
      const end = at + needle.length;
      const next = source.charAt(end);
      if (!/[A-Za-z0-9_-]/.test(next) && !taken(at, end)) {
        used.push([at, end]);
        hits.push({ index: at, agent: candidate });
        break;
      }
      at = lower.indexOf(needle, at + 1);
    }
  }
  hits.sort((a, b) => a.index - b.index);
  return hits.map((h) => h.agent);
}
