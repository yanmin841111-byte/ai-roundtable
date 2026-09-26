// 內建 CLI 的一鍵安裝。renderer 只送 CLI 與安裝方式的代號,實際指令一律取自下面的固定清單,
// 並依這台電腦的系統與已安裝的工具重新驗證,不接受任何外部組出來的指令。

import { execFile } from 'child_process';
import type { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { runProcess } from './adapters/process';
import type { CliInstallMethod, CliInstallPlan, CliInstallResult, InstallTool } from './ipc-types';
import type { TextLocale } from './text';

interface Recipe {
  tool: InstallTool;
  platforms: NodeJS.Platform[];
  // 顯示給使用者確認的指令;official 與 Windows 的 npm 會交給系統 shell 執行這一行
  command: string;
  // brew / winget / npm 以參數陣列執行,不經過 shell
  args?: string[];
  minNode?: number;
}

interface CliRecipe {
  label: string;
  docsUrl: string;
  loginCommand: string;
  detectsLogin: boolean;
  recipes: Recipe[];
}

const POSIX: NodeJS.Platform[] = ['darwin', 'linux'];
const ALL: NodeJS.Platform[] = ['darwin', 'linux', 'win32'];
const WINGET_FLAGS = ['--exact', '--silent', '--accept-source-agreements', '--accept-package-agreements'];
const TOOL_ORDER: InstallTool[] = ['brew', 'winget', 'official', 'npm'];
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

const brew = (cask: string, platforms: NodeJS.Platform[] = ['darwin']): Recipe => ({ tool: 'brew', platforms, command: `brew install --cask ${cask}`, args: ['install', '--cask', cask] });
const winget = (id: string): Recipe => ({ tool: 'winget', platforms: ['win32'], command: `winget install --id ${id} ${WINGET_FLAGS.join(' ')}`, args: ['install', '--id', id, ...WINGET_FLAGS] });
const npm = (pkg: string, minNode?: number): Recipe => ({ tool: 'npm', platforms: ALL, command: `npm install -g ${pkg}`, args: ['install', '-g', pkg], minNode });
const script = (command: string, platforms: NodeJS.Platform[]): Recipe => ({ tool: 'official', platforms, command });

// 來源:各 CLI 官方安裝文件(2026-09 核對)
const CLIS: Record<string, CliRecipe> = {
  claude: {
    label: 'Claude Code',
    docsUrl: 'https://code.claude.com/docs/en/setup',
    loginCommand: 'claude auth login',
    detectsLogin: true,
    recipes: [
      brew('claude-code'),
      winget('Anthropic.ClaudeCode'),
      script('curl -fsSL https://claude.ai/install.sh | bash', POSIX),
      script('irm https://claude.ai/install.ps1 | iex', ['win32']),
      npm('@anthropic-ai/claude-code', 22),
    ],
  },
  codex: {
    label: 'Codex CLI',
    docsUrl: 'https://github.com/openai/codex',
    loginCommand: 'codex login',
    detectsLogin: true,
    recipes: [
      brew('codex'),
      script('curl -fsSL https://chatgpt.com/codex/install.sh | sh', POSIX),
      script('irm https://chatgpt.com/codex/install.ps1 | iex', ['win32']),
      npm('@openai/codex'),
    ],
  },
  copilot: {
    label: 'GitHub Copilot CLI',
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli',
    loginCommand: 'copilot login',
    detectsLogin: false,
    recipes: [
      brew('copilot-cli', POSIX),
      winget('GitHub.Copilot'),
      script('curl -fsSL https://gh.io/copilot-install | bash', POSIX),
      npm('@github/copilot', 22),
    ],
  },
  cursor: {
    label: 'Cursor CLI',
    docsUrl: 'https://cursor.com/docs/cli/installation',
    loginCommand: 'cursor-agent login',
    detectsLogin: false,
    recipes: [
      script('curl https://cursor.com/install -fsS | bash', POSIX),
      script("irm 'https://cursor.com/install?win32=true' | iex", ['win32']),
    ],
  },
};

export interface InstallTools {
  // 找到的執行檔路徑;official 只需要知道可不可用
  brew?: string;
  winget?: string;
  npm?: string;
  official?: boolean;
  nodeMajor?: number | null;
}

export function hasInstaller(cliId: string, platform: NodeJS.Platform = process.platform): boolean {
  return !!CLIS[cliId]?.recipes.some((recipe) => recipe.platforms.includes(platform));
}

function available(recipe: Recipe, platform: NodeJS.Platform, tools: InstallTools): boolean {
  if (!recipe.platforms.includes(platform)) return false;
  if (recipe.tool === 'official') return !!tools.official;
  if (!tools[recipe.tool]) return false;
  return !recipe.minNode || (tools.nodeMajor || 0) >= recipe.minNode;
}

function recipesFor(cliId: string, platform: NodeJS.Platform, tools: InstallTools): Recipe[] {
  const recipes = CLIS[cliId]?.recipes.filter((recipe) => available(recipe, platform, tools)) || [];
  return recipes.sort((a, b) => TOOL_ORDER.indexOf(a.tool) - TOOL_ORDER.indexOf(b.tool));
}

export function installMethods(cliId: string, platform: NodeJS.Platform, tools: InstallTools): CliInstallMethod[] {
  return recipesFor(cliId, platform, tools).map((recipe, index) => ({ tool: recipe.tool, command: recipe.command, recommended: index === 0 }));
}

export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const extensions = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return undefined;
}

function nodeMajor(node: string | undefined): Promise<number | null> {
  if (!node) return Promise.resolve(null);
  return new Promise((resolve) => execFile(node, ['--version'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
    const match = /^v(\d+)/.exec(String(stdout || '').trim());
    resolve(error || !match ? null : Number(match[1]));
  }));
}

export async function detectTools(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<InstallTools> {
  const find = (name: string) => findExecutable(name, env, platform);
  const knownBrew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew', '/home/linuxbrew/.linuxbrew/bin/brew'].find((file) => fs.existsSync(file));
  const npmPath = find('npm');
  return {
    brew: platform === 'win32' ? undefined : find('brew') || knownBrew,
    winget: platform === 'win32' ? find('winget') : undefined,
    npm: npmPath,
    nodeMajor: npmPath ? await nodeMajor(find('node')) : null,
    official: platform === 'win32' ? !!find('powershell') : fs.existsSync('/bin/sh') && !!find('curl') && !!find('bash'),
  };
}

export async function installPlan(cliId: string): Promise<CliInstallPlan | null> {
  const cli = CLIS[cliId];
  if (!cli) return null;
  const tools = await detectTools();
  return {
    cliId,
    label: cli.label,
    platform: process.platform,
    methods: installMethods(cliId, process.platform, tools),
    docsUrl: cli.docsUrl,
    loginCommand: cli.loginCommand,
    detectsLogin: cli.detectsLogin,
  };
}

export function commandLine(recipe: Recipe, platform: NodeJS.Platform, tools: InstallTools): { bin: string; args: string[] } {
  if (recipe.tool === 'official') {
    return platform === 'win32'
      ? { bin: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', recipe.command] }
      : { bin: '/bin/sh', args: ['-c', recipe.command] };
  }
  // Node 20 起不能不經 shell 直接執行 npm.cmd
  if (recipe.tool === 'npm' && platform === 'win32') return { bin: 'cmd.exe', args: ['/d', '/s', '/c', recipe.command] };
  return { bin: tools[recipe.tool] as string, args: recipe.args || [] };
}

// 終端控制碼與進度條的 \r 不屬於紀錄內容
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
function lines(onLine: (line: string) => void) {
  let buffer = '';
  return {
    push(chunk: string) {
      buffer += chunk;
      const parts = buffer.split(/\r\n|\n|\r/);
      buffer = parts.pop() || '';
      for (const part of parts) emit(part);
    },
    flush() { if (buffer) emit(buffer); buffer = ''; },
  };
  function emit(line: string) {
    const clean = line.replace(ANSI, '').trimEnd();
    if (clean.trim()) onLine(clean.slice(0, 400));
  }
}

let active: ChildProcess | null = null;
let busy = false;
let canceled = false;

export async function execute(bin: string, args: string[], onLine: (line: string) => void, { locale, timeoutMs = INSTALL_TIMEOUT_MS }: { locale?: TextLocale; timeoutMs?: number } = {}): Promise<CliInstallResult> {
  canceled = false;
  const stdout = lines(onLine);
  const stderr = lines(onLine);
  const result = await runProcess(bin, args, {
    env: { NONINTERACTIVE: '1', HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1', npm_config_fund: 'false', npm_config_update_notifier: 'false' },
    timeoutMs,
    locale,
  }, {
    onProc: (child) => { active = child; },
    onLine: (line) => stdout.push(`${line}\n`),
    onStderr: (chunk) => stderr.push(chunk),
  });
  stderr.flush();
  active = null;
  if (canceled) return { ok: false, reason: 'canceled' };
  if (result.timedOut) return { ok: false, reason: 'timeout' };
  if (result.spawnError || result.code !== 0) return { ok: false, reason: 'failed', code: result.code, detail: result.spawnError ? String(result.spawnError) : undefined };
  return { ok: true, code: 0 };
}

// Windows 裝完新程式後,這個行程的 PATH 不會自己更新
function refreshWindowsPath(): Promise<void> {
  const script = "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')";
  return new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 10000, windowsHide: true }, (error, stdout) => {
    if (!error) {
      const seen = new Set<string>();
      process.env.PATH = [...String(stdout).trim().split(';'), ...(process.env.PATH || '').split(';')]
        .filter((dir) => dir && !seen.has(dir.toLowerCase()) && seen.add(dir.toLowerCase())).join(';');
    }
    resolve();
  }));
}

export async function runInstall(cliId: string, tool: string, onLine: (line: string) => void, locale?: TextLocale): Promise<CliInstallResult> {
  if (busy) return { ok: false, reason: 'busy' };
  busy = true;
  try {
    const tools = await detectTools();
    const recipe = recipesFor(cliId, process.platform, tools).find((item) => item.tool === tool);
    if (!recipe) return { ok: false, reason: 'unavailable' };
    const { bin, args } = commandLine(recipe, process.platform, tools);
    onLine(`$ ${recipe.command}`);
    const result = await execute(bin, args, onLine, { locale });
    if (result.ok && process.platform === 'win32') await refreshWindowsPath();
    return result;
  } finally {
    busy = false;
  }
}

export function cancelInstall(): void {
  if (!active) return;
  canceled = true;
  active.kill('SIGTERM');
}
