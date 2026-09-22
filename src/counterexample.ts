// 反例:把審查從「意見」變成「可執行的證據」。
//
// 為什麼需要:實驗 7(eval/EXPERIMENTS.md)量到的不是「審查沒用」,是「診斷傳不到手上」。
// 那一輪的審查者(Claude Code)診斷品質很好——有一次它在討論階段就讀完檔案、找出 5 個問題,
// 比我們自己埋的還多一個,複查階段還抓到「檔案與上一輪完全相同,零項修正落地」——但那些
// 診斷要先寫成文字,再由另一顆模型照著文字動手,而動手的那顆會把它改砸。32 次跑下來,
// 圓桌把「有改善」和「大破壞」兩端同時放大了一倍(6/16 對 3/16)。診斷沒有損失,傳輸有。
//
// 所以這裡換掉傳輸的形狀:審查者除了寫意見,再附一段可以跑的腳本,它在現在這份程式上
// 必須以非零結束碼結束。app 自己跑一次,分成兩種結果:
//   真的失敗 → 這個問題被確認了,而且從此是一道客觀關卡:修好與否不再由任何模型宣告。
//   竟然通過 → 審查者講不出可重現的問題,這一條不算確認,照實說出來,也不拿去逼人修。
// 實驗 3 量到「審查通過」只有 64% 真的是對的;反例把那件事變成 app 自己跑得出來的答案。
//
// 反例不是專案的測試,也不是成員的產出:它寫在 .roundtable-ce-* 這種一次性檔案裡,跑完就刪。
// 檔名前綴由 snapshotDir 略過,所以它不會被算成誰的改動,也不會進「檔案改動」或驗證範圍。
//
// 這個檔案只負責「解析、執行、回報」。用它當關卡、決定要不要回退,是 ratchet.ts 的事。
import fs from 'fs';
import path from 'path';
import { runProcess, truncate } from './adapters/process';
import { tx } from './text';
import type { TextLocale } from './text';

// 反例腳本放在工作目錄最上層:審查者最自然會寫 require('./foo.js'),那是相對腳本自己的位置,
// 放進子目錄就解析不到。前綴由 snapshotDir 略過(見 snapshot.ts 的 SNAPSHOT_SKIP_PREFIX)。
export const CE_PREFIX = '.roundtable-ce-';
// 一位審查者最多幾個反例:反例是要拿來當關卡的,不是把整份測試搬過來
export const CE_MAX_PER_REVIEW = 3;
export const CE_SOURCE_MAX = 8000;
const CE_OUTPUT_MAX = 2000;
const CE_TIMEOUT_MS = 60_000;

// 和語法檢查同一套理由(見 verify.ts 的 CHECK_ENV,那裡有實測紀錄):
//   ELECTRON_RUN_AS_NODE:在 app 裡 process.execPath 是 Electron 不是 node。
//   NODE_OPTIONS:從使用者登入 shell 匯進來的環境只要有一個這顆 Node 不認得的參數,
//     每一個反例都會以非零結束——而非零在這裡的意思是「問題確認了」,等於每一條都被誣賴成真的。
const CE_ENV = { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' };

// ```counterexample 之後可以接一行說明,方便在介面與提示詞裡指名是哪一個
const FENCE_OPEN = /^[ \t]*```+[ \t]*counterexample[ \t]*(.*?)[ \t]*$/i;
const FENCE_CLOSE = /^[ \t]*```+[ \t]*$/;
// 有頂層 import / export 的腳本要當成 ES module 跑。動態 import() 在 .cjs 裡本來就能用,
// 所以只看語句形式的那兩個關鍵字,不看 import(。
const ESM_HINT = /^[ \t]*(?:import[ \t]+(?![ \t]*\()|export[ \t]+)/m;

export interface Counterexample {
  // 穩定的識別字:同一個反例在確認、修復提示、修復後重跑三個地方要對得起來
  id: string;
  reviewerId: string;
  reviewerName: string;
  targetId: string;
  title: string;
  source: string;
}

export interface CounterexampleRun extends Counterexample {
  // passed = 腳本以 0 結束。
  // 確認階段要的是 false(跑得出問題),修復之後要的是 true(問題不見了)。
  passed: boolean;
  code: number | null;
  output: string;
  timedOut: boolean;
  // 腳本本身沒跑成(寫不進檔案、node 起不來、被停止)。不能拿它當任何一邊的證據:
  // 既不算確認了問題,也不算修好了。
  unusable?: boolean;
}

// 從審查回覆裡取出反例區塊。多餘的、過長的一律丟掉並回報,不靜默截斷——
// 截一半的腳本跑起來多半是語法錯誤,那會被讀成「問題確認了」,是最糟的誤判方向。
export function parseCounterexamples(text: string | null | undefined): {
  blocks: Array<{ title: string; source: string }>;
  dropped: Array<{ title: string; reason: 'limit' | 'tooLong' | 'empty' }>;
} {
  const blocks: Array<{ title: string; source: string }> = [];
  const dropped: Array<{ title: string; reason: 'limit' | 'tooLong' | 'empty' }> = [];
  const lines = String(text || '').split('\n');
  let open: { title: string; body: string[] } | null = null;
  for (const line of lines) {
    if (!open) {
      const m = FENCE_OPEN.exec(line);
      if (m) open = { title: m[1] || '', body: [] };
      continue;
    }
    if (FENCE_CLOSE.test(line)) {
      const source = open.body.join('\n').trim();
      const title = open.title.trim();
      open = null;
      if (!source) { dropped.push({ title, reason: 'empty' }); continue; }
      if (source.length > CE_SOURCE_MAX) { dropped.push({ title, reason: 'tooLong' }); continue; }
      if (blocks.length >= CE_MAX_PER_REVIEW) { dropped.push({ title, reason: 'limit' }); continue; }
      blocks.push({ title, source });
      continue;
    }
    open.body.push(line);
  }
  // 沒有收尾的區塊不要:它是被回合截斷的半截腳本,跑起來是語法錯誤
  if (open) dropped.push({ title: open.title.trim(), reason: 'empty' });
  return { blocks, dropped };
}

// 審查回覆裡的反例區塊在送去別的地方顯示前先拿掉,不然整段腳本會在對話裡出現兩次
export function stripCounterexamples(text: string | null | undefined): string {
  const lines = String(text || '').split('\n');
  const out: string[] = [];
  let open = false;
  for (const line of lines) {
    if (!open) {
      if (FENCE_OPEN.test(line)) { open = true; continue; }
      out.push(line);
      continue;
    }
    if (FENCE_CLOSE.test(line)) open = false;
  }
  return out.join('\n').trim();
}

// 檔名只留安全字元:id 來自成員 id 與序號,但成員 id 是設定檔裡的字串,不能直接當檔名用
function safeName(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return cleaned || 'ce';
}

export function counterexamplePath(cwd: string, ce: Counterexample): string {
  const ext = ESM_HINT.test(ce.source) ? '.mjs' : '.cjs';
  return path.join(cwd, `${CE_PREFIX}${safeName(ce.id)}${ext}`);
}

// 跑一個反例。回傳 passed = 腳本以 0 結束。
//
// 不管結果如何都會把腳本刪掉:留在工作目錄裡會被下一次的快照差異算成成員的改動,
// 也會被使用者在「檔案改動」裡看到一個沒有人寫過的檔案。
export async function runCounterexample(
  cwd: string,
  ce: Counterexample,
  locale: TextLocale = 'zh-Hant',
  stop?: (child: unknown) => void,
  cancelled: () => boolean = () => false,
): Promise<CounterexampleRun> {
  const base: CounterexampleRun = { ...ce, passed: false, code: null, output: '', timedOut: false };
  if (cancelled()) return { ...base, unusable: true, output: tx(locale, 'ce.stopped') };
  const file = counterexamplePath(cwd, ce);
  try { await fs.promises.writeFile(file, ce.source, 'utf8'); }
  catch (error) { return { ...base, unusable: true, output: truncate(String((error as Error).message || error), CE_OUTPUT_MAX) }; }
  try {
    let stdout = '';
    const r = await runProcess(process.execPath, [file], { cwd, timeoutMs: CE_TIMEOUT_MS, locale, env: CE_ENV }, {
      onProc: (child) => stop && stop(child),
      onLine: (line: string) => { stdout += `${line}\n`; if (stdout.length > CE_OUTPUT_MAX * 2) stdout = stdout.slice(-CE_OUTPUT_MAX * 2); },
    });
    const text = `${stdout}${r.stderr || ''}`.trim();
    // 腳本裡的絕對路徑換回相對的:這段會進提示詞、對話紀錄與匯出
    const output = truncate(text.split(file).join(path.basename(file)), CE_OUTPUT_MAX);
    if (r.spawnError) return { ...base, unusable: true, output: output || String((r.spawnError as Error).message || r.spawnError) };
    // 逾時不算「跑出問題」:多半是腳本自己寫了無窮迴圈或等在 I/O 上,不是被審查的程式有錯
    if (r.timedOut) return { ...base, unusable: true, timedOut: true, output };
    return { ...base, passed: r.code === 0, code: typeof r.code === 'number' ? r.code : null, output };
  } finally {
    await fs.promises.rm(file, { force: true }).catch(() => {});
  }
}

// 依序跑一批反例。刻意不平行:它們跑在同一個工作目錄上,而反例本身可以寫檔
// (例如要重現「寫入後讀回來不對」),平行跑會互相影響,量到的就不是各自的結果。
export async function runCounterexamples(
  cwd: string,
  list: Counterexample[],
  locale: TextLocale = 'zh-Hant',
  stop?: (child: unknown) => void,
  cancelled: () => boolean = () => false,
): Promise<CounterexampleRun[]> {
  const out: CounterexampleRun[] = [];
  for (const ce of list) {
    if (cancelled()) { out.push({ ...ce, passed: false, code: null, output: tx(locale, 'ce.stopped'), timedOut: false, unusable: true }); continue; }
    out.push(await runCounterexample(cwd, ce, locale, stop, cancelled));
  }
  return out;
}

// 確認階段的判定:反例要在「現在這份程式」上跑出問題,才算確認了審查者說的那件事。
//
//   confirmed    跑出問題(非零結束):這一條是真的,拿去當關卡。
//   unsubstantiated 竟然通過:審查者說得出問題,卻舉不出可重現的例子。不拿去逼人修,但要說出來。
//   unusable     腳本本身沒跑成:兩邊都不算。
export function classifyConfirmation(run: CounterexampleRun): 'confirmed' | 'unsubstantiated' | 'unusable' {
  if (run.unusable) return 'unusable';
  return run.passed ? 'unsubstantiated' : 'confirmed';
}

// 給模型看的一段文字:修復回合拿到的是「這段腳本現在會這樣壞」,不是「審查者覺得哪裡不對」。
// 反例的原始碼一起附上——要修的人得看得到是什麼輸入才重現得出來。
export function counterexampleNotes(runs: CounterexampleRun[], locale: TextLocale = 'zh-Hant'): string | null {
  const confirmed = runs.filter((run) => classifyConfirmation(run) === 'confirmed');
  if (!confirmed.length) return null;
  const items = confirmed.map((run) => tx(locale, 'ce.fixItem', {
    title: run.title || tx(locale, 'ce.untitled'),
    reviewer: run.reviewerName,
    source: run.source,
    output: run.output || tx(locale, 'ce.noOutput'),
    code: String(run.code ?? '?'),
  }));
  return tx(locale, 'ce.fixNotes', { list: items.join('\n\n') });
}

// 給審查者/複查者看的一段文字:修復之後每個反例現在是什麼狀態
export function counterexampleStatus(runs: CounterexampleRun[], locale: TextLocale = 'zh-Hant'): string | null {
  if (!runs.length) return null;
  const items = runs.map((run) => {
    const key = run.unusable ? 'ce.statusUnusable' : run.passed ? 'ce.statusPassed' : 'ce.statusFailed';
    return tx(locale, key, { title: run.title || tx(locale, 'ce.untitled'), output: run.output || tx(locale, 'ce.noOutput') });
  });
  return tx(locale, 'ce.status', { list: items.join('\n') });
}
