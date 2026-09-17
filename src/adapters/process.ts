'use strict';
// 行程工具:啟動 CLI、逐行讀取輸出、逾時與整組行程終止。內建轉接器與使用者外掛共用。

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5000;
const CLI_CHECK_TIMEOUT_MS = 5000;

function truncate(s: any, n: any = 600) {
  if (!s) return '';
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function formatTimeout(timeoutMs: any) {
  return timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} 秒`;
}

// 逐行讀取串流,忽略空行。
function lineReader(stream: any, onLine: any) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: any) => {
    buf += chunk;
    let idx: any;
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

function parseJson(line: any) {
  try { return JSON.parse(line); } catch { return null; }
}

function killProcess(child: any, signal: any = 'SIGTERM', nativeKill: any = null) {
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
function attachProcessGroupKill(child: any) {
  const nativeKill = child.kill.bind(child);
  child.kill = (signal: any = 'SIGTERM') => killProcess(child, signal, nativeKill);
  return child;
}

// 啟動行程並逐行回呼 stdout。
// 回傳 { code, stderr, timedOut, error, spawnError }
function runProcess(bin: any, args: any, { cwd, stdin, shell, env, timeoutMs = DEFAULT_TURN_TIMEOUT_MS, killGraceMs = DEFAULT_KILL_GRACE_MS }: any = {}, cb: any = {}) {
  return new Promise((resolve: any) => {
    let child: any;
    let settled = false;
    let timedOut = false;
    let timeoutTimer: any = null;
    let killTimer: any = null;

    const finish = (result: any) => {
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
    } catch (e: any) {
      return finish({ code: -1, stderr: String(e), spawnError: e });
    }
    cb.onProc && cb.onProc(child);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: any) => {
      stderr += d;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
      cb.onStderr && cb.onStderr(d);
    });
    child.on('error', (e: any) => finish({ code: -1, stderr: stderr + '\n' + String(e), spawnError: e }));
    lineReader(child.stdout, cb.onLine || (() => {}));
    child.on('close', (code: any) => finish({ code, stderr, timedOut, error: timedOut ? `執行逾時(${formatTimeout(timeoutMs)})` : null }));
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
      child.stdin.on('error', () => {});
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

// 檢查指令是否可用。args 為 null 時只確認指令存在於 PATH。
function checkCli(bin: any, args: any = ['--version']) {
  if (!args) {
    return runQuick('/bin/sh', ['-c', 'command -v "$1"', 'sh', bin]).then((r: any) =>
      r.ok ? { ok: true, version: r.out.trim() } : { ok: false, error: `找不到指令 ${bin}` });
  }
  return runQuick(bin, args).then((r: any) =>
    r.ok ? { ok: true, version: r.out.trim().split('\n')[0] } : { ok: false, error: r.error || `找不到指令 ${bin}` });
}

function runQuick(bin: any, args: any) {
  return new Promise((resolve: any) => {
    let out = '';
    let child: any;
    let settled = false;
    const finish = (result: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (child) child.kill('SIGTERM');
      finish({ ok: false, error: '逾時' });
    }, CLI_CHECK_TIMEOUT_MS);
    try { child = attachProcessGroupKill(spawn(bin, args, { detached: true, env: process.env })); } catch (e: any) { return finish({ ok: false, error: String(e) }); }
    child.stdout.on('data', (d: any) => (out += d));
    child.stderr.on('data', (d: any) => (out += d));
    child.on('error', (e: any) => finish({ ok: false, error: e.code === 'ENOENT' ? `找不到指令 ${bin}` : e.message }));
    child.on('close', (code: any) => finish({ ok: code === 0, out }));
  });
}

// 給非行程型轉接器(例如 HTTP API)用的停止把手,介面與 ChildProcess 一致:kill() 與 'close' 事件。
function createStopHandle(onKill: any) {
  const handle = new EventEmitter();
  let closed = false;
  handle.kill = () => { try { onKill(); } catch {} return true; };
  handle.close = () => { if (!closed) { closed = true; handle.emit('close'); } };
  return handle;
}

module.exports = {
  DEFAULT_TURN_TIMEOUT_MS,
  truncate,
  formatTimeout,
  lineReader,
  parseJson,
  runProcess,
  checkCli,
  createStopHandle,
};
