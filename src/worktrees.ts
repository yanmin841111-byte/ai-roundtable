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
const MERGE_TEXT_MAX = 256 * 1024;

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

// 檢查是否為適合三方文字合併的一般檔案(大小在上限內、不含 NUL 位元組),並一併讀出檔案權限
async function readMergeableText(file: string): Promise<{ buf: Buffer; mode: number } | null> {
  try {
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.size > MERGE_TEXT_MAX) return null;
    const buf = await fs.promises.readFile(file);
    if (buf.includes(0)) return null;
    return { buf, mode: stat.mode & 0o777 };
  } catch {
    return null;
  }
}

// 多位成員同時改了同一個檔案時,若各版本皆為文字檔(或各自新增完全相同的內容),
// 嘗試以 git merge-file 進行三方合併並保留檔案權限。只要任一步驟有衝突或無法合併就回傳 null,維持原本的重疊保護。
async function tryThreeWayMerge(
  cwd: string,
  rel: string,
  members: MemberWorkspace[],
): Promise<{ buf: Buffer; mode: number } | null> {
  const basePath = path.join(cwd, rel);
  let baseBuf: Buffer = Buffer.alloc(0);
  let baseMode: number | null = null;
  if (fs.existsSync(basePath)) {
    const read = await readMergeableText(basePath);
    if (!read) return null;
    baseBuf = read.buf;
    baseMode = read.mode;
  }
  const buffers: Buffer[] = [];
  const modes: number[] = [];
  for (const member of members) {
    const memberFile = path.join(member.dir, rel);
    if (!fs.existsSync(memberFile)) return null; // 其中一方刪除檔案時不做自動文字合併
    const read = await readMergeableText(memberFile);
    if (!read) return null;
    buffers.push(read.buf);
    modes.push(read.mode);
  }
  if (buffers.length < 2) return null;
  let resolvedMode: number;
  if (baseMode !== null) {
    const changedModes = [...new Set(modes.filter((m) => m !== baseMode))];
    if (changedModes.length > 1) return null;
    resolvedMode = changedModes.length === 1 ? changedModes[0] : baseMode;
  } else {
    if (modes.some((mode) => mode !== modes[0])) return null;
    resolvedMode = modes[0];
  }
  // 若所有成員改出完全相同的內容,直接採用並保留檔案權限
  if (buffers.every((b) => b.equals(buffers[0]))) return { buf: buffers[0], mode: resolvedMode };
  // 若基準不存在且內容不同,沒有共同祖先錨點,不自動合併
  if (baseMode === null || !(await gitAvailability()).ok) return null;
  const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-roundtable-merge-'));
  try {
    const baseTmp = path.join(scratch, 'base');
    const oursTmp = path.join(scratch, 'ours');
    const theirsTmp = path.join(scratch, 'theirs');
    await fs.promises.writeFile(baseTmp, baseBuf);
    await fs.promises.writeFile(oursTmp, buffers[0]);
    for (let i = 1; i < buffers.length; i++) {
      await fs.promises.writeFile(theirsTmp, buffers[i]);
      const merged = await runGit(scratch, ['merge-file', '-q', oursTmp, baseTmp, theirsTmp]);
      if (!merged.ok) return null;
    }
    return { buf: await fs.promises.readFile(oursTmp), mode: resolvedMode };
  } catch {
    return null;
  } finally {
    await fs.promises.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

// 每位成員相對自己隔離目錄起點的改動。重疊時先嘗試無衝突三方合併;仍有衝突才列為重疊不合併。
export async function mergeMemberWorkspaces(
  cwd: string,
  prepared: PreparedWorkspaces,
  before: Snapshot | null,
  names: Map<string, string>,
): Promise<{ adopted: string[]; overlaps: WorkspaceOverlap[]; failed: string[] }> {
  const adopted: string[] = [];
  const failed: string[] = [];
  const byFile = new Map<string, string[]>();
  const membersByFile = new Map<string, MemberWorkspace[]>();
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
      const list = membersByFile.get(file) || [];
      list.push(member);
      membersByFile.set(file, list);
    }
  }
  if (failed.length) return { adopted, overlaps: [], failed };
  const overlapping = new Map([...byFile].filter(([, owners]) => owners.length > 1));
  const parentBlocked = new Set<string>();
  for (const [file, owners] of byFile) {
    const segments = file.split('/');
    for (let length = 1; length < segments.length; length++) {
      const parent = segments.slice(0, length).join('/');
      const parentOwners = byFile.get(parent);
      if (!parentOwners || parentOwners.every((owner) => owners.includes(owner))) continue;
      const mergedNames = [...new Set([...parentOwners, ...owners])];
      overlapping.set(parent, mergedNames);
      overlapping.set(file, mergedNames);
      parentBlocked.add(parent);
      parentBlocked.add(file);
    }
  }
  const current = await snapshotDir(cwd);
  if (!before || !current) {
    const overlaps = [...overlapping].map(([file, owners]) => ({ file, names: owners }));
    return { adopted, overlaps, failed: ['.'] };
  }
  // 嘗試對多位成員同時修改的同一檔案做三方無衝突合併
  const autoMerged = new Map<string, { buf: Buffer; mode: number }>();
  for (const [rel] of [...overlapping]) {
    if (parentBlocked.has(rel)) continue;
    const touching = membersByFile.get(rel) || [];
    if (touching.length < 2) continue;
    try {
      if (current.get(rel) !== before.get(rel)) {
        overlapping.delete(rel);
        failed.push(rel);
        continue;
      }
      await checkPath(cwd, rel);
      for (const m of touching) await checkPath(m.dir, rel);
      const merged = await tryThreeWayMerge(cwd, rel, touching);
      if (merged !== null) {
        autoMerged.set(rel, merged);
        overlapping.delete(rel);
      }
    } catch {
      overlapping.delete(rel);
      failed.push(rel);
    }
  }
  const overlaps = [...overlapping].map(([file, owners]) => ({ file, names: owners }));
  const blocked = new Set([...overlaps.map((item) => item.file), ...failed]);
  for (const [rel, merged] of autoMerged) {
    const dest = path.join(cwd, rel);
    try {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, merged.buf, { mode: merged.mode });
      await fs.promises.chmod(dest, merged.mode);
      adopted.push(rel);
    } catch {
      failed.push(rel);
    }
  }
  for (const member of prepared.members) {
    for (const rel of changes.get(member.agentId) || []) {
      if (blocked.has(rel) || autoMerged.has(rel)) continue;
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
