// 平行執行的工作目錄隔離。
//
// 多位可改檔的成員同時寫同一個工作目錄時,後寫的會蓋掉先寫的,而且誰也不知道。
// 這裡在執行前為每位可改檔的成員準備一份隔離目錄,回合結束再合併回工作目錄。
// 是 git repo 時用 git worktree(不複製 .git 物件);不是時複製快照裡的檔案。
// 合併前重疊的檔案整份不採用,留在各自的隔離目錄,不把其中一份蓋進工作目錄。
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { snapshotDir, diffSnapshots } from './snapshot';
import type { Snapshot } from './snapshot';
import { gitAvailability } from './git-check';

const COPY_FILE_MAX = 256 * 1024;
const COPY_TOTAL_MAX = 20 * 1024 * 1024;

export interface MemberWorkspace {
  agentId: string;
  dir: string;
  kind: 'worktree' | 'copy';
  baseline: Snapshot;
}

export interface WorkspaceOverlap {
  file: string;
  names: string[];
}

export interface PreparedWorkspaces {
  root: string;
  // 原工作目錄。清 worktree 時 git 指令要在這裡下,不能在暫存根目錄下。
  cwd: string;
  members: MemberWorkspace[];
  // 隔離沒準備好時,呼叫端改為依序執行。
  unavailable?: string;
}

function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout).trim(), stderr: String(stderr || error || '').trim() });
    });
  });
}

async function isGitRepo(cwd: string): Promise<boolean> {
  if (!(await gitAvailability()).ok) return false;
  const probed = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  return probed.ok && await fs.promises.realpath(probed.stdout) === await fs.promises.realpath(cwd);
}

async function copySnapshot(from: string, to: string, snapshot: Snapshot): Promise<void> {
  let total = 0;
  await fs.promises.mkdir(to, { recursive: true });
  for (const [rel, fingerprint] of snapshot) {
    const size = Number(fingerprint.split(':')[0]) || 0;
    if (size > COPY_FILE_MAX || total + size > COPY_TOTAL_MAX) throw new Error(`copy limit exceeded: ${rel}`);
    const src = path.join(from, rel);
    const dest = path.join(to, rel);
    await checkPath(from, rel);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(src, dest);
    total += size;
  }
}

export async function prepareMemberWorkspaces(cwd: string, agentIds: string[], snapshot: Snapshot | null): Promise<PreparedWorkspaces> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-roundtable-lanes-'));
  const members: MemberWorkspace[] = [];
  try {
    if (!snapshot) throw new Error('no snapshot to copy');
    if (!await snapshotDir(cwd, undefined, true)) throw new Error('working directory cannot be copied completely');
    const git = await isGitRepo(cwd);
    for (const agentId of agentIds) {
      const dir = path.join(root, `member-${members.length + 1}`);
      if (git) {
        const added = await runGit(cwd, ['worktree', 'add', '--detach', dir, 'HEAD']);
        if (!added.ok) throw new Error(added.stderr || 'git worktree add failed');
        const member: MemberWorkspace = { agentId, dir, kind: 'worktree', baseline: new Map() };
        members.push(member);
        if (snapshot) {
          const lane = await snapshotDir(dir);
          const dirty = diffSnapshots(snapshot, lane);
          if (dirty === null) throw new Error('could not compare the worktree');
          for (const rel of dirty) {
            const dest = path.join(dir, rel);
            await checkPath(cwd, rel);
            await checkPath(dir, rel);
            if (snapshot.has(rel)) {
              await fs.promises.mkdir(path.dirname(dest), { recursive: true });
              await fs.promises.copyFile(path.join(cwd, rel), dest);
            } else {
              await fs.promises.rm(dest, { force: true });
            }
          }
        }
        const baseline = await snapshotDir(dir, undefined, true);
        if (!baseline) throw new Error('could not snapshot the worktree');
        member.baseline = baseline;
      } else {
        if (!snapshot) throw new Error('no snapshot to copy');
        await copySnapshot(cwd, dir, snapshot);
        const baseline = await snapshotDir(dir, undefined, true);
        if (!baseline) throw new Error('could not snapshot the copy');
        members.push({ agentId, dir, kind: 'copy', baseline });
      }
    }
    return { root, cwd, members };
  } catch (error) {
    await discardMemberWorkspaces({ root, cwd, members }).catch(() => {});
    return { root, cwd, members: [], unavailable: error instanceof Error ? error.message : String(error) };
  }
}

// 每位成員相對自己隔離目錄起點的改動。重疊的不合併;沒重疊的採用該成員的結果。
export async function mergeMemberWorkspaces(
  cwd: string,
  prepared: PreparedWorkspaces,
  before: Snapshot | null,
  names: Map<string, string>,
): Promise<{ adopted: string[]; overlaps: WorkspaceOverlap[]; failed: string[] }> {
  const adopted: string[] = [];
  const failed: string[] = [];
  const byFile = new Map<string, string[]>();
  const changes = new Map<string, string[]>();
  for (const member of prepared.members) {
    const after = await snapshotDir(member.dir, undefined, true);
    const changed = diffSnapshots(member.baseline, after);
    if (!changed) {
      failed.push(names.get(member.agentId) || member.agentId);
      continue;
    }
    changes.set(member.agentId, changed);
    for (const file of changed) {
      const owners = byFile.get(file) || [];
      owners.push(names.get(member.agentId) || member.agentId);
      byFile.set(file, owners);
    }
  }
  if (failed.length) return { adopted, overlaps: [], failed };
  const overlapping = new Map([...byFile].filter(([, owners]) => owners.length > 1));
  for (const [file, owners] of byFile) {
    const segments = file.split('/');
    for (let length = 1; length < segments.length; length++) {
      const parent = segments.slice(0, length).join('/');
      const parentOwners = byFile.get(parent);
      if (!parentOwners || parentOwners.every((owner) => owners.includes(owner))) continue;
      const names = [...new Set([...parentOwners, ...owners])];
      overlapping.set(parent, names);
      overlapping.set(file, names);
    }
  }
  const overlaps = [...overlapping].map(([file, owners]) => ({ file, names: owners }));
  const blocked = new Set(overlaps.map((item) => item.file));
  const current = await snapshotDir(cwd);
  if (!before || !current) return { adopted, overlaps, failed: ['.'] };
  for (const member of prepared.members) {
    for (const rel of changes.get(member.agentId) || []) {
      if (blocked.has(rel)) continue;
      const dest = path.join(cwd, rel);
      const src = path.join(member.dir, rel);
      try {
        if (current.get(rel) !== before.get(rel)) throw new Error('working file changed during execution');
        await checkPath(cwd, rel);
        await checkPath(member.dir, rel);
        if (fs.existsSync(src)) {
          await fs.promises.mkdir(path.dirname(dest), { recursive: true });
          await fs.promises.copyFile(src, dest);
        } else {
          await fs.promises.rm(dest, { force: true });
        }
        adopted.push(rel);
      } catch {
        failed.push(rel);
      }
    }
  }
  return { adopted: [...new Set(adopted)].sort(), overlaps, failed };
}

async function checkPath(root: string, rel: string): Promise<void> {
  let current = root;
  for (const part of ['', ...rel.split('/')]) {
    current = path.join(current, part);
    const stat = await fs.promises.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat && !stat.isDirectory() && !stat.isFile()) throw new Error('unsafe merge path');
  }
}

export async function discardMemberWorkspaces(prepared: PreparedWorkspaces): Promise<void> {
  for (const member of prepared.members) {
    if (member.kind === 'worktree') {
      const removed = await runGit(prepared.cwd, ['worktree', 'remove', '--force', member.dir]);
      if (!removed.ok) await fs.promises.rm(member.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (prepared.members.some((member) => member.kind === 'worktree')) {
    await runGit(prepared.cwd, ['worktree', 'prune']);
  }
  if (prepared.root) await fs.promises.rm(prepared.root, { recursive: true, force: true }).catch(() => {});
}
