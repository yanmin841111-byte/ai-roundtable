// 共用工具:orchestrator(Node)與 renderer(瀏覽器)共用同一套標記語意。
// 標準 ESM export:Node 端由 tsc 編成 CommonJS,renderer 端由 esbuild inline 進 bundle。

// 只檢查最後幾行,避免成員在內文中「提到」標記就被誤判。
// 本機小模型常在標記後面多寫一兩行收尾,放寬到 6 行讓它們不會一直被漏判;
// 「必須單獨成行」這條規則不放寬,否則句子裡提到標記就會被誤判。
export const TAIL_LINES = 6;

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

// ---------- [ASK] 選項式提問 ----------
// 成員在討論階段可以用單獨成行的 [ASK] 區塊反問使用者:
//
//   [ASK]
//   要先支援哪一種本地端點?
//   - Ollama
//   - LM Studio
//   [/ASK]
//
// parser 必須寬容:本機小模型不會乖乖照格式輸出。解析不出問題文字時一律回 null
// (呼叫端就當成普通文字顯示),任何情況都不可以拋錯。

export interface ParsedOption {
  id: string;
  label: string;
  detail?: string;
}

export interface ParsedAsk {
  question: string;
  options: ParsedOption[];
  allowFree: boolean;
}

// 開頭標記,允許全形括號與同一行接問題:「[ASK] 要用哪個方案?」
const ASK_OPEN = /^[[【]\s*ASK\s*[\]】]\s*(.*)$/i;
const ASK_CLOSE = /^[[【]\s*\/\s*ASK\s*[\]】]\s*$/i;
// 條列前綴:- * • 等符號
const BULLET = /^[-*•‧–—+]\s+(.+)$/;
// 標號前綴:(a)、（a）、[b]、1.、2)、3、 等;必須有結尾標點,否則整句中文會被誤判成選項
const LABELED = /^[([【（]?\s*([A-Za-z]|\d{1,2})\s*[)）\]】.、,，:：]\s*(.+)$/;
// 「問題:」這類標籤要先剝掉,否則「Q: …」會被 LABELED 當成編號 Q 的選項
const QUESTION_LABEL = /^(?:問題|題目|提問|Question|Q)\s*[:：]\s*/i;
const MAX_OPTIONS = 8;
const MAX_QUESTION_CHARS = 500;
const MAX_LABEL_CHARS = 200;

const OPTION_IDS = 'abcdefghijklmnopqrstuvwxyz';

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n) : t;
}

// 取出文字中第一個 [ASK] 區塊的內容行。沒有開頭標記時回 null;
// 缺少 [/ASK] 結尾時一路吃到文字結束(小模型很常忘記收尾)。
function sliceAskBlock(lines: string[]): { head: string; body: string[] } | null {
  for (let i = 0; i < lines.length; i++) {
    const open = ASK_OPEN.exec(lines[i].trim());
    if (!open) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (ASK_CLOSE.test(lines[j].trim())) break;
      body.push(lines[j]);
    }
    return { head: open[1] || '', body };
  }
  return null;
}

export function parseAsk(text: unknown): ParsedAsk | null {
  try {
    if (!text) return null;
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    const block = sliceAskBlock(lines);
    if (!block) return null;

    const questionParts: string[] = [];
    if (block.head.trim()) questionParts.push(block.head.replace(QUESTION_LABEL, '').trim());
    const options: ParsedOption[] = [];

    for (const raw of block.body) {
      const line = raw.trim();
      if (!line) continue;
      // 「問題:」開頭的一律當問題,不進選項比對
      if (QUESTION_LABEL.test(line)) {
        if (!options.length) questionParts.push(line.replace(QUESTION_LABEL, '').trim());
        continue;
      }
      const bullet = BULLET.exec(line);
      const labeled = bullet ? null : LABELED.exec(line);
      const label = bullet ? bullet[1] : labeled ? labeled[2] : '';
      if (label) {
        if (options.length < MAX_OPTIONS) {
          options.push({ id: OPTION_IDS[options.length] || `o${options.length}`, label: clip(label, MAX_LABEL_CHARS) });
        }
        continue;
      }
      // 不是選項:選項還沒開始就是問題的一部分,已經開始就當成前一個選項的補充說明
      if (!options.length) questionParts.push(line);
      else {
        const last = options[options.length - 1];
        last.detail = clip(`${last.detail ? last.detail + ' ' : ''}${line}`, MAX_LABEL_CHARS);
      }
    }

    const question = clip(questionParts.filter(Boolean).join('\n'), MAX_QUESTION_CHARS);
    if (!question) return null; // 問不清楚就別打斷使用者,讓它當普通文字顯示
    // 選項只是捷徑,使用者永遠可以自己打字回答
    return { question, options, allowFree: true };
  } catch {
    return null;
  }
}

// 移除所有 [ASK] 區塊(含開頭與結尾標記),回傳 trim 後的文字。
// 缺少 [/ASK] 時移除到文字結束,與 parseAsk 的容忍規則一致。
export function stripAsk(text: unknown): string {
  if (!text) return '';
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inBlock && ASK_OPEN.test(trimmed)) { inBlock = true; continue; }
    if (inBlock) { if (ASK_CLOSE.test(trimmed)) inBlock = false; continue; }
    out.push(line);
  }
  return out.join('\n').trim();
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
