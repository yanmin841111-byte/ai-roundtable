'use strict';

// 啟動真正的 app,在裡面跑一段劇本,回傳結果與截圖。
//
// 為什麼需要這個:這個產品的關鍵行為(成員真的改了檔案、稽核真的進了 transcript、
// 燈號說的是不是真話)只有在完整的 Electron + IPC + renderer 疊起來之後才看得到。
// 單元測試看不到,手動點也重現不了。
//
// 安全前提:userData 與 workDir 一律是拋棄式暫存目錄,絕不碰使用者真正的設定,
// 也絕不碰這個 repo 本身。要用真實模型時只複製 adapter 設定,不複製 config。

import { spawn } from 'child_process';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const REPO_ROOT = path.resolve(__dirname, '..', '..');

export interface HarnessMember {
  id: string;
  name: string;
  cli: string;
  model?: string;
  effort?: string;
  persona?: string;
  color?: string;
  canEdit?: boolean;
  enabled?: boolean;
  customCommand?: string;
}

export interface HarnessOptions {
  members: HarnessMember[];
  /** 工作目錄的初始檔案。key 是相對路徑,value 是內容。 */
  files?: Record<string, string>;
  /** 是否把工作目錄初始化成 git repo(要看紅綠 diff 或用 numstat 獨立驗證時需要) */
  git?: boolean;
  /** 要複製進隔離 userData 的 adapter 設定檔。給絕對路徑,或 'installed:<id>' 取使用者已安裝的那份。 */
  adapters?: string[];
  settings?: Record<string, unknown>;
  /** 額外環境變數(例如故意塞一把無效的 API key) */
  env?: Record<string, string>;
  /** app 啟動前的最後一手(例如把 config.json 改成唯讀,測寫入失敗時介面說什麼) */
  beforeLaunch?: (paths: { tmp: string; userData: string; workDir: string }) => void;
  /**
   * 在 renderer 裡執行的劇本。會被序列化成字串送進去,所以**不能閉包**外部變數——
   * 要傳值請用 `constants`,劇本裡以 `H` 取用。
   * 可以 `await shot('名稱')` 拍照,回傳值會成為 result.value。
   */
  scenario: string | ((H: any) => unknown);
  constants?: Record<string, unknown>;
  timeoutMs?: number;
  /** 結束後保留暫存目錄供檢查(預設保留,因為出事時那是唯一的現場) */
  keepTmp?: boolean;
}

export interface HarnessResult {
  ok: boolean;
  value: any;
  error?: string;
  steps: string[];
  shots: Record<string, string>;
  tmp: string;
  userData: string;
  workDir: string;
  elapsedMs: number;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** 直接讀工作目錄的檔案,用來做不經過 app 的獨立驗證 */
  read(rel: string): string | null;
  /** git diff --numstat,只有 git: true 時有值 */
  numstat(): string;
  cleanup(): void;
}

const DEFAULT_TIMEOUT_MS = 25 * 60 * 1000;

function electronBin(): string {
  return require(path.join(REPO_ROOT, 'node_modules', 'electron')) as unknown as string;
}

function installedAdapterPath(id: string): string {
  return path.join(os.homedir(), 'Library/Application Support/AI Roundtable/adapters', `${id}.json`);
}

// 劇本在 renderer 裡執行時可以用的工具。這段會被原樣插進去,所以只能用 renderer 有的東西。
const PRELUDE = `
// esbuild / tsx 的 keepNames 會把函式包成 __name(fn, "名稱")。劇本是用 .toString()
// 序列化後送進 renderer 的,那個輔助函式不在這邊,所以補一個等價的:它只是原樣回傳。
const __name = (target) => target;
const H = __H_CONSTANTS__;
const api = window.api;
const steps = [];
const w = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (cond, msg) => { if (!cond) throw new Error('失敗:' + msg); steps.push(msg); };
const $ = (sel) => document.querySelector(sel);
const text = (sel) => (($(sel) || {}).textContent || '').replace(/\\s+/g, ' ').trim();
// 拍一張。主程序看到這行 console 就會存檔;等一下讓它拍完。
// 900ms 偶爾不夠:截圖在主程序非同步完成,劇本若緊接著關掉視窗,就會拍到關掉之後的畫面。
const shot = async (name) => { console.log('__SHOT__ ' + name); await w(1500); return name; };
const snapshot = () => api.snapshot();
// 等某個條件成立。畫面很多東西是非同步填上去的,固定 sleep 不是等太久就是不夠。
const waitFor = async (fn, ms = 15000, what = '條件') => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await fn(); if (v) return v; await w(200); }
  throw new Error('等不到:' + what);
};
// 等 app 閒置(一場會議跑完)。上限跟著這次 runApp 的 timeoutMs 走,不另外寫死:
// 寫死過 20 分鐘,結果本機模型開了思考之後一場會議要更久,劇本先放棄、整次跑被記成失敗,
// 而失敗的跑不計分——等於「跑得慢的那些」會被系統性地丟掉,剩下的樣本偏向簡單的情況。
const waitIdle = async (limitMs = __WAIT_IDLE_MS__) => {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    const s = await snapshot();
    if (!s.running) return s;
    await w(400);
  }
  throw new Error('會議在時限內沒有結束');
};
// 介面初始化完成(IPC 回來、事件綁好)才算真的可以操作
const ready = async () => {
  for (let i = 0; i < 300; i++) { if ($('#settings-btn') && $('#settings-btn').onclick) return; await w(100); }
  throw new Error('介面 30 秒內沒有初始化完成');
};
// 送出一則訊息並等整場跑完,回傳這次新增的訊息
const send = async (msg, mode = 'divide', attachments = []) => {
  const before = (await snapshot()).messages.length;
  await api.send(msg, mode, attachments);
  await w(400);
  await waitIdle();
  await w(700);
  return (await snapshot()).messages.slice(before);
};
// 帶 hidden 屬性、卻仍然佔據版面的元素。作者樣式的 display 會蓋掉 [hidden],
// 這個錯誤在本專案出現過好幾次,而且肉眼很難發現(常是一個空框或一段空白)。
// 每個情境結束前都該確認它是空的。
const hiddenLeaks = () => Array.from(document.querySelectorAll('[hidden]'))
  .filter((e) => e.offsetWidth > 0 || e.offsetHeight > 0)
  .map((e) => (e.id ? '#' + e.id : '.' + String(e.className || e.tagName).split(' ')[0]));
// 從訊息陣列抽出工具稽核紀錄,驗「成員真的改了檔案」時最常用
const toolAudits = (msgs) => msgs.filter((m) => m.kind === 'system' && m.tag === 'tool-audit').flatMap((m) => m.toolAudit || []);
// 也掛到 globalThis:劇本用 TypeScript 寫時看不到這裡的區域變數,只能透過 globalThis 取用。
// api 不列入:它是 contextBridge 掛的唯讀屬性,劇本本來就能用 window.api。
Object.assign(globalThis, { H, steps, w, check, $, text, shot, snapshot, waitFor, waitIdle, ready, send, toolAudits, hiddenLeaks });
`;

function buildScenarioSource(opts: HarnessOptions): string {
  const body = typeof opts.scenario === 'string'
    ? opts.scenario
    : `return await (${opts.scenario.toString()})(H);`;
  // 劇本的等待上限比外層的逾時早一分鐘:這樣先喊停的是劇本(訊息看得懂),
  // 而不是外層直接 SIGKILL 掉整個 app(現場什麼都不剩)
  const waitIdleMs = Math.max(60_000, (opts.timeoutMs || DEFAULT_TIMEOUT_MS) - 60_000);
  const prelude = PRELUDE
    .replace('__H_CONSTANTS__', JSON.stringify(opts.constants || {}))
    .replace('__WAIT_IDLE_MS__', String(waitIdleMs));
  // executeJavaScript 取「最後一個運算式」的值,所以整段包成會 resolve 的 async IIFE。
  return `(async () => {\n${prelude}\ntry {\n${body}\n} catch (error) {\n  return { __harness: true, ok: false, error: String((error && error.stack) || error), steps };\n}\n})().then((value) => (value && value.__harness) ? value : { __harness: true, ok: true, value, steps });`;
}

export async function runApp(opts: HarnessOptions): Promise<HarnessResult> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-harness-'));
  const userData = path.join(tmp, 'user-data');
  const workDir = path.join(tmp, 'work');
  const shotDir = path.join(tmp, 'shots');
  fs.mkdirSync(path.join(userData, 'adapters'), { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });

  for (const [rel, content] of Object.entries(opts.files || {})) {
    const full = path.join(workDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  if (opts.git) {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: workDir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'harness@example.com');
    git('config', 'user.name', 'harness');
    git('add', '.');
    // 空目錄也要有一個 commit,否則 git diff HEAD 會炸
    git('commit', '-qm', 'init', '--allow-empty');
  }
  for (const spec of opts.adapters || []) {
    const src = spec.startsWith('installed:') ? installedAdapterPath(spec.slice('installed:'.length)) : spec;
    if (!fs.existsSync(src)) throw new Error(`找不到 adapter 設定:${src}`);
    fs.copyFileSync(src, path.join(userData, 'adapters', path.basename(src)));
  }

  const agents = opts.members.map((m, i) => ({
    id: m.id, name: m.name, cli: m.cli, model: m.model || '', effort: m.effort || '',
    persona: m.persona || '', color: m.color || ['#d97757', '#10a37f', '#4d9de0', '#c678dd'][i % 4],
    canEdit: m.canEdit !== false, enabled: m.enabled !== false, customCommand: m.customCommand || '',
  }));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    agents,
    settings: {
      workDir, maxRounds: 1, mode: 'divide', leadAgentId: agents[0] && agents[0].id,
      language: '繁體中文', maxTranscriptChars: 60000, uiLocale: 'zh-Hant', theme: 'light',
      ...(opts.settings || {}),
    },
  }, null, 2));

  if (opts.beforeLaunch) opts.beforeLaunch({ tmp, userData, workDir });

  const scriptPath = path.join(tmp, 'scenario.js');
  fs.writeFileSync(scriptPath, buildScenarioSource(opts));

  const started = Date.now();
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const run = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(opts.env || {}),
      AI_ROUNDTABLE_E2E_SCRIPT: scriptPath,
      AI_ROUNDTABLE_E2E_SHOT_DIR: shotDir,
      AI_ROUNDTABLE_DEBUG: '1',
    };
    delete env.ELECTRON_RUN_AS_NODE; // 有這個變數時 electron 會以純 node 模式啟動,開不了視窗
    const child = spawn(electronBin(), [REPO_ROOT, `--user-data-dir=${userData}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });

  const line = run.stdout.split('\n').find((l) => l.startsWith('E2E_RESULT '));
  let parsed: any = null;
  try { parsed = line ? JSON.parse(line.slice('E2E_RESULT '.length)) : null; } catch {}

  const shots: Record<string, string> = {};
  for (const f of fs.existsSync(shotDir) ? fs.readdirSync(shotDir) : []) {
    if (f.endsWith('.png')) shots[f.replace(/\.png$/, '')] = path.join(shotDir, f);
  }

  const result: HarnessResult = {
    ok: !!(parsed && parsed.ok) && !run.timedOut,
    value: parsed ? parsed.value : null,
    error: run.timedOut ? `harness 逾時(${Math.round(timeoutMs / 1000)} 秒)` : parsed ? parsed.error : '沒有收到劇本結果',
    steps: (parsed && parsed.steps) || [],
    shots,
    tmp, userData, workDir,
    elapsedMs: Date.now() - started,
    exitCode: run.code,
    timedOut: run.timedOut,
    stdout: run.stdout,
    stderr: run.stderr,
    read: (rel: string) => {
      const full = path.join(workDir, rel);
      return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
    },
    numstat: () => {
      if (!opts.git) return '';
      try { return execFileSync('git', ['diff', '--numstat'], { cwd: workDir, encoding: 'utf8' }).trim(); } catch { return ''; }
    },
    cleanup: () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} },
  };
  if (opts.keepTmp === false) result.cleanup();
  return result;
}

// 把結果印成人看得懂的樣子。劇本失敗時連 stderr 一起給,不必自己去翻暫存目錄。
export function report(name: string, r: HarnessResult): boolean {
  console.log(`\n===== ${name} =====`);
  console.log(`耗時 ${(r.elapsedMs / 1000).toFixed(1)}s · 結束代碼 ${r.exitCode}${r.timedOut ? ' · 逾時' : ''}`);
  for (const s of r.steps) console.log('  ok -', s);
  if (!r.ok) {
    console.log('  失敗:', r.error);
    if (!r.steps.length) console.log('--- stderr(末 1500 字) ---\n' + r.stderr.slice(-1500));
  }
  if (r.value !== null && r.value !== undefined) console.log('  回傳:', JSON.stringify(r.value));
  // 截圖複製到一個固定位置:暫存目錄跑完就會被清掉,但 UI 情境的重點就是那些圖。
  const shotNames = Object.keys(r.shots);
  if (shotNames.length) {
    // 保留中文等文字:以前全換成底線,「等待狀態」和另一個四字情境都會變成 ____ 而互相覆蓋
    // CI 用 AI_ROUNDTABLE_SHOTS_DIR 指到一個會上傳的資料夾:失敗時,截圖就是最直接的證據
    const root = process.env.AI_ROUNDTABLE_SHOTS_DIR || path.join(os.tmpdir(), 'ai-roundtable-shots');
    const dest = path.join(root, name.replace(/[^\p{L}\p{N}._-]/gu, '_'));
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    for (const [n, src] of Object.entries(r.shots)) fs.copyFileSync(src, path.join(dest, `${n}.png`));
    console.log('  截圖:', shotNames.join(', '), '→', dest);
  }
  console.log('  暫存目錄:', r.tmp);
  return r.ok;
}
