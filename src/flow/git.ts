// 工作目錄的 git 變更:給總結用的清單。不是 git repo 時安靜回 null,不影響主流程
import { execFile } from 'child_process';
import { gitAvailability } from '../git-check';
import { RUNTIME_DIR } from '../attachments';
import { tx } from '../text';
import type { TextLocale } from '../text';
import type { GitStatus } from './types';

const MAX_GIT_FILES = 200;      // 總結提示裡最多列出的變更檔案數

// ---------- git 變更 ----------
// 讀工作目錄的 git 變更;不是 git repo、找不到 git、逾時都安靜回 null,絕不影響主流程。
export async function gitStatus(cwd: string): Promise<GitStatus | null> {
  // git 不能用時連叫都不要叫:沒裝開發者工具的 Mac 上,每一次呼叫都可能彈出一個系統安裝視窗
  if (!(await gitAvailability()).ok) return null;
  return new Promise((resolve) => {
    try {
      // --untracked-files=all:預設的 normal 模式會把整個未追蹤目錄收合成「?? dir/」,拿不到檔案清單
      // -z:以 NUL 分隔、完全不加引號或跳脫。預設輸出會把中文檔名轉成 "\345\255\220…" 這種
      // 八進位跳脫碼,拿去讀檔一定失敗;工作目錄是中文資料夾時,show-prefix 輸出的正常中文
      // 還會對不上那些跳脫碼,整批檔案都被丟掉。
      execFile('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        resolve(err ? null : parsePorcelain(stdout));
      });
    } catch { resolve(null); }
  });
}

// -z 格式:每筆是「XY 路徑」,以 NUL 結尾。改名/複製(X 或 Y 是 R、C)時,後面再跟一筆
// 原本的路徑——那一筆不是獨立的變更,要跳過(實測:「RM 新.md\0舊.md\0」)。
function parsePorcelainZ(text: string): GitStatus {
  const out: GitStatus = new Map();
  const fields = text.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const file = entry.slice(3);
    if (file) out.set(file, xy.trim());
    if (/[RC]/.test(xy)) i++; // 跳過緊接著的原路徑
  }
  return out;
}

// 「XY path」→ Map(path → status);rename 取新路徑。
// 兩種格式都收:-z(實際執行時用的,NUL 分隔、路徑原樣)與舊的換行格式(保留給既有呼叫端)。
export function parsePorcelain(stdout: unknown): GitStatus {
  const text = String(stdout || '');
  if (text.includes('\0')) return parsePorcelainZ(text);
  const out: GitStatus = new Map();
  for (const line of String(stdout || '').split('\n')) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2).trim();
    let file = line.slice(3).trim();
    const arrow = file.indexOf(' -> ');
    if (arrow >= 0) file = file.slice(arrow + 4).trim();
    file = file.replace(/^"(.*)"$/, '$1');
    if (file) out.set(file, status);
  }
  return out;
}

// 執行前後的「檔名集合差集」不足以歸因:本來就是 M 的檔案再被改,前後仍然都是 M。
// 平行執行下也無法把變更歸給某一位成員。因此只回報執行結束時的工作區狀態,
// 並標出哪些檔案在執行前就已經是變更狀態,讓總結不會過度宣稱。
// 附件暫存目錄是本 app 自己放的,不是成員改的檔案,一定要從變更報告排除,
// 否則使用者上傳的圖會被當成「執行階段產生的變更」。
// 比對路徑的每一段,不只開頭:工作目錄是 repo 的子資料夾時,porcelain 給的是
// 「sub/.roundtable-runtime/…」,只看開頭的話總結會把 app 自己的附件暫存列成成員的改動。
const isRuntimePath = (file: string) => file.split('/').includes(RUNTIME_DIR);

export function describeGitChanges(before: GitStatus | null, after: GitStatus | null, locale: TextLocale = 'zh-Hant') {
  if (!after || after.size === 0) return null;
  const visible = [...after].filter(([file]) => !isRuntimePath(file));
  if (visible.length === 0) return null;
  const lines: string[] = [];
  for (const [file, status] of visible) {
    // -uall 展開未追蹤目錄後檔案數可能很多(例如工作目錄沒有 .gitignore),不能讓清單灌爆總結提示
    if (lines.length >= MAX_GIT_FILES) { lines.push(tx(locale, 'git.more', { n: visible.length - MAX_GIT_FILES })); break; }
    const pre = before && before.has(file);
    lines.push(`- \`${status || '??'}\` ${file}${pre ? tx(locale, 'git.preexisting') : ''}`);
  }
  return lines.join('\n');
}
