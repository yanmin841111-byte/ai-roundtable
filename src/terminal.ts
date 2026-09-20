// 終端分頁的後端:每個分頁一個互動式 shell,跑在真正的 pty 上。
//
// pty 由 macOS 內建的 expect 借來(見 src/pty.exp),所以這個 app 仍然沒有任何原生相依。
// 這裡只負責:開分頁、轉送輸入輸出、改大小、關掉,以及確保 app 結束時不留孤兒行程。

import { spawn, execFile } from 'child_process';
import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const EXPECT_BIN = '/usr/bin/expect';
const STTY_BIN = '/bin/stty';

export const MAX_SESSIONS = 6;
const COLS = { min: 20, max: 500, fallback: 80 };
const ROWS = { min: 5, max: 300, fallback: 24 };
// expect 起來之後才寫 tty 檔,所以用輪詢等它出現
const TTY_POLL_MS = 25;
const TTY_TIMEOUT_MS = 5000;

// 終端裡跑的是使用者自己的指令,不該看到這個 app 的內部環境:
// ELECTRON_RUN_AS_NODE 會讓在終端裡打 electron 的人拿到 node,
// AI_ROUNDTABLE_* 是測試與截圖用的旗標,兩者都不屬於使用者的 shell。
const DROP_ENV = /^(ELECTRON_RUN_AS_NODE|ELECTRON_NO_ATTACH_CONSOLE|NODE_OPTIONS|AI_ROUNDTABLE_.*)$/;

export interface CreateOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  shell?: string;
}

export interface SessionInfo {
  id: string;
  /** 實際使用的工作目錄(要求的目錄不存在時會退回家目錄) */
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
}

export type CreateResult =
  | { ok: true; session: SessionInfo }
  | { ok: false; code: 'noExpect' | 'tooMany' | 'spawnFailed'; detail?: string };

interface Session extends SessionInfo {
  proc: ChildProcess;
  /** expect 回報的 slave 裝置路徑;還沒拿到時是 null */
  tty: string | null;
  /** 在拿到 tty 之前要求過的大小,拿到後補套用 */
  wantedSize: { cols: number; rows: number } | null;
  closing: boolean;
}

const clamp = (value: unknown, range: { min: number; max: number; fallback: number }): number => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return range.fallback;
  return Math.min(range.max, Math.max(range.min, n));
};

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!DROP_ENV.test(key)) env[key] = value;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  if (!env.LANG) env.LANG = 'en_US.UTF-8';
  // 讓使用者(與他們的 shell 提示字元)看得出這個終端是從哪裡開的
  env.AI_ROUNDTABLE_TERMINAL = '1';
  return env;
}

/**
 * 終端分頁的集合。事件:
 *   data  { id, data }  pty 的原始輸出(Buffer,不解碼:多位元組字元可能被切在兩塊之間)
 *   exit  { id, code }  shell 結束或分頁被關掉
 */
export class TerminalManager extends EventEmitter {
  private sessions = new Map<string, Session>();
  // 放 pty.exp 與 tty 檔的暫存目錄。打包後 pty.exp 在 asar 裡,expect 讀不到,
  // 所以一律複製一份出來再跑。
  private dir: string | null = null;
  private scriptFile = '';

  private workspace(): string {
    if (this.dir && fs.existsSync(this.dir)) return this.dir;
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-roundtable-pty-'));
    this.scriptFile = path.join(this.dir, 'pty.exp');
    fs.writeFileSync(this.scriptFile, fs.readFileSync(path.join(__dirname, 'pty.exp')), { mode: 0o600 });
    return this.dir;
  }

  create(options: CreateOptions = {}): CreateResult {
    if (this.sessions.size >= MAX_SESSIONS) return { ok: false, code: 'tooMany' };
    if (!fs.existsSync(EXPECT_BIN)) return { ok: false, code: 'noExpect' };

    const cols = clamp(options.cols, COLS);
    const rows = clamp(options.rows, ROWS);
    const shell = options.shell || process.env.SHELL || '/bin/zsh';
    const cwd = resolveCwd(options.cwd);
    const id = crypto.randomUUID();

    let proc: ChildProcess;
    let ttyFile: string;
    try {
      const dir = this.workspace();
      ttyFile = path.join(dir, `${id}.tty`);
      // 最後一個參數是自己的 pid:app 被強制結束時 pty.exp 會發現呼叫者不見了,自己收掉 shell
      proc = spawn(EXPECT_BIN, ['-f', this.scriptFile, '--', ttyFile, String(rows), String(cols), shell, String(process.pid)], {
        cwd,
        env: childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      return { ok: false, code: 'spawnFailed', detail: error instanceof Error ? error.message : String(error) };
    }

    const session: Session = { id, cwd, shell, cols, rows, proc, tty: null, wantedSize: null, closing: false };
    this.sessions.set(id, session);

    proc.stdout?.on('data', (chunk: Buffer) => this.emit('data', { id, data: chunk }));
    // expect 自己的錯誤(例如 shell 不存在)也要讓使用者看到,不然分頁只會無聲無息地關掉
    proc.stderr?.on('data', (chunk: Buffer) => this.emit('data', { id, data: chunk }));
    proc.on('error', (error: Error) => {
      this.emit('data', { id, data: Buffer.from(`\r\n${error.message}\r\n`) });
    });
    proc.on('exit', (code) => {
      this.sessions.delete(id);
      try { fs.rmSync(ttyFile, { force: true }); } catch {}
      this.emit('exit', { id, code: typeof code === 'number' ? code : 0 });
    });

    void this.readTty(session, ttyFile);
    return { ok: true, session: { id, cwd, shell, cols, rows } };
  }

  // expect 一 spawn 好就把 slave 裝置路徑寫進檔案;拿到之後才有辦法改大小。
  private async readTty(session: Session, ttyFile: string): Promise<void> {
    const deadline = Date.now() + TTY_TIMEOUT_MS;
    while (Date.now() < deadline && this.sessions.has(session.id)) {
      try {
        const value = fs.readFileSync(ttyFile, 'utf8').trim();
        if (value.startsWith('/dev/')) {
          session.tty = value;
          fs.rmSync(ttyFile, { force: true });
          const wanted = session.wantedSize;
          if (wanted) { session.wantedSize = null; this.resize(session.id, wanted.cols, wanted.rows); }
          return;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, TTY_POLL_MS));
    }
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session || session.closing) return;
    session.proc.stdin?.write(data);
  }

  /** 改 pty 的大小。改 slave 的 winsize 會讓前景程式收到 SIGWINCH,vim / top 因此跟著重畫。 */
  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session || session.closing) return;
    const c = clamp(cols, COLS);
    const r = clamp(rows, ROWS);
    if (session.cols === c && session.rows === r && session.tty) return;
    session.cols = c;
    session.rows = r;
    if (!session.tty) { session.wantedSize = { cols: c, rows: r }; return; }
    execFile(STTY_BIN, ['-f', session.tty, 'rows', String(r), 'cols', String(c)], () => {});
  }

  close(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.closing = true;
    // expect 收到 SIGTERM 會先送走 shell 再退出(見 src/pty.exp);
    // 萬一它沒反應,兩秒後直接 SIGKILL。
    try { session.proc.kill('SIGTERM'); } catch {}
    const timer = setTimeout(() => { try { session.proc.kill('SIGKILL'); } catch {} }, 2000);
    session.proc.once('exit', () => clearTimeout(timer));
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
    // 暫存目錄裡只有 pty.exp 與尚未讀走的 tty 檔,直接整個刪掉
    if (this.dir) { try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch {} }
    this.dir = null;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map(({ id, cwd, shell, cols, rows }) => ({ id, cwd, shell, cols, rows }));
  }

  has(id: string): boolean { return this.sessions.has(id); }
  get size(): number { return this.sessions.size; }
}

// 工作目錄還沒建立時先建;建不起來(權限、路徑被佔用)就退回家目錄,
// 而不是讓整個分頁開不起來。
export function resolveCwd(wanted: string | undefined): string {
  const home = os.homedir();
  const dir = (wanted || '').trim();
  if (!dir) return home;
  try {
    if (fs.statSync(dir).isDirectory()) return dir;
  } catch {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {}
  }
  return home;
}
