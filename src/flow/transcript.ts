// 對話紀錄截斷:把整場會議壓進成員的上下文上限,被裁掉的地方一定留下提示
import { tx } from '../text';
import type { TextLocale } from '../text';
import type { TranscriptEntry } from './types';

export const SEP = '\n\n';            // 對話紀錄各則之間的分隔
const TRUNCATE_RESERVE = 200;   // 截斷時為省略提示預留的字元空間

// ---------- 對話紀錄截斷 ----------
// 單則訊息本身就超過預算時就地裁尾,避免一則訊息吃掉整個額度
function clipEntry(text: string, max: number, locale: TextLocale) {
  const notice = tx(locale, 'transcript.clipped');
  if (text.length <= max) return text;
  if (max <= notice.length) return notice.slice(0, Math.max(0, max));
  return text.slice(0, max - notice.length) + notice;
}

// 把對話紀錄壓到 limit 字元以內。
// pinned(任務敘述、分工結果)與最新一則一定保留,其餘從新到舊盡量保留;
// 被裁掉的位置就地插入「已省略中間 N 則訊息」,不做靜默裁切。
// limit <= 0 視為不限制。
export function truncateTranscript(entries: TranscriptEntry[], limit: number, locale: TextLocale = 'zh-Hant') {
  const omitNotice = (n: number) => tx(locale, 'transcript.omitted', { n });
  const texts = entries.map((e) => e.text);
  const full = texts.join(SEP);
  if (!Number.isFinite(limit) || limit <= 0 || full.length <= limit) return full;

  const budget = Math.max(0, limit - TRUNCATE_RESERVE);
  const last = entries.length - 1;
  // 最新一則等同釘選:成員至少要看得到上一位說了什麼
  const items = entries.map((e, i) => ({ pinned: !!e.pinned || i === last, text: e.text }));
  const cost = (t: string) => t.length + SEP.length;

  // 第一步:決定保留哪些。釘選的必留,其餘從最新往回補,遇到放不下的就停,
  // 保留一段連續的最近紀錄而不是零散幾則。
  const keep = new Array(items.length).fill(false);
  let used = 0;
  for (let i = 0; i < items.length; i++) if (items[i].pinned) { keep[i] = true; used += cost(items[i].text); }
  for (let i = items.length - 1; i >= 0; i--) {
    if (keep[i]) continue;
    if (used + cost(items[i].text) > budget) break;
    keep[i] = true;
    used += cost(items[i].text);
  }

  // 第二步:必留的部分本身就超過預算時(例如任務敘述與分工結果都很長),
  // 在所有保留項目之間做 max-min 公平分配再各自裁尾。
  // 不能讓排在前面的項目吃光額度,否則最後的整體裁切會把最新一則整個擠掉。
  const kept = items.map((_, i) => i).filter((i) => keep[i]);
  const allowance = allocateBudget(kept.map((i) => cost(items[i].text)), budget);
  const shown = new Map<number, string>();
  kept.forEach((i, k) => shown.set(i, clipEntry(items[i].text, Math.max(0, allowance[k] - SEP.length), locale)));

  const out: string[] = [];
  let dropped = 0;
  for (let i = 0; i < items.length; i++) {
    if (!keep[i]) { dropped++; continue; }
    if (dropped) { out.push(omitNotice(dropped)); dropped = 0; }
    out.push(shown.get(i)!);
  }
  if (dropped) out.push(omitNotice(dropped));

  const text = out.join(SEP);
  return text.length <= limit ? text : text.slice(0, limit); // 最後保險:絕不超過上限
}

// max-min 公平分配:需求小的先拿滿,省下來的額度再平分給還不夠的,
// 所以沒有任何一項會被歸零,總和也不會超過 budget。
function allocateBudget(costs: number[], budget: number) {
  const out: number[] = new Array(costs.length).fill(0);
  const order = costs.map((_, i) => i).sort((a, b) => costs[a] - costs[b]);
  let remaining = budget;
  let left = costs.length;
  for (const i of order) {
    const take = Math.min(costs[i], Math.floor(remaining / left));
    out[i] = take;
    remaining -= take;
    left--;
  }
  return out;
}
