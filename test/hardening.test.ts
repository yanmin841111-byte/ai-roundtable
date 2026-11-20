import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store } from '../src/store';
import { validateDirectoryToOpen, parseShellEnvOutput, importShellEnvAsync } from '../src/shell-env';
import { applyProjectSettingsForDir, parseBrowserPreviewUrl, recordProjectSettings, switchProjectSettings, type AppSettings } from '../src/ipc-types';

test('browser preview accepts only local HTTP(S) development URLs without credentials', () => {
  assert.equal(parseBrowserPreviewUrl('http://localhost:5173/demo')?.href, 'http://localhost:5173/demo');
  assert.equal(parseBrowserPreviewUrl('https://[::1]:5173')?.hostname, '[::1]');
  for (const url of ['https://localhost.example:5173', 'http://192.168.1.1:5173', 'file:///tmp/page.html', 'http://localhost', 'http://a:b@127.0.0.1:5173']) {
    assert.equal(parseBrowserPreviewUrl(url), null, url);
  }
});

test('new workflow defaults do not change legacy saved workflows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-workflow-defaults-'));
  try {
    const load = () => {
      const { mode, discussionMode } = new Store(dir).get().settings;
      return [mode, discussionMode];
    };
    assert.deepEqual(load(), ['solo', 'independent-first']);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ settings: { maxRounds: 2 } }));
    assert.deepEqual(load(), ['divide', 'sequential']);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ settings: { mode: 'strict', discussionMode: 'independent-first' } }));
    assert.deepEqual(load(), ['strict', 'independent-first']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Store.save uses atomic replacement, respects read-only config.json, and backs up corrupt config on load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-store-'));
  const cfgPath = path.join(dir, 'config.json');
  try {
    const store = new Store(dir);
    const cfg = store.get();
    cfg.settings.verifyCommand = 'npm test';
    store.save(cfg);
    assert.equal(fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), false, 'no .tmp file left after atomic save');
    assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).settings.verifyCommand, 'npm test');

    // Read-only config.json must still fail with EACCES rather than being silently unlinked by rename()
    fs.chmodSync(cfgPath, 0o444);
    try {
      const modified = structuredClone(cfg);
      modified.settings.verifyCommand = 'pytest';
      assert.throws(() => store.save(modified), /EACCES|EPERM/);
      assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).settings.verifyCommand, 'npm test');
    } finally {
      fs.chmodSync(cfgPath, 0o600);
    }

    // Corrupt config.json is backed up before falling back to defaults
    fs.writeFileSync(cfgPath, '{corrupt json', 'utf8');
    const recovered = new Store(dir);
    assert.ok(Array.isArray(recovered.get().agents) && recovered.get().agents.length > 0);
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith('config.json.corrupt-') && f.endsWith('.bak'));
    assert.equal(backups.length, 1, 'corrupt config should be backed up');
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{corrupt json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateDirectoryToOpen allows real directories and blocks files, .app bundles, and symlinks to .app bundles', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-openpath-'));
  try {
    const normalDir = path.join(dir, 'workspace');
    const plainFile = path.join(dir, 'run.command');
    const appBundle = path.join(dir, 'Calculator.app');
    const symlinkToApp = path.join(dir, ' disguised-folder');
    fs.mkdirSync(normalDir);
    fs.writeFileSync(plainFile, '#!/bin/sh\necho hi\n', { mode: 0o755 });
    fs.mkdirSync(appBundle);
    fs.symlinkSync(appBundle, symlinkToApp);

    const okRes = await validateDirectoryToOpen(normalDir, 'en');
    assert.equal(okRes.ok, true);

    for (const bad of ['', plainFile, appBundle, symlinkToApp, path.join(dir, 'missing')]) {
      const res = await validateDirectoryToOpen(bad, 'en');
      assert.equal(res.ok, false, `expected ${bad} to be rejected`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseShellEnvOutput and importShellEnvAsync parse NUL-delimited multi-line variables without clobbering existing keys', async () => {
  const raw = 'banner\n__AI_ROUNDTABLE_ENV__PATH=/custom/bin:/usr/bin\0MULTI_LINE=line1\nline2=still_val\0EXISTING=from_shell\0SHLVL=9\0';
  const parsed = parseShellEnvOutput(raw);
  assert.equal(parsed.PATH, '/custom/bin:/usr/bin');
  assert.equal(parsed.MULTI_LINE, 'line1\nline2=still_val');
  assert.equal(parsed.EXISTING, 'from_shell');

  const env: NodeJS.ProcessEnv = { PATH: '/orig/bin', EXISTING: 'keep_me' };
  await importShellEnvAsync(env, { shellBin: '/bin/sh', timeoutMs: 3000 });
  assert.ok(env.PATH?.includes('/orig/bin'), 'preserves original PATH entries');
  assert.ok(env.PATH?.includes('/usr/local/bin'), 'includes standard fallback bin paths');
  assert.equal(env.EXISTING, 'keep_me', 'never overwrites existing environment variables');
});

test('projectSettings helpers isolate verifyCommand, workStyle, and git flags per project directory', () => {
  const settings: AppSettings = {
    workDir: '/projects/node-svc',
    maxRounds: 3,
    mode: 'divide',
    leadAgentId: null,
    language: '繁體中文',
    maxTranscriptChars: 60000,
    verifyCommand: 'npm test',
    browserPreviewUrl: 'http://localhost:5173',
    workStyle: 'code',
    allowGitCommit: true,
    allowGitPush: false,
  };
  recordProjectSettings(settings);

  // Switching to an unseen Python project clears verifyCommand & git permissions without losing Node's saved settings
  switchProjectSettings(settings, '/projects/node-svc', '/projects/py-svc');
  settings.workDir = '/projects/py-svc';
  assert.equal(settings.verifyCommand, '');
  assert.equal(settings.browserPreviewUrl, '');
  assert.equal(settings.allowGitCommit, false);

  settings.verifyCommand = 'pytest';
  settings.workStyle = 'general';
  recordProjectSettings(settings);

  // Switching back to Node restores npm test + code + allowGitCommit
  switchProjectSettings(settings, '/projects/py-svc', '/projects/node-svc/');
  settings.workDir = '/projects/node-svc/';
  assert.equal(settings.verifyCommand, 'npm test');
  assert.equal(settings.browserPreviewUrl, 'http://localhost:5173');
  assert.equal(settings.workStyle, 'code');
  assert.equal(settings.allowGitCommit, true);

  // A background job pinned to py-svc still gets pytest when cloned from global settings
  const jobCopy = structuredClone(settings);
  applyProjectSettingsForDir(jobCopy, '/projects/py-svc');
  assert.equal(jobCopy.workDir, '/projects/py-svc');
  assert.equal(jobCopy.verifyCommand, 'pytest');
  assert.equal(jobCopy.workStyle, 'general');

  // Old sessions and evicted or partial settings must not inherit another project's commands or permissions.
  for (const projectSettings of [undefined, { '/projects/old': { workStyle: 'general' as const } }]) {
    const old = { ...settings, projectSettings, allowGitPush: true };
    applyProjectSettingsForDir(old, '/projects/old');
    assert.equal(old.workDir, '/projects/old');
    assert.equal(old.verifyCommand, '');
    assert.equal(old.browserPreviewUrl, '');
    assert.equal(old.allowGitCommit, false);
    assert.equal(old.allowGitPush, false);
    assert.equal(old.workStyle, projectSettings ? 'general' : 'code');
  }

  const legacy = { ...settings, projectSettings: undefined, allowGitPush: true };
  applyProjectSettingsForDir(legacy, '/projects/node-svc');
  assert.equal(legacy.verifyCommand, 'npm test');
  assert.equal(legacy.allowGitCommit, true);
  assert.equal(legacy.allowGitPush, true);
});
