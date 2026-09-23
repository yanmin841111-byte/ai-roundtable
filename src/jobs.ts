// 多件獨立任務的排程:同時進行的件數上限、同一個專案目錄互斥、同一台本機模型互斥。
// 這裡只管「誰可以開始」,不碰對話內容;每件任務各自的 Orchestrator 由主程序持有。
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import type { JobBlocker } from './ipc-types';

export interface WorkdirKey {
  path: string;
  // 同一個 repo 的所有 linked worktree 共用這個目錄;不是 git repo 或 git 不能用時為 null
  gitCommon: string | null;
}

export interface JobResources {
  dir: WorkdirKey;
  endpoints: string[];
}

// macOS 與 Windows 預設不分大小寫:寧可多排隊,也不要把同一個目錄當成兩個
const fold = (p: string) => (process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p);

function gitCommonDir(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--git-common-dir'], { cwd, timeout: 5000 }, (error, stdout) => {
      const out = String(stdout || '').trim();
      if (error || !out) return resolve(null);
      const full = path.resolve(cwd, out);
      fs.promises.realpath(full).then(resolve, () => resolve(full));
    });
  });
}

export async function workdirKey(dir: string): Promise<WorkdirKey> {
  const resolved = path.resolve(dir);
  let ancestor = resolved;
  const missing: string[] = [];
  let real: string;
  for (;;) {
    try { real = await fs.promises.realpath(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  const gitCommon = await gitCommonDir(real);
  real = path.join(real, ...missing);
  return { path: fold(real), gitCommon: gitCommon ? fold(gitCommon) : null };
}

const within = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

export function workdirsConflict(a: WorkdirKey, b: WorkdirKey): boolean {
  if (a.gitCommon && b.gitCommon && a.gitCommon === b.gitCommon) return true;
  return within(a.path, b.path) || within(b.path, a.path);
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

// 本機端點(例如 Ollama)共用同一份算力與記憶體,同時送兩件任務只會互相拖慢、撞逾時
export function localEndpointKey(endpoint: string | undefined | null): string | null {
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!LOCAL_HOSTS.has(host) && !host.endsWith('.localhost')) return null;
    return `local:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
  } catch { return null; }
}

function clash(a: JobResources, b: JobResources): JobBlocker | null {
  if (workdirsConflict(a.dir, b.dir)) return 'workdir';
  return a.endpoints.some((e) => b.endpoints.includes(e)) ? 'endpoint' : null;
}

interface Waiting { id: string; res: JobResources; blocker: JobBlocker | null }

export class JobScheduler {
  private held = new Map<string, { res: JobResources; counts: boolean }>();
  private waiting: Waiting[] = [];
  private stopped = false;

  constructor(private limit: () => number, private start: (id: string) => void) {}

  isHeld(id: string) { return this.held.has(id); }
  isWaiting(id: string) { return this.waiting.some((w) => w.id === id); }
  blockerOf(id: string): JobBlocker | null { return this.waiting.find((w) => w.id === id)?.blocker ?? null; }
  runningCount() { return [...this.held.values()].filter((h) => h.counts).length; }

  // 目錄與端點衝突先說:空出一個位子也還是要等它
  private blockedByHeld(res: JobResources, counts: boolean): JobBlocker | null {
    for (const h of this.held.values()) {
      const b = clash(h.res, res);
      if (b) return b;
    }
    return counts && this.runningCount() >= Math.max(1, this.limit()) ? 'slot' : null;
  }

  // 排進佇列並立刻試著開始。回傳 true 表示已經開始(start 已被呼叫)。
  submit(id: string, res: JobResources): boolean {
    if (this.stopped) throw new Error('scheduler stopped');
    if (this.isHeld(id) || this.isWaiting(id)) throw new Error(`job ${id} already scheduled`);
    this.waiting.push({ id, res, blocker: null });
    this.pump();
    return this.isHeld(id);
  }

  // 使用者當下的操作(重試、還原、重新驗證):不排隊,現在不能做就說為什麼。
  tryHold(id: string, res: JobResources, counts: boolean): JobBlocker | 'busy' | null {
    if (this.stopped || this.isHeld(id) || this.isWaiting(id)) return 'busy';
    const blocker = this.blockedByHeld(res, counts);
    if (blocker) return blocker;
    this.held.set(id, { res, counts });
    return null;
  }

  release(id: string) {
    if (!this.held.delete(id)) return;
    this.pump();
  }

  cancel(id: string): boolean {
    const before = this.waiting.length;
    this.waiting = this.waiting.filter((w) => w.id !== id);
    const removed = this.waiting.length !== before;
    if (removed) this.pump();
    return removed;
  }

  shutdown() {
    this.stopped = true;
    this.waiting = [];
  }

  // 先來先做,但被擋住的任務不堵住後面無關的任務。
  // 排在前面、還在等的任務先佔著它的目錄與端點,後來的同目錄任務不能插隊。
  pump() {
    if (this.stopped) return;
    const passed: JobResources[] = [];
    for (const item of [...this.waiting]) {
      if (!this.waiting.includes(item)) continue;
      const blocker = this.blockedByHeld(item.res, true) ?? passed.map((p) => clash(p, item.res)).find(Boolean) ?? null;
      if (blocker) { item.blocker = blocker; passed.push(item.res); continue; }
      this.waiting = this.waiting.filter((w) => w !== item);
      this.held.set(item.id, { res: item.res, counts: true });
      this.start(item.id);
    }
  }
}

// 舊任務的「還原」會把目錄寫回那次任務開始前的樣子;之後若有別的任務在同一個目錄跑過,
// 還原就會蓋掉那件任務的成果。這裡記下每次開跑的順序,讓主程序據此拒絕過期的還原。
export class RunLedger {
  private seq = 0;
  private runs: Array<{ jobId: string; seq: number; dir: WorkdirKey }> = [];

  record(jobId: string, dir: WorkdirKey) {
    this.runs.push({ jobId, seq: ++this.seq, dir });
  }

  // 這件任務最近一次開跑之後,有沒有別的任務碰過重疊的目錄
  supersededBy(jobId: string): string | null {
    const mine = [...this.runs].reverse().find((r) => r.jobId === jobId);
    if (!mine) return null;
    return this.runs.find((r) => r.seq > mine.seq && r.jobId !== jobId && workdirsConflict(r.dir, mine.dir))?.jobId ?? null;
  }
}
