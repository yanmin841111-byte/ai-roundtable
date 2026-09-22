import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { snapshotDir } from '../src/snapshot';
import { gitAvailability } from '../src/git-check';
import { prepareMemberWorkspaces, mergeMemberWorkspaces, discardMemberWorkspaces } from '../src/worktrees';

test('lane baselines ignore copying timestamps and merge edits, additions and deletions', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-lanes-'));
  fs.writeFileSync(path.join(cwd, 'keep.txt'), 'original');
  fs.writeFileSync(path.join(cwd, 'delete.txt'), 'delete');
  const before = await snapshotDir(cwd);
  const lanes = await prepareMemberWorkspaces(cwd, ['a/b', 'a?b'], before);
  try {
    assert.equal(lanes.unavailable, undefined);
    assert.notEqual(lanes.members[0].dir, lanes.members[1].dir);
    fs.writeFileSync(path.join(lanes.members[0].dir, 'keep.txt'), 'edited');
    fs.rmSync(path.join(lanes.members[0].dir, 'delete.txt'));
    fs.writeFileSync(path.join(lanes.members[1].dir, 'added.txt'), 'added');
    const result = await mergeMemberWorkspaces(cwd, lanes, before, new Map());
    assert.deepEqual(result.overlaps, []);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.adopted, ['added.txt', 'delete.txt', 'keep.txt']);
    assert.equal(fs.readFileSync(path.join(cwd, 'keep.txt'), 'utf8'), 'edited');
    assert.equal(fs.existsSync(path.join(cwd, 'delete.txt')), false);
  } finally { await discardMemberWorkspaces(lanes); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('overlapping versions and concurrent user edits are not overwritten', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-lanes-'));
  fs.writeFileSync(path.join(cwd, 'shared.txt'), 'original');
  fs.writeFileSync(path.join(cwd, 'user.txt'), 'original');
  const before = await snapshotDir(cwd);
  const lanes = await prepareMemberWorkspaces(cwd, ['alice', 'bob'], before);
  try {
    for (const member of lanes.members) fs.writeFileSync(path.join(member.dir, 'shared.txt'), member.agentId);
    fs.writeFileSync(path.join(lanes.members[0].dir, 'user.txt'), 'agent');
    fs.writeFileSync(path.join(cwd, 'user.txt'), 'user changed this');
    const result = await mergeMemberWorkspaces(cwd, lanes, before, new Map());
    assert.deepEqual(result.overlaps, [{ file: 'shared.txt', names: ['alice', 'bob'] }]);
    assert.deepEqual(result.failed, ['user.txt']);
    assert.equal(fs.readFileSync(path.join(cwd, 'shared.txt'), 'utf8'), 'original');
    assert.equal(fs.readFileSync(path.join(cwd, 'user.txt'), 'utf8'), 'user changed this');
    for (const member of lanes.members) assert.equal(fs.readFileSync(path.join(member.dir, 'shared.txt'), 'utf8'), member.agentId);
  } finally { await discardMemberWorkspaces(lanes); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('incomplete copies fail explicitly instead of silently omitting large files', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-lanes-'));
  try {
    fs.writeFileSync(path.join(cwd, 'large.txt'), Buffer.alloc(256 * 1024 + 1));
    const lanes = await prepareMemberWorkspaces(cwd, ['alice', 'bob'], await snapshotDir(cwd));
    assert.match(lanes.unavailable || '', /copy limit/);
    assert.deepEqual(lanes.members, []);
    assert.equal(fs.existsSync(lanes.root), false);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('merge refuses symlink paths without modifying outside files', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-lanes-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-outside-'));
  const before = await snapshotDir(cwd);
  const lanes = await prepareMemberWorkspaces(cwd, ['alice'], before);
  try {
    fs.writeFileSync(path.join(outside, 'file.txt'), 'outside');
    fs.mkdirSync(path.join(lanes.members[0].dir, 'link'));
    fs.writeFileSync(path.join(lanes.members[0].dir, 'link/file.txt'), 'agent');
    fs.symlinkSync(outside, path.join(cwd, 'link'));
    const result = await mergeMemberWorkspaces(cwd, lanes, before, new Map());
    assert.deepEqual(result.failed, ['link/file.txt']);
    assert.equal(fs.readFileSync(path.join(outside, 'file.txt'), 'utf8'), 'outside');
  } finally {
    await discardMemberWorkspaces(lanes);
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('worktrees preserve dirty inputs and cleanup registrations; subdirectories retain their scope', async (context) => {
  if (!(await gitAvailability()).ok) { context.skip('git unavailable'); return; }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-lanes-git-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  try {
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    fs.mkdirSync(path.join(cwd, 'sub'));
    fs.writeFileSync(path.join(cwd, 'sub/a.txt'), 'original');
    git('add', '.'); git('commit', '-qm', 'initial');
    fs.writeFileSync(path.join(cwd, 'sub/a.txt'), 'dirty');
    fs.writeFileSync(path.join(cwd, 'new.txt'), 'untracked');
    const status = git('status', '--porcelain');
    const before = await snapshotDir(cwd);
    const lanes = await prepareMemberWorkspaces(cwd, ['alice', 'bob'], before);
    try {
      assert.equal(lanes.unavailable, undefined);
      assert.equal(lanes.members[0].kind, 'worktree');
      for (const member of lanes.members) {
        assert.equal(fs.readFileSync(path.join(member.dir, 'sub/a.txt'), 'utf8'), 'dirty');
        assert.equal(fs.readFileSync(path.join(member.dir, 'new.txt'), 'utf8'), 'untracked');
      }
      assert.deepEqual((await mergeMemberWorkspaces(cwd, lanes, before, new Map())).adopted, []);
    } finally { await discardMemberWorkspaces(lanes); }
    assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length, 1);
    assert.equal(git('status', '--porcelain'), status);
    const sub = path.join(cwd, 'sub');
    const subLanes = await prepareMemberWorkspaces(sub, ['alice'], await snapshotDir(sub));
    try {
      assert.equal(subLanes.unavailable, undefined);
      assert.equal(fs.readFileSync(path.join(subLanes.members[0].dir, 'a.txt'), 'utf8'), 'dirty');
      assert.equal(fs.existsSync(path.join(subLanes.members[0].dir, 'new.txt')), false);
    } finally { await discardMemberWorkspaces(subLanes); }
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});