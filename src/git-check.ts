// 這台電腦上的 git 能不能用。
//
// 為什麼需要:macOS 的 /usr/bin/git 只是個轉接殼,真正的 git 在開發者工具裡。
// 常見的兩種狀況,使用者都不會知道自己踩到了:
//   1. 從來沒裝過開發者工具 → 任何 git 指令都會跳出「要安裝 command line developer tools 嗎」的系統視窗
//   2. 裝了完整版 Xcode 但沒同意授權 → 每個 git 指令都回 exit 69,連 git --version 都不行
// 以前這兩種都被當成「這個資料夾不是 git repo」,畫面於是叫使用者去 git init——照做也不會好。
//
// 所以:先判斷 git 本身能不能用,再決定要不要呼叫它;不能用時給一句照實說的話,
// 以及一行可以在內建終端直接跑的修復指令。

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

export type GitIssue = 'missing' | 'license';

export type GitAvailability =
  | { ok: true }
  | { ok: false; issue: GitIssue; detail?: string };

// Apple 的轉接殼。其他路徑上的 git(Homebrew、MacPorts…)是真的執行檔,不受開發者工具影響。
const APPLE_SHIM = '/usr/bin/git';
const PROBE_TIMEOUT_MS = 5000;

// 結果快取一分鐘:每次要看改動都重新探測太吵,但使用者照著修復指令修好之後,
// 不必重開 app 也會自己恢復(下次探測就看得到)。
const CACHE_MS = 60000;
let cached: { at: number; value: GitAvailability } | null = null;
let pending: Promise<GitAvailability> | null = null;

/** 使用者修好之後要重新判斷(例如在「檔案改動」按重新整理) */
export function resetGitCheck(): void {
  cached = null;
  pending = null;
}

// exit 69 是 EX_UNAVAILABLE:Apple 的工具用它表示「還沒同意授權」。
// 訊息也一起比對,不同 macOS 版本的用字略有差異,但都含 license。
export function classifyGitError(result: { code?: number | null; message?: string }): GitIssue {
  const text = String(result.message || '');
  if (result.code === 69 || /license/i.test(text)) return 'license';
  return 'missing';
}

// PATH 上第一個可執行的 git。找不到就回 null。
function findGit(): string | null {
  for (const dir of String(process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, 'git');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

// 開發者工具的位置。沒裝時 xcode-select 會失敗,而且不會跳出安裝視窗——
// 這正是我們需要的:在「可能會彈視窗」的 git 之前先問它。
function developerDir(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/xcode-select', ['-p'], { timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      resolve(error ? null : String(stdout || '').trim() || null);
    });
  });
}

function probeVersion(bin: string): Promise<GitAvailability> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: PROBE_TIMEOUT_MS }, (error: any) => {
      if (!error) return resolve({ ok: true });
      resolve({ ok: false, issue: classifyGitError({ code: error.code, message: error.message }), detail: error.message });
    });
  });
}

/**
 * git 能不能用。結果快取一分鐘(見 CACHE_MS):探測本身不會彈出系統安裝視窗——
 * 只有 Apple 轉接殼存在、而且 xcode-select 說開發者工具在,才會真的去跑 git。
 */
export async function gitAvailability(): Promise<GitAvailability> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  if (pending) return pending;
  pending = (async (): Promise<GitAvailability> => {
    const bin = findGit();
    if (!bin) return { ok: false, issue: 'missing' };
    // 只有 Apple 的轉接殼時要先確認開發者工具在不在:直接跑它可能會叫出安裝視窗
    if (bin === APPLE_SHIM) {
      const dir = await developerDir();
      if (!dir || !fs.existsSync(path.join(dir, 'usr', 'bin', 'git'))) return { ok: false, issue: 'missing' };
    }
    return probeVersion(bin);
  })();
  const result = await pending;
  cached = { at: Date.now(), value: result };
  pending = null;
  return result;
}

/** 修復指令:照著跑就能把 git 變回可用 */
export function gitFixCommand(issue: GitIssue): string {
  return issue === 'license' ? 'sudo xcodebuild -license accept' : 'xcode-select --install';
}
