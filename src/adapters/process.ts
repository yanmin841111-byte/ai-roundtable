// 行程工具:啟動 CLI、逐行讀取輸出、逾時與整組行程終止。內建轉接器與使用者外掛共用。

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { Readable } from 'stream';

export interface RunProcessOptions {
  cwd?: string;
  stdin?: string | null;
  shell?: boolean;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  killGraceMs?: number;
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

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5000;
const CLI_CHECK_TIMEOUT_MS = 5000;

function truncate(value: unknown, n = 600): string {
  if (!value) return '';
  const s = String(value);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function formatTimeout(timeoutMs: number): string {
  return timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} 秒`;
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
function runProcess(bin: string, args: readonly string[], { cwd, stdin, shell, env, timeoutMs = DEFAULT_TURN_TIMEOUT_MS, killGraceMs = DEFAULT_KILL_GRACE_MS }: RunProcessOptions = {}, cb: RunProcessCallbacks = {}): Promise<ProcessResult> {
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
    child.on('close', (code: number | null) => finish({ code, stderr, timedOut, error: timedOut ? `執行逾時(${formatTimeout(timeoutMs)})` : null }));
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        stderr += `\n執行逾時(${formatTimeout(timeoutMs)}),已送出 SIGTERM。`;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          stderr += '\n逾時行程未結束,已送出 SIGKILL。';
          child.kill('SIGKILL');
          setTimeout(() => finish({ code: -1, stderr, timedOut, error: `執行逾時(${formatTimeout(timeoutMs)})` }), 250);
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
function checkCli(bin: string, args: readonly string[] | null = ['--version']): Promise<CliCheckResult> {
  if (!args) {
    return runQuick('/bin/sh', ['-c', 'command -v "$1"', 'sh', bin]).then((r) =>
      r.ok ? { ok: true, version: r.out.trim() } : { ok: false, error: `找不到指令 ${bin}` });
  }
  return runQuick(bin, args).then((r) =>
    r.ok ? { ok: true, version: r.out.trim().split('\n')[0] } : { ok: false, error: r.error || `找不到指令 ${bin}` });
}

interface QuickResult { ok: boolean; out: string; error?: string }

function runQuick(bin: string, args: readonly string[]): Promise<QuickResult> {
  return new Promise<QuickResult>((resolve) => {
    let out = '';
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
      finish({ ok: false, out, error: '逾時' });
    }, CLI_CHECK_TIMEOUT_MS);
    try { child = attachProcessGroupKill(spawn(bin, args, { detached: true, env: process.env })); } catch (e) { return finish({ ok: false, out, error: String(e) }); }
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    child.on('error', (e: NodeJS.ErrnoException) => finish({ ok: false, out, error: e.code === 'ENOENT' ? `找不到指令 ${bin}` : e.message }));
    child.on('close', (code: number | null) => finish({ ok: code === 0, out }));
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

export { DEFAULT_TURN_TIMEOUT_MS, truncate, formatTimeout, lineReader, parseJson, runProcess, checkCli, createStopHandle };
