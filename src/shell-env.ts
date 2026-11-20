import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { tx, type TextLocale } from './text';

const MAC_EXEC_BUNDLE_RE = /\.(app|command|tool|action|workflow|prefpane|qlgenerator|saver|plugin|kext|framework|xpc)$/i;
const ENV_MARKER = '__AI_ROUNDTABLE_ENV__';
const SKIP_ENV_KEYS = /^(_|SHLVL|PWD|OLDPWD)$/;

export function defaultExtraPaths(homedir = os.homedir()): string[] {
  return [
    path.join(homedir, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(homedir, '.npm-global/bin'),
  ];
}

export function mergePathEntries(preferred: readonly string[], currentPath: string | undefined): string {
  const seen = new Set<string>();
  return [...preferred, ...(currentPath || '').split(':')]
    .filter((entry) => entry && !seen.has(entry) && (seen.add(entry), true))
    .join(':');
}

export function parseShellEnvOutput(output: string, marker = ENV_MARKER): Record<string, string> {
  const idx = output.indexOf(marker);
  if (idx < 0) return {};
  const payload = output.slice(idx + marker.length);
  const out: Record<string, string> = {};
  if (payload.includes('\0')) {
    for (const record of payload.split('\0')) {
      if (!record) continue;
      const eq = record.indexOf('=');
      if (eq <= 0) continue;
      const key = record.slice(0, eq).replace(/^\r?\n/, '');
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = record.slice(eq + 1);
    }
    return out;
  }
  let currentKey: string | null = null;
  for (const line of payload.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) {
      currentKey = m[1];
      out[currentKey] = m[2];
    } else if (currentKey) {
      out[currentKey] += '\n' + line;
    }
  }
  return out;
}

// 從 Finder / Dock 啟動時環境變數很精簡:先同步補上常見安裝路徑讓立即可用,
// 再非同步啟動登入 shell 取回 nvm / conda / API key 等環境變數,避免阻塞視窗啟動。
// 透過 /bin/sh 呼叫 env -0,讓 fish / tcsh 等非 POSIX 登入 shell 也能穩定解析多行變數。
export async function importShellEnvAsync(
  targetEnv: NodeJS.ProcessEnv = process.env,
  { shellBin = targetEnv.SHELL || '/bin/zsh', timeoutMs = 5000 }: { shellBin?: string; timeoutMs?: number } = {},
): Promise<void> {
  const baseExtra = defaultExtraPaths();
  targetEnv.PATH = mergePathEntries(baseExtra, targetEnv.PATH);
  const probeCmd = `/bin/sh -c 'printf "%s" "${ENV_MARKER}"; /usr/bin/env -0 2>/dev/null || /usr/bin/env'`;
  const runProbe = (flags: string[]) => new Promise<string | null>((resolve) => {
    execFile(shellBin, [...flags, probeCmd], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(!err && stdout && stdout.includes(ENV_MARKER) ? stdout : null);
    });
  });
  // 優先跑 -ilc(有些使用者把 nvm 放在 .zshrc 而非 .zprofile);非互動不支援時退回 -lc,最後退回 /bin/zsh
  let out = await runProbe(['-i', '-l', '-c']);
  if (!out) out = await runProbe(['-l', '-c']);
  if (!out && shellBin !== '/bin/zsh' && fs.existsSync('/bin/zsh')) {
    out = await new Promise<string | null>((resolve) => {
      execFile('/bin/zsh', ['-i', '-l', '-c', probeCmd], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        resolve(!err && stdout && stdout.includes(ENV_MARKER) ? stdout : null);
      });
    });
  }
  if (!out) return;
  const parsed = parseShellEnvOutput(out, ENV_MARKER);
  const extra = parsed.PATH ? [...parsed.PATH.split(':'), ...baseExtra] : baseExtra;
  targetEnv.PATH = mergePathEntries(extra, targetEnv.PATH);
  for (const [k, v] of Object.entries(parsed)) {
    if (k !== 'PATH' && targetEnv[k] === undefined && !SKIP_ENV_KEYS.test(k)) targetEnv[k] = v;
  }
}

// shell:openPath 只用來打開工作資料夾。macOS 的 .app 在檔案系統上也是 directory,
// 直接交給 shell.openPath 會啟動應用程式;一般檔案(.command 等)也會被直接執行。
export async function validateDirectoryToOpen(
  rawPath: unknown,
  locale: TextLocale = 'zh-Hant',
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const trimmed = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!trimmed) return { ok: false, error: tx(locale, 'main.notDirectory') };
  const resolved = path.resolve(trimmed);
  if (MAC_EXEC_BUNDLE_RE.test(resolved)) return { ok: false, error: tx(locale, 'main.notDirectory') };
  try {
    const st = await fs.promises.stat(resolved);
    if (!st.isDirectory()) return { ok: false, error: tx(locale, 'main.notDirectory') };
    const real = await fs.promises.realpath(resolved);
    if (MAC_EXEC_BUNDLE_RE.test(real)) return { ok: false, error: tx(locale, 'main.notDirectory') };
    return { ok: true, path: real };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
