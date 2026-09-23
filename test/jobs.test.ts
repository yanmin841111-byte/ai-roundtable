import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { JobScheduler, RunLedger, localEndpointKey, workdirKey, workdirsConflict } from '../src/jobs';
import type { JobResources } from '../src/jobs';
import { gitAvailability } from '../src/git-check';

const res = (dir: string, endpoints: string[] = [], gitCommon: string | null = null): JobResources => ({ dir: { path: dir, gitCommon }, endpoints });

function scheduler(limit = 2) {
  const started: string[] = [];
  const s = new JobScheduler(() => limit, (id) => started.push(id));
  return { s, started };
}

test('different projects run together up to the limit; the rest wait for a slot', () => {
  const { s, started } = scheduler(2);
  assert.equal(s.submit('a', res('/p/a')), true);
  assert.equal(s.submit('b', res('/p/b')), true);
  assert.equal(s.submit('c', res('/p/c')), false);
  assert.equal(s.blockerOf('c'), 'slot');
  s.release('a');
  assert.deepEqual(started, ['a', 'b', 'c']);
});

test('the same directory, parent/child directories, and the same repo wait for each other', () => {
  const { s, started } = scheduler(5);
  s.submit('a', res('/p/app', [], '/p/app/.git'));
  assert.equal(s.submit('sibling', res('/p/apple')), true, '/p/apple is not inside /p/app');
  assert.equal(s.submit('child', res('/p/app/web', [], '/p/app/.git')), false);
  assert.equal(s.blockerOf('child'), 'workdir');
  assert.equal(s.submit('worktree', res('/elsewhere/app-wt', [], '/p/app/.git')), false);
  assert.equal(s.submit('parent', res('/p')), false);
  s.release('a');
  assert.deepEqual(started, ['a', 'sibling', 'child']);
});

test('a later job cannot jump ahead of an earlier waiting job on the same directory', () => {
  const { s, started } = scheduler(1);
  s.submit('a', res('/p/a'));
  s.submit('b', res('/p/b'));
  s.submit('b2', res('/p/b'));
  s.release('a');
  assert.deepEqual(started, ['a', 'b']);
  s.release('b');
  assert.deepEqual(started, ['a', 'b', 'b2']);
});

test('a blocked job does not hold up an unrelated job behind it', () => {
  const { s, started } = scheduler(3);
  s.submit('a', res('/p/a', ['local:11434']));
  s.submit('b', res('/p/b', ['local:11434']));
  s.submit('c', res('/p/c'));
  assert.equal(s.blockerOf('b'), 'endpoint');
  assert.deepEqual(started, ['a', 'c']);
});

test('immediate holds do not queue and do not consume a slot unless asked', () => {
  const { s, started } = scheduler(1);
  s.submit('a', res('/p/a'));
  assert.equal(s.tryHold('m', res('/p/a'), false), 'workdir');
  assert.equal(s.tryHold('m', res('/p/m'), false), null, 'maintenance does not need a run slot');
  assert.equal(s.tryHold('r', res('/p/r'), true), 'slot');
  assert.equal(s.tryHold('a', res('/p/z'), false), 'busy');
  s.submit('q', res('/p/m'));
  assert.equal(s.blockerOf('q'), 'workdir', 'the directory is named before the full slot');
  s.release('a');
  assert.equal(s.blockerOf('q'), 'workdir', 'still waits for the maintenance hold on its directory');
  s.release('m');
  assert.deepEqual(started, ['a', 'q']);
});

test('cancel removes a waiting job; releasing an unknown job is a no-op', () => {
  const { s, started } = scheduler(1);
  s.submit('a', res('/p/a'));
  s.submit('b', res('/p/b'));
  assert.equal(s.cancel('b'), true);
  s.release('nope');
  s.release('a');
  assert.deepEqual(started, ['a']);
  assert.throws(() => { s.submit('c', res('/p/c')); s.submit('c', res('/p/c')); });
});

test('local endpoints share a key regardless of host spelling; remote ones are free', () => {
  assert.equal(localEndpointKey('http://localhost:11434/v1'), 'local:11434');
  assert.equal(localEndpointKey('http://127.0.0.1:11434/v1'), 'local:11434');
  assert.equal(localEndpointKey('http://[::1]:11434'), 'local:11434');
  assert.equal(localEndpointKey('https://api.deepseek.com'), null);
  assert.equal(localEndpointKey(undefined), null);
  assert.equal(localEndpointKey('not a url'), null);
});

test('shutdown never starts queued work when running jobs release their resources', () => {
  const { s, started } = scheduler(1);
  s.submit('a', res('/p/a'));
  s.submit('b', res('/p/b'));
  s.shutdown();
  s.release('a');
  s.pump();
  assert.deepEqual(started, ['a']);
  assert.equal(s.isWaiting('b'), false);
  assert.equal(s.tryHold('c', res('/p/c'), true), 'busy');
  assert.throws(() => s.submit('d', res('/p/d')));
});

test('canceling a conflicting waiter unblocks later independent work immediately', () => {
  const { s, started } = scheduler(3);
  s.submit('a', res('/p/a', ['local:1']));
  s.submit('b', res('/p/b', ['local:1']));
  s.submit('c', res('/p/b'));
  assert.deepEqual(started, ['a']);
  s.cancel('b');
  assert.deepEqual(started, ['a', 'c']);
});

test('a revert is stale once another job has run in an overlapping directory afterwards', () => {
  const ledger = new RunLedger();
  ledger.record('a', { path: '/p/app', gitCommon: null });
  ledger.record('other', { path: '/q', gitCommon: null });
  assert.equal(ledger.supersededBy('a'), null);
  ledger.record('b', { path: '/p/app/web', gitCommon: null });
  assert.equal(ledger.supersededBy('a'), 'b');
  assert.equal(ledger.supersededBy('b'), null);
  ledger.record('a', { path: '/p/app', gitCommon: null });
  assert.equal(ledger.supersededBy('a'), null, 'running again starts from the current state');
});

test('workdirKey resolves symlinks and finds the shared git directory of linked worktrees', async (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-jobs-')));
  try {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    fs.symlinkSync(plain, path.join(tmp, 'link'));
    const [a, b] = await Promise.all([workdirKey(plain), workdirKey(path.join(tmp, 'link'))]);
    assert.ok(workdirsConflict(a, b), 'a symlink to the same directory is the same directory');
    const [missing, alias] = await Promise.all([workdirKey(path.join(plain, 'new/deep')), workdirKey(path.join(tmp, 'link/new/deep'))]);
    assert.deepEqual(missing, alias, 'missing child directories retain their real parent identity');
    if (!(await gitAvailability()).ok) { t.diagnostic('git unavailable; worktree case skipped'); return; }
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    git('worktree', 'add', '-q', path.join(tmp, 'wt'));
    const [main, wt, other] = await Promise.all([workdirKey(repo), workdirKey(path.join(tmp, 'wt')), workdirKey(plain)]);
    assert.ok(main.gitCommon && main.gitCommon === wt.gitCommon);
    assert.ok(workdirsConflict(main, wt));
    assert.ok(!workdirsConflict(main, other));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
