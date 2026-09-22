// 工作目錄的快照:相對路徑 →「大小:修改時間」。
// 交叉審查用它找出成員改了哪些檔案;工作目錄不是 git repo 時,「檔案改動」也靠它。

import fs from 'fs';
import path from 'path';
import { RUNTIME_DIR } from './attachments';
// 反例語料庫(見 corpus.ts):屬於專案、應該跟著專案被 commit,但不是任何成員這次的改動
import { CORPUS_DIR } from './corpus';

// ---------- 工作目錄快照 ----------
// 審查要看的改動 = 執行階段前後,工作目錄裡大小或修改時間變了的檔案(含新增與刪除)。
// 直接看檔案,不經過 git。前幾版用 git status 前後比對,每一輪 code review 都再找到一個盲點:
// 不是 git repo(預設工作區就不是)、被 .gitignore 忽略、巢狀 repo、成員自己 commit、
// 任務前就改過的檔案、中文路徑被跳脫、工作目錄是子資料夾、改到工作目錄外面……
// 快照只看工作目錄本身,這些情況都不存在。只 stat 不讀內容而且非同步:十萬個檔案約 0.5 秒。
const SNAPSHOT_MAX_FILES = 100000;
// 版本控制、相依套件、框架快取與 app 自己的暫存:量大,也不是審查的對象。
// dist、build、vendor 這類名字不略過:有些專案的原始碼就放在裡面。
const SNAPSHOT_SKIP = new Set(['.git', '.hg', '.svn', 'node_modules', 'bower_components', '.venv', 'venv', '__pycache__', '.tox',
  '.next', '.nuxt', '.gradle', 'Pods', '.DS_Store', RUNTIME_DIR, CORPUS_DIR]);
// 依 Cache Directory Tagging 規範標記自己是快取的目錄(例如 Rust 的 target/)也略過
const CACHE_TAG = 'CACHEDIR.TAG';
// app 自己在工作目錄最上層寫的一次性檔案(目前只有審查者的反例腳本,見 counterexample.ts)。
// 它們跑完就刪,但快照可能正好落在執行中間——被算進差異的話,會變成「沒有人寫過的檔案」
// 出現在檔案改動裡,還會被送去語法檢查與審查。用前綴略過,不是用完整檔名:反例一次可能有好幾個。
const SNAPSHOT_SKIP_PREFIX = '.roundtable-ce-';
export type Snapshot = Map<string, string>;

// 相對路徑(以 / 分隔)→「大小:修改時間」。超過上限或工作目錄本身讀不到時回 null(拿不到),
// 不回一份不完整的快照假裝完整。讀不到的子資料夾直接略過:成員以同一個使用者身分執行,
// 那裡它一樣讀不到。符號連結不跟隨,避免繞出工作目錄或繞成迴圈。
export async function snapshotDir(cwd: string, maxFiles = SNAPSHOT_MAX_FILES, strict = false): Promise<Snapshot | null> {
  const out: Snapshot = new Map();
  let over = false;
  const walk = async (rel: string): Promise<void> => {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(rel ? path.join(cwd, rel) : cwd, { withFileTypes: true }); }
    catch (e) { if (!rel || strict) throw e; return; }
    if (rel && entries.some((e) => e.name === CACHE_TAG && e.isFile())) return;
    const files: string[] = [];
    const dirs: string[] = [];
    for (const e of entries) {
      if (SNAPSHOT_SKIP.has(e.name) || e.name.startsWith(SNAPSHOT_SKIP_PREFIX)) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) dirs.push(child);
      else if (e.isFile()) files.push(child);
      else if (strict) { over = true; return; }
    }
    if (out.size + files.length > maxFiles) { over = true; return; }
    const stats = await Promise.all(files.map((f) => fs.promises.stat(path.join(cwd, f)).catch(() => null)));
    if (strict && stats.some((stat) => !stat?.isFile())) { over = true; return; }
    files.forEach((f, i) => { const st = stats[i]; if (st) out.set(f, `${st.size}:${st.mtimeMs}`); });
    for (const d of dirs) { if (over) return; await walk(d); }
  };
  try { await walk(''); } catch { return null; }
  return over ? null : out;
}

// 兩份快照都在才比得出來,任何一份拿不到就是拿不到
export function diffSnapshots(before: Snapshot | null, after: Snapshot | null): string[] | null {
  if (!before || !after) return null;
  const out: string[] = [];
  for (const file of new Set([...before.keys(), ...after.keys()])) if (before.get(file) !== after.get(file)) out.push(file);
  return out.sort();
}

