// 反例語料庫:被確認過的反例留在專案裡,成為它永久的關卡。
//
// 為什麼需要:一次任務裡的反例只守得住那一次。實驗 7 的現場裡,修復回合把執行階段做對的
// 東西改壞不是偶發——32 次裡「大破壞」佔 6/16。下一次任務、換一位成員、換一個模型,
// 同一個邊界條件再被改回去,沒有任何機制看得見。
//
// 語料庫就是那個機制:每一個 app 自己跑過、確認真的會失敗的反例都存下來,
// 之後每次任務的基準線都會把它們再跑一遍。上個月抓到的錯,這個月改回去會被擋下來。
//
// 為什麼共享的是反例而不是推理過程:共享推理會讓模型互相錨定——實驗 3 量到圓桌沒全對的
// 10 次裡有 8 次照樣寫「審查通過」,那就是錨定,產品後來改用乾淨 context 就是為了切斷它。
// 反例的差別不在於它不會錯,而在於它可以被獨立驗證:它是一段跑得起來的程式,
// 下一位成員不必相信提出者的任何一句話,自己跑一次就知道。
//
// 但它不是真理。一個反例可能測錯了需求、可能把當時的錯誤行為固化成回歸測試,
// 也可能只是提出者對「應該怎樣」的一個主張。所以原則不是「反例免疫於錨定」,而是:
// **共享的東西越能被獨立驗證,權重越高**。語料庫在棘輪裡因此是最低的那一層
// (ratchet.ts 的 GateWeight = 'inherited'):照樣跑、照樣報告,但不單獨觸發回退。
// 這個檔案是純文字 JSON、跟著專案走,一條主張過時了就把它刪掉——那是一次 commit 的事。
//
// 檔案放在工作目錄裡(不是 app 的資料夾):它屬於那個專案,應該跟著專案一起被 commit、
// 被 review、被別人看到。目錄名由 snapshotDir 略過,所以它不會被算成任何成員的改動。
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CE_SOURCE_MAX, type Counterexample, type CounterexampleRun, classifyConfirmation } from './counterexample';

export const CORPUS_DIR = '.roundtable';
export const CORPUS_FILE = 'counterexamples.json';
// 上限刻意保守:基準線每次任務都要把它們全部跑一遍,語料庫無限長大等於每次任務都變慢。
// 滿了就不再收,並且說出來——不靜默丟掉最舊的,那會讓「守得住」變成一句不可信的話。
export const CORPUS_MAX_ENTRIES = 50;
export const CORPUS_MAX_BYTES = 256 * 1024;

export interface CorpusEntry {
  // 內容雜湊:同一段腳本不會因為換了一位審查者就被收兩次
  id: string;
  title: string;
  source: string;
  addedAt: number;
  // 誰舉出來的、當時在做什麼任務。只是紀錄,不參與任何判斷。
  reviewer: string;
  task: string;
}

export function corpusPath(cwd: string): string {
  return path.join(cwd, CORPUS_DIR, CORPUS_FILE);
}

function entryId(source: string): string {
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
}

// 讀不到、格式壞了、被手改過:一律當成空的。
// 語料庫是「額外的關卡」,不是正確性的來源——讀不到就少幾道關卡,不能讓整個任務停下來。
export function loadCorpus(cwd: string): CorpusEntry[] {
  let raw: string;
  try { raw = fs.readFileSync(corpusPath(cwd), 'utf8'); } catch { return []; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const list = Array.isArray(parsed) ? parsed : (parsed as { entries?: unknown })?.entries;
  if (!Array.isArray(list)) return [];
  const out: CorpusEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const source = typeof (item as CorpusEntry).source === 'string' ? (item as CorpusEntry).source : '';
    if (!source || source.length > CE_SOURCE_MAX) continue;
    const id = typeof (item as CorpusEntry).id === 'string' && (item as CorpusEntry).id ? (item as CorpusEntry).id : entryId(source);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      source,
      title: String((item as CorpusEntry).title || ''),
      addedAt: Number((item as CorpusEntry).addedAt) || 0,
      reviewer: String((item as CorpusEntry).reviewer || ''),
      task: String((item as CorpusEntry).task || ''),
    });
    if (out.length >= CORPUS_MAX_ENTRIES) break;
  }
  return out;
}

// 收進語料庫的條件:app 自己跑過,而且真的重現了問題(非零結束)。
// 「不成立」的反例不收——審查者講不出可重現的例子,收進去只會讓基準線永遠是紅的,
// 而那會讓棘輪的每一次比較都從一個不可信的起點開始。
export function additions(runs: CounterexampleRun[], task: string, existing: CorpusEntry[]): CorpusEntry[] {
  const known = new Set(existing.map((e) => e.id));
  const out: CorpusEntry[] = [];
  for (const run of runs) {
    if (classifyConfirmation(run) !== 'confirmed') continue;
    const id = entryId(run.source);
    if (known.has(id)) continue;
    known.add(id);
    out.push({ id, title: run.title, source: run.source, addedAt: Date.now(), reviewer: run.reviewerName, task });
  }
  return out;
}

export interface SaveOutcome {
  added: number;
  // 沒收進去的原因照實回報:滿了、或整份超過大小上限
  rejected: number;
  total: number;
  error?: string;
}

export function saveCorpus(cwd: string, entries: CorpusEntry[], incoming: CorpusEntry[]): SaveOutcome {
  const merged = [...entries];
  let rejected = 0;
  for (const entry of incoming) {
    if (merged.length >= CORPUS_MAX_ENTRIES) { rejected++; continue; }
    const next = JSON.stringify([...merged, entry], null, 2);
    if (Buffer.byteLength(next, 'utf8') > CORPUS_MAX_BYTES) { rejected++; continue; }
    merged.push(entry);
  }
  const added = merged.length - entries.length;
  if (!added) return { added: 0, rejected, total: entries.length };
  try {
    fs.mkdirSync(path.join(cwd, CORPUS_DIR), { recursive: true });
    fs.writeFileSync(corpusPath(cwd), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  } catch (error) {
    return { added: 0, rejected, total: entries.length, error: String((error as Error).message || error) };
  }
  return { added, rejected, total: merged.length };
}

// 語料庫的項目變成這一次任務跑得起來的反例。
// id 前綴 corpus- 是刻意的:棘輪比較的 key 就是 id,語料庫的關卡要和這次任務新舉出來的
// 反例分得開,不然同一段腳本在兩邊被當成兩道關卡。
export function corpusCounterexamples(entries: CorpusEntry[]): Counterexample[] {
  return entries.map((entry) => ({
    id: `corpus-${entry.id}`,
    reviewerId: '',
    reviewerName: entry.reviewer,
    targetId: '',
    title: entry.title,
    source: entry.source,
  }));
}
