// 把工作目錄目前的檔案改動讀成結構化資料,供介面做紅綠 diff 呈現。
//
// 為什麼要有這個:成員可以直接改使用者的檔案,但介面原本只看得到成員「說」它改了什麼。
// 說的和做的不一致時使用者無從發現,只能自己去終端機下 git diff。這裡把實際改動撈出來,
// 讓「改了哪些檔、每一行是新增還是刪除」變成介面上看得到的事實。
//
// 唯讀:只讀 git 的輸出,不做 add / checkout / stash 等任何會動到使用者版本控制狀態的事。
// 一律非同步:這支在 Electron 主程序裡跑,同步執行 git 會凍結整個視窗。

import { execFile } from 'child_process';
import fs from 'fs';
import type { DiffFile, DiffFileStatus, DiffLine, DiffResult } from './ipc-types';

// 逐檔行數上限。單一檔案動輒上萬行時,渲染成 DOM 會讓介面整個卡住,
// 而且使用者也不可能在這種介面裡讀完;超過就截斷並明講只顯示前段。
const MAX_LINES_PER_FILE = 800;
// 檔案數上限:避免第一次跑在巨大的 repo 上就把 IPC 訊息撐爆。
// 超過時回傳的 totalFiles 會大於 files.length,介面必須據此說明「只顯示前 N 個」。
const MAX_FILES = 300;
// git 自己的輸出上限(bytes)。預設 1MB 的 stdout buffer 在大型 diff 會直接丟例外。
const MAX_BUFFER = 32 * 1024 * 1024;
// 未追蹤檔要逐檔問 git(--no-index 一次只吃一對路徑)。併發開太多會讓機器瞬間長出
// 上百個 git 程序,開太少又慢;8 個在一般專案上足夠,也不至於拖垮機器。
const UNTRACKED_CONCURRENCY = 8;
// 單一 git 指令的逾時。到期就放棄那一項,不讓介面無限等下去。
const GIT_TIMEOUT_MS = 20000;

function git(cwd: string, args: string[], { allowDiffExit = false } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      // git 可能會想開 pager 或問帳密;在 GUI 子程序裡兩者都會變成永遠不回來的卡死
      env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
      timeout: GIT_TIMEOUT_MS,
    }, (error: any, stdout) => {
      // diff 系列指令「有差異」時回 exit code 1,那不是錯誤
      if (error && !(allowDiffExit && error.code === 1)) return reject(error);
      resolve(stdout || '');
    });
  });
}

// "a/path b/path" → 兩側路徑。路徑可能含空白,所以不能直接用空白切。
function pathsFromGitHeader(line: string): { old: string; new: string } {
  // 最常見的情況是兩側同名,用反向參照可以完整處理含空白的路徑
  const same = line.match(/^a\/(.+) b\/\1$/);
  if (same) return { old: same[1], new: same[1] };
  // 改名或複製時兩側不同名。真的含有 " b/" 字樣的路徑會被 git 加上引號,
  // 那種情況下 ---/+++ 或 rename from/to 會提供正確答案,由呼叫端優先採用。
  if (line.startsWith('a/')) {
    const i = line.indexOf(' b/');
    if (i > 0) return { old: line.slice(2, i), new: line.slice(i + 3) };
  }
  return { old: '', new: '' };
}

function statusFromHeader(header: string[], hasOld: boolean, hasNew: boolean, hasPathLines: boolean): DiffFileStatus {
  if (header.some((l) => l.startsWith('rename from '))) return 'renamed';
  if (header.some((l) => l.startsWith('new file mode'))) return 'added';
  if (header.some((l) => l.startsWith('deleted file mode'))) return 'deleted';
  // 只有在真的有 ---/+++ 可讀時才用它們推斷。二進位檔與純權限變更沒有這兩行,
  // 這時「看不到舊檔路徑」不代表是新增檔——照舊邏輯會把改圖誤報成新增。
  if (hasPathLines) {
    if (!hasOld) return 'added';
    if (!hasNew) return 'deleted';
  }
  return 'modified';
}

// 解析 unified diff。一次 git diff 的輸出會含多個檔案,以 "diff --git" 分段。
export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  if (!patch) return files;
  // split 後第一段是 "diff --git" 之前的內容(通常是空的),丟掉
  const chunks = patch.split(/^diff --git /m).slice(1);
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const header: string[] = [];
    let i = 0;
    for (; i < lines.length; i++) {
      if (lines[i].startsWith('@@')) break;
      header.push(lines[i]);
    }
    const oldLine = header.find((l) => l.startsWith('--- '));
    const newLine = header.find((l) => l.startsWith('+++ '));
    const renameTo = header.find((l) => l.startsWith('rename to '));
    const renameFrom = header.find((l) => l.startsWith('rename from '));
    const strip = (l: string | undefined, prefix: string) => {
      if (!l) return '';
      const v = l.slice(prefix.length).trim();
      if (v === '/dev/null') return '';
      return v.replace(/^[ab]\//, '');
    };
    const fromPathLines = { old: strip(oldLine, '--- '), new: strip(newLine, '+++ ') };
    // ---/+++ 最可靠;沒有這兩行(二進位、純 mode 變更)時退回 "diff --git" 標頭
    const fromHeader = pathsFromGitHeader(lines[0] || '');
    const oldPath = renameFrom ? renameFrom.slice('rename from '.length).trim() : (fromPathLines.old || fromHeader.old);
    const newPath = renameTo ? renameTo.slice('rename to '.length).trim() : (fromPathLines.new || fromHeader.new);
    const hasPathLines = !!(oldLine || newLine);
    const status = statusFromHeader(header, !!fromPathLines.old, !!fromPathLines.new, hasPathLines);
    const binary = header.some((l) => l.startsWith('Binary files') || l.startsWith('GIT binary patch'));
    const path = newPath || oldPath;
    if (!path) continue;

    const body: DiffLine[] = [];
    let added = 0;
    let removed = 0;
    let truncated = false;
    for (; i < lines.length; i++) {
      const line = lines[i];
      // 最後一段的結尾會多一個空字串,不是真的空白行
      if (line === '' && i === lines.length - 1) continue;
      let kind: DiffLine['kind'];
      let text: string;
      if (line.startsWith('@@')) { kind = 'hunk'; text = line; }
      else if (line.startsWith('+')) { kind = 'add'; text = line.slice(1); added++; }
      else if (line.startsWith('-')) { kind = 'del'; text = line.slice(1); removed++; }
      // "\ No newline at end of file" 是 git 的註記,不是檔案內容
      else if (line.startsWith('\\')) continue;
      else { kind = 'ctx'; text = line.startsWith(' ') ? line.slice(1) : line; }
      // 行數雖然截斷,+/- 統計仍要繼續數完,否則摘要的數字會是錯的
      if (body.length < MAX_LINES_PER_FILE) body.push({ kind, text });
      else truncated = true;
    }
    const file: DiffFile = { path, status, added, removed, lines: body };
    if (status === 'renamed' && oldPath && oldPath !== path) file.oldPath = oldPath;
    if (binary) file.binary = true;
    if (truncated) file.truncated = true;
    files.push(file);
  }
  return files;
}

// 以固定併發跑完整個清單。Promise.all 一次噴出幾百個 git 程序,
// 逐一 await 又太慢,這裡取中間值。
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
  });
  await Promise.all(workers);
  return out;
}

export async function collectChanges(workDir: string): Promise<DiffResult> {
  if (!workDir || !fs.existsSync(workDir)) return { ok: false, reason: 'no-workdir' };
  try {
    const inside = (await git(workDir, ['rev-parse', '--is-inside-work-tree'])).trim();
    if (inside !== 'true') return { ok: false, reason: 'not-a-repo' };
  } catch (e: any) {
    // git 不存在、或這個目錄不是 repo,對使用者來說都是「這裡沒有版本控制,看不到改動」
    return { ok: false, reason: 'not-a-repo', detail: e?.message };
  }

  try {
    // 工作目錄在 repo 裡的位置。git diff 的路徑相對於 repo 根目錄,ls-files 的路徑相對於工作目錄;
    // 兩者要統一,否則同一份清單裡 web/a.ts 和 b.ts 基準不同,點檔名跳轉也會對錯檔案。
    // 只去掉結尾換行:資料夾名稱可以以空白開頭。
    const prefix = (await git(workDir, ['rev-parse', '--show-prefix'])).replace(/\r?\n$/, '');
    // 有沒有 commit 決定要不要跟 HEAD 比:全新的 repo 還沒有 HEAD,
    // 這時所有檔案都是未追蹤的,交給下面的 untracked 流程處理就好。
    let hasHead = true;
    try { await git(workDir, ['rev-parse', '--verify', 'HEAD']); } catch { hasHead = false; }
    // 一次拿 staged + unstaged:對使用者來說「相對上一次 commit 改了什麼」才是有意義的單位,
    // 暫存區的狀態是 git 的內部概念,不該出現在這個介面上。
    const patch = hasHead
      ? await git(workDir, ['-c', 'core.quotepath=false', 'diff', '--no-color', 'HEAD'])
      : '';
    const files = parseUnifiedDiff(patch);

    // 未追蹤的新檔不在 git diff 裡,但它們正是成員新增的檔案——最需要被看到的那一種改動
    const untracked = (await git(workDir, ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0')
      .filter(Boolean);
    const extra = await mapWithLimit(untracked, UNTRACKED_CONCURRENCY, async (rel): Promise<DiffFile> => {
      try {
        const out = await git(workDir, ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-index', '--', '/dev/null', rel], { allowDiffExit: true });
        const parsed = parseUnifiedDiff(out);
        // --no-index 的路徑不帶 a/ b/ 前綴語意,直接用實際的相對路徑覆蓋才不會出現奇怪的檔名
        if (parsed[0]) return { ...parsed[0], path: prefix + rel, status: 'added' };
        return { path: prefix + rel, status: 'added', added: 0, removed: 0, binary: true, lines: [] };
      } catch {
        // 讀不到的單一檔案(權限、symlink 斷鏈)不該讓整份清單失敗
        return { path: prefix + rel, status: 'added', added: 0, removed: 0, binary: true, lines: [] };
      }
    });
    files.push(...extra);

    files.sort((a, b) => a.path.localeCompare(b.path));
    // totalFiles 一定是真實總數:介面靠它才知道自己看到的是不是全部
    return { ok: true, dir: workDir, files: files.slice(0, MAX_FILES), totalFiles: files.length, prefix, source: 'git' };
  } catch (e: any) {
    return { ok: false, reason: 'failed', detail: e?.message || String(e) };
  }
}
