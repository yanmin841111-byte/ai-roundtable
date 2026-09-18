// 行程工具:啟動 CLI、逐行讀取輸出、逾時與整組行程終止。內建轉接器與使用者外掛共用。

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { Readable } from 'stream';
import { tx, type TextLocale } from '../text';

export interface RunProcessOptions {
  cwd?: string;
  stdin?: string | null;
  shell?: boolean;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  killGraceMs?: number;
  // 逾時等訊息會直接顯示在對話泡泡裡,要跟著介面語言。沒給就用中文(原本的行為)。
  locale?: TextLocale;
}

export interface RunProcessCallbacks {
  onProc?: (child: ChildProcess) => void;
  onLine?: (line: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ProcessResult {
  code: number | null;
  stderr: string;
  timedOut?: boolean;
  error?: string | null;
  spawnError?: unknown;
}

export interface CliCheckResult {
  ok: boolean;
  version?: string;
  error?: string;
}

// ChildProcess 與 createStopHandle 共用的停止介面:kill() 與 'close' 事件。
export interface StopHandle extends EventEmitter {
  kill(signal?: NodeJS.Signals): boolean;
  close(): void;
}

// 單一模型回合的預設上限；模型下載等背景工作應自行管理生命週期與續傳，不套用此值。
const DEFAULT_TURN_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5000;
const CLI_CHECK_TIMEOUT_MS = 5000;

function truncate(value: unknown, n = 600): string {
  if (!value) return '';
  const s = String(value);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// 預設逾時是 20 分鐘,只到「秒」的話使用者看到的是「1200 秒」,得自己心算。
function formatTimeout(timeoutMs: number, locale: TextLocale = 'zh-Hant'): string {
  if (timeoutMs < 1000) return `${timeoutMs} ms`;
  const seconds = Math.round(timeoutMs / 1000);
  if (seconds < 60) return tx(locale, 'proc.seconds', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? tx(locale, 'proc.minutesSeconds', { m: minutes, s: rest }) : tx(locale, 'proc.minutes', { n: minutes });
}

// 逐行讀取串流,忽略空行。
function lineReader(stream: Readable, onLine: (line: string) => void) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.trim()) onLine(line);
    }
  });
  stream.on('end', () => {
    if (buf.trim()) onLine(buf.replace(/\r$/, ''));
  });
}

function parseJson(line: string): any {
  try { return JSON.parse(line); } catch { return null; }
}

type KillFn = (signal?: NodeJS.Signals) => boolean;

function killProcess(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM', nativeKill: KillFn | null = null): boolean {
  if (!child || !child.pid) return false;
  try {
    if (process.platform === 'win32') (nativeKill || child.kill.bind(child))(signal);
    else process.kill(-child.pid, signal);
    return true;
  } catch {
    try { return (nativeKill || child.kill.bind(child))(signal); } catch { return false; }
  }
}

// CLI 可能再開子行程,停止時要整組一起結束。
function attachProcessGroupKill(child: ChildProcess): ChildProcess {
  const nativeKill: KillFn = child.kill.bind(child);
  child.kill = (signal: NodeJS.Signals | number = 'SIGTERM') => killProcess(child, signal as NodeJS.Signals, nativeKill);
  return child;
}

// 啟動行程並逐行回呼 stdout。
// 回傳 { code, stderr, timedOut, error, spawnError }
function runProcess(bin: string, args: readonly string[], { cwd, stdin, shell, env, timeoutMs = DEFAULT_TURN_TIMEOUT_MS, killGraceMs = DEFAULT_KILL_GRACE_MS, locale = 'zh-Hant' }: RunProcessOptions = {}, cb: RunProcessCallbacks = {}): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve) => {
    let child: ChildProcess;
    let settled = false;
    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    try {
      child = attachProcessGroupKill(spawn(bin, args, {
        cwd,
        shell: !!shell,
        detached: true,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }));
    } catch (e) {
      return finish({ code: -1, stderr: String(e), spawnError: e });
    }
    cb.onProc && cb.onProc(child);
    let stderr = '';
    const { stdout, stderr: stderrStream, stdin: stdinStream } = child as ChildProcess & { stdout: Readable; stderr: Readable; stdin: NodeJS.WritableStream };
    stderrStream.setEncoding('utf8');
    stderrStream.on('data', (d: string) => {
      stderr += d;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
      cb.onStderr && cb.onStderr(d);
    });
    child.on('error', (e) => finish({ code: -1, stderr: stderr + '\n' + String(e), spawnError: e }));
    lineReader(stdout, cb.onLine || (() => {}));
    child.on('close', (code: number | null) => finish({ code, stderr, timedOut, error: timedOut ? tx(locale, 'proc.timeout', { time: formatTimeout(timeoutMs, locale) }) : null }));
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        stderr += `\n${tx(locale, 'proc.timeoutSigterm', { time: formatTimeout(timeoutMs, locale) })}`;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          stderr += `\n${tx(locale, 'proc.timeoutSigkill')}`;
          child.kill('SIGKILL');
          setTimeout(() => finish({ code: -1, stderr, timedOut, error: tx(locale, 'proc.timeout', { time: formatTimeout(timeoutMs, locale) }) }), 250);
        }, killGraceMs);
      }, timeoutMs);
    }
    if (stdin != null) {
      stdinStream.on('error', () => {});
      stdinStream.write(stdin);
    }
    stdinStream.end();
  });
}

// 檢查指令是否可用。args 為 null 時只確認指令存在於 PATH。
function checkCli(bin: string, args: readonly string[] | null = ['--version'], locale: TextLocale = 'zh-Hant'): Promise<CliCheckResult> {
  if (!args) {
    return runQuick('/bin/sh', ['-c', 'command -v "$1"', 'sh', bin], locale).then((r) =>
      r.ok ? { ok: true, version: r.out.trim() } : { ok: false, error: tx(locale, 'proc.notFound', { bin }) });
  }
  return runQuick(bin, args, locale).then((r) =>
    r.ok ? { ok: true, version: r.out.trim().split('\n')[0] } : { ok: false, error: r.error || tx(locale, 'proc.notFound', { bin }) });
}

// out 是 stdout+stderr 合併(給 --version 這類只看文字的檢查);stdout 與 code 另外保留,
// 登入檢查要靠它們判斷,不能被 stderr 的雜訊干擾。
interface QuickResult { ok: boolean; out: string; stdout?: string; code?: number | null; error?: string }

// 問 CLI「現在有沒有登入」。只有在 CLI 明確回報沒登入時才回 false;
// 指令不存在(舊版 CLI 沒有這個子指令)、逾時、輸出看不懂都回 null。
// 這個方向是刻意的:誤報「沒登入」會叫已經能用的人去重新登入,比沒偵測到更糟。
// 依 ipc-types 的原則,判斷只看 exit code 與結構化輸出(JSON 欄位),不比對人讀的文案。
function checkLogin(bin: string, args: readonly string[], decide: (r: { code: number | null | undefined; stdout: string }) => boolean | null): Promise<boolean | null> {
  return runQuick(bin, args).then((r) => {
    if (r.error) return null;
    try { return decide({ code: r.code, stdout: r.stdout || '' }); } catch { return null; }
  });
}

function runQuick(bin: string, args: readonly string[], locale: TextLocale = 'zh-Hant'): Promise<QuickResult> {
  return new Promise<QuickResult>((resolve) => {
    let out = '';
    let stdout = '';
    let child: ChildProcess | undefined;
    let settled = false;
    const finish = (result: QuickResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (child) child.kill('SIGTERM');
      finish({ ok: false, out, error: tx(locale, 'proc.checkTimeout') });
    }, CLI_CHECK_TIMEOUT_MS);
    try { child = attachProcessGroupKill(spawn(bin, args, { detached: true, env: process.env })); } catch (e) { return finish({ ok: false, out, error: String(e) }); }
    child.stdout?.on('data', (d) => { out += d; stdout += d; });
    child.stderr?.on('data', (d) => (out += d));
    child.on('error', (e: NodeJS.ErrnoException) => finish({ ok: false, out, error: e.code === 'ENOENT' ? tx(locale, 'proc.notFound', { bin }) : e.message }));
    child.on('close', (code: number | null) => finish({ ok: code === 0, out, stdout, code }));
  });
}

// 給非行程型轉接器(例如 HTTP API)用的停止把手,介面與 ChildProcess 一致:kill() 與 'close' 事件。
function createStopHandle(onKill: () => void): StopHandle {
  const handle = new EventEmitter() as StopHandle;
  let closed = false;
  handle.kill = () => { try { onKill(); } catch {} return true; };
  handle.close = () => { if (!closed) { closed = true; handle.emit('close'); } };
  return handle;
}

export { DEFAULT_TURN_TIMEOUT_MS, truncate, formatTimeout, lineReader, parseJson, runProcess, checkCli, checkLogin, createStopHandle };
