// 工作目錄不是 git repo 時的「檔案改動」。
//
// 「檔案改動」原本只靠 git:相對上一次 commit 改了什麼。可是預設工作區不是 git repo,
// 用預設設定的使用者因此永遠看不到紅綠對照,審查訊息裡的檔名點下去也只看到「不是 git repo」。
// 這裡在任務開始前記下工作目錄裡小型文字檔的內容(只放記憶體,不寫進硬碟),
// 打開「檔案改動」時拿現在的檔案比對,列出這次任務開始以來的改動。
//
// 逐行比對在程式裡做,不呼叫外部的 git:沒有安裝開發工具的 Mac,一執行 git 就會跳出安裝視窗。

import fs from 'fs';
import path from 'path';
import type { DiffFile, DiffLine, DiffResult } from './ipc-types';
import { snapshotDir, diffSnapshots } from './snapshot';
import type { Snapshot } from './snapshot';
import { collectChanges } from './diff';

// 單檔與總量上限:超過的檔案照樣列出,只是標明沒有保存原始內容、無法逐行比對
const BASELINE_FILE_MAX = 256 * 1024;
const BASELINE_TOTAL_MAX = 20 * 1024 * 1024;
const READ_BATCH = 64;
// 與 git 版的「檔案改動」一致
const MAX_FILES = 300;
const MAX_LINES_PER_FILE = 800;
const CONTEXT_LINES = 3;
// 逐行比對的工作量上限:超過就當成整檔替換(畫面最多也只顯示 800 行)
const EDIT_DISTANCE_MAX = 1000;
// 整份清單的比對時間上限。每比完一個檔案就讓出主程序,畫面不會卡;超過上限的檔案照樣列出,
// 只是不逐行比對。一次改了幾百個檔案(例如格式化工具跑過整個專案)時,不能讓使用者等上好幾秒。
const COMPARE_BUDGET_MS = 1500;

export interface TaskBaseline {
  cwd: string;
  root: { path: string; dev: number; ino: number } | null;
  at: number;                    // 任務開始的時間
  snapshot: Snapshot;            // 任務開始前的快照
  contents: Map<string, Buffer>; // 任務開始前的檔案內容(只有在上限內的)
}

const sizeOf = (fingerprint: string) => Number(fingerprint.split(':')[0]) || 0;

async function directoryIdentity(cwd: string): Promise<TaskBaseline['root']> {
  try {
    const real = await fs.promises.realpath(cwd);
    const stat = await fs.promises.lstat(real);
    return stat.isDirectory() ? { path: real, dev: stat.dev, ino: stat.ino } : null;
  } catch { return null; }
}

// 任務開始前:記下快照裡夠小的檔案內容。非同步分批讀,不卡主程序。
export async function captureBaseline(cwd: string, snapshot: Snapshot, { fileMax = BASELINE_FILE_MAX, totalMax = BASELINE_TOTAL_MAX } = {}): Promise<TaskBaseline> {
  const root = await directoryIdentity(cwd);
  const contents = new Map<string, Buffer>();
  if (!root) return { cwd, root, at: Date.now(), snapshot, contents };
  let total = 0;
  const wanted: string[] = [];
  for (const [rel, fp] of snapshot) {
    const size = sizeOf(fp);
    if (size > fileMax || total + size > totalMax) continue;
    total += size;
    wanted.push(rel);
  }
  for (let i = 0; i < wanted.length; i += READ_BATCH) {
    const batch = wanted.slice(i, i + READ_BATCH);
    const bufs = await Promise.all(batch.map((rel) => fs.promises.readFile(path.join(root.path, rel)).catch(() => null)));
    batch.forEach((rel, j) => { const b = bufs[j]; if (b) contents.set(rel, b); });
  }
  return { cwd, root, at: Date.now(), snapshot, contents };
}

// 「檔案改動」:是 git repo 就照舊用 git;不是 repo、或這台機器的 git 根本不能用時,
// 用最近一次任務開始前記下的內容比對——兩種情況下使用者要看的東西是一樣的。
export async function workdirChanges(workDir: string, baseline: TaskBaseline | null): Promise<DiffResult> {
  const viaGit = await collectChanges(workDir);
  if (viaGit.ok || (viaGit.reason !== 'not-a-repo' && viaGit.reason !== 'git-unavailable')) return viaGit;
  if (!baseline || path.resolve(baseline.cwd) !== path.resolve(workDir)) return viaGit;
  return changesSince(baseline);
}

export async function changesSince(baseline: TaskBaseline, { budgetMs = COMPARE_BUDGET_MS } = {}): Promise<DiffResult> {
  const now = await snapshotDir(baseline.cwd);
  const changed = diffSnapshots(baseline.snapshot, now);
  // 工作目錄太大、快照拿不到:照實說失敗,不回一份不完整的清單
  if (!changed || !now) return { ok: false, reason: 'failed', detail: 'snapshot unavailable' };
  const files: DiffFile[] = [];
  let unchanged = 0;
  const started = Date.now();
  for (const rel of changed.slice(0, MAX_FILES)) {
    const file = await fileChange(baseline, now, rel, Date.now() - started > budgetMs);
    if (file) files.push(file); else unchanged++;
    await new Promise((resolve) => setImmediate(resolve)); // 讓出主程序:其他畫面更新、按鈕照常反應
  }
  return { ok: true, dir: baseline.cwd, files, totalFiles: changed.length - unchanged, prefix: '', source: 'task', since: baseline.at };
}

// 回傳 null 代表內容其實沒變(重寫成一模一樣的內容:修改時間變了,但不是改動)
async function fileChange(baseline: TaskBaseline, now: Snapshot, rel: string, overBudget: boolean): Promise<DiffFile | null> {
  const before = baseline.snapshot.has(rel);
  const after = now.has(rel);
  const status: DiffFile['status'] = !before ? 'added' : !after ? 'deleted' : 'modified';
  // 之前不存在就是空的;存在卻沒記下來(超過單檔或總量上限)→ 沒有原始內容
  const old = before ? baseline.contents.get(rel) : Buffer.alloc(0);
  if (old === undefined) return { path: rel, status, added: 0, removed: 0, unavailable: 'not-kept', lines: [] };
  if (after && sizeOf(now.get(rel) || '') > BASELINE_FILE_MAX) return { path: rel, status, added: 0, removed: 0, unavailable: 'too-large', lines: [] };
  const cur = after ? await fs.promises.readFile(path.join(baseline.cwd, rel)).catch(() => null) : Buffer.alloc(0);
  if (cur === null) return { path: rel, status, added: 0, removed: 0, binary: true, lines: [] };
  if (before && after && old.equals(cur)) return null;
  if (isBinary(old) || isBinary(cur)) return { path: rel, status, added: 0, removed: 0, binary: true, lines: [] };
  if (overBudget) return { path: rel, status, added: 0, removed: 0, unavailable: 'too-many', lines: [] };
  return { path: rel, status, ...unifiedLines(toLines(old), toLines(cur)) };
}

// 前 8000 位元組裡有 NUL 就當成二進位,與 git 的判斷方式相同
function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

// 每一行保留自己的換行符號去比對:只改換行(CRLF 換成 LF)、補上檔尾換行,也是改動——git 也這樣算。
// 顯示時才拿掉(見 unifiedLines)。
function toLines(buf: Buffer): string[] {
  const text = buf.toString('utf8');
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') { lines.push(text.slice(start, i + 1)); start = i + 1; }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

const display = (line: string) => line.replace(/\r?\n$/, '');

type Op = { kind: 'ctx' | 'add' | 'del'; text: string };

// Myers 最短編輯路徑,回傳逐行操作。先剝掉共同的頭尾,一般的程式碼修改接近線性;
// 差異太大(編輯距離超過上限)就當成整段替換,不能讓主程序卡住。
export function lineOps(a: string[], b: string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  // 不用 push(...陣列):幾萬行的檔案會超過函式參數的上限,整份清單跟著失敗
  const ctx = (text: string): Op => ({ kind: 'ctx', text });
  return a.slice(0, head).map(ctx).concat(middleOps(A, B), a.slice(a.length - tail).map(ctx));
}

function middleOps(a: string[], b: string[]): Op[] {
  const replaceAll = (): Op[] => [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))];
  if (!a.length || !b.length) return replaceAll();
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, EDIT_DISTANCE_MAX);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  // 每一步只存用到的那一段 [-d, d],記憶體是 O(D²) 而不是 O(D·(N+M))
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d);
    }
  }
  return replaceAll();
}

function backtrack(a: string[], b: string[], trace: Int32Array[], dist: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dist; d > 0; d--) {
    const prev = trace[d]; // 第 d 步開始前的狀態,索引 k + d
    const at = (k: number) => prev[k + d];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX + (down ? 0 : 1) && y > prevY + (down ? 1 : 0)) { ops.push({ kind: 'ctx', text: a[x - 1] }); x--; y--; }
    if (down) { ops.push({ kind: 'add', text: b[y - 1] }); y--; }
    else { ops.push({ kind: 'del', text: a[x - 1] }); x--; }
  }
  while (x > 0 && y > 0) { ops.push({ kind: 'ctx', text: a[x - 1] }); x--; y--; }
  return ops.reverse();
}

// 逐行操作 → 與 git 一樣的區段(前後各 3 行上下文,區段標頭 @@ -l,s +l,s @@)。
// 行數超過上限只帶前段,但增刪統計一定數完整。
export function unifiedLines(a: string[], b: string[]): { added: number; removed: number; lines: DiffLine[]; truncated?: boolean } {
  const ops = lineOps(a, b);
  const added = ops.filter((o) => o.kind === 'add').length;
  const removed = ops.filter((o) => o.kind === 'del').length;
  const lines: DiffLine[] = [];
  let truncated = false;
  const push = (line: DiffLine) => { if (lines.length < MAX_LINES_PER_FILE) lines.push(line); else truncated = true; };
  const changes = ops.map((o, i) => (o.kind === 'ctx' ? -1 : i)).filter((i) => i >= 0);
  let i = 0;
  while (i < changes.length) {
    // 兩處改動之間沒改的行不超過 2×上下文,就合進同一個區段(與 git 相同)
    const start = Math.max(0, changes[i] - CONTEXT_LINES);
    let j = i;
    while (j + 1 < changes.length && changes[j + 1] - changes[j] - 1 <= CONTEXT_LINES * 2) j++;
    const end = Math.min(ops.length, changes[j] + CONTEXT_LINES + 1);
    let oldLine = 1;
    let newLine = 1;
    for (let p = 0; p < start; p++) { if (ops[p].kind !== 'add') oldLine++; if (ops[p].kind !== 'del') newLine++; }
    const slice = ops.slice(start, end);
    const oldCount = slice.filter((o) => o.kind !== 'add').length;
    const newCount = slice.filter((o) => o.kind !== 'del').length;
    push({ kind: 'hunk', text: `@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@` });
    for (const o of slice) push({ kind: o.kind, text: display(o.text) });
    i = j + 1;
  }
  return { added, removed, lines, ...(truncated ? { truncated } : {}) };
}

// 還原這次任務的改動:把工作目錄回到任務開始前的樣子。
//
// 為什麼需要:評測裡一再出現「成員卡住、留下改壞的檔案,流程照樣收尾」,爛攤子留在使用者的
// 工作目錄裡。與其讓人一個一個檔案復原,不如給一條乾淨的退路——這也是 harness 常見的停損:
// 修不好就回到基準點重來,通常比繼續補快,而且乾淨。
//
// 只碰得到基準點認得的檔案:
//   - 基準點有內容的檔案:寫回原本的內容
//   - 任務開始後才出現的檔案:刪掉
//   - 基準點當時就太大而沒有留內容的檔案:不動,並在結果裡列出來(不能假裝還原了)
export interface RevertResult {
  restored: string[];
  deleted: string[];
  // 沒有留下內容、無法還原的檔案(基準點超過大小上限時)
  skipped: string[];
  failed: Array<{ file: string; error: string }>;
}

export async function revertToBaseline(baseline: TaskBaseline): Promise<RevertResult> {
  const out: RevertResult = { restored: [], deleted: [], skipped: [], failed: [] };
  const root = baseline.root;
  if (!root) return { ...out, failed: [{ file: '.', error: 'Working directory identity unavailable' }] };
  const assertRoot = async () => {
    const current = await directoryIdentity(baseline.cwd);
    if (!current || current.path !== root.path || current.dev !== root.dev || current.ino !== root.ino) {
      throw new Error('Working directory identity changed');
    }
  };
  try { await assertRoot(); }
  catch (error) { return { ...out, failed: [{ file: '.', error: String((error as Error).message || error) }] }; }
  const now = await snapshotDir(root.path);
  if (!now) return { ...out, failed: [{ file: '.', error: 'snapshot unavailable' }] };
  const inside = async (rel: string) => {
    await assertRoot();
    const full = path.resolve(root.path, rel);
    const relative = path.relative(root.path, full);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Path outside working directory');
    let current = root.path;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      const stat = await fs.promises.lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (stat?.isSymbolicLink()) throw new Error('Cannot restore through a symbolic link');
    }
    return full;
  };
  // 任務開始後才出現的檔案:刪掉
  for (const rel of now ? now.keys() : []) {
    if (baseline.snapshot.has(rel)) continue;
    try { await fs.promises.rm(await inside(rel), { force: true }); out.deleted.push(rel); }
    catch (e) { out.failed.push({ file: rel, error: String((e as Error).message || e) }); }
  }
  // 基準點裡的檔案:內容不一樣就寫回去
  for (const [rel, fingerprint] of baseline.snapshot) {
    const content = baseline.contents.get(rel);
    if (!content) { if (!now || now.get(rel) !== fingerprint) out.skipped.push(rel); continue; }
    try {
      const full = await inside(rel);
      const same = now && now.get(rel) === fingerprint && (await fs.promises.readFile(full)).equals(content);
      if (same) continue;
      await fs.promises.mkdir(path.dirname(full), { recursive: true });
      await fs.promises.writeFile(full, content, { flag: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW });
      out.restored.push(rel);
    } catch (e) { out.failed.push({ file: rel, error: String((e as Error).message || e) }); }
  }
  return out;
}
