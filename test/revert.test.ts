'use strict';

// 還原這次任務的改動:停損用的退路。
// 要求很單純但不能出錯——把工作目錄變回任務開始前的樣子,而且還原不了的要照實說,
// 不能讓人以為已經乾淨了。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { captureBaseline, revertToBaseline } = require('../src/task-changes');
const { snapshotDir } = require('../src/snapshot');
const O = require('../src/orchestrator');
const adapters = require('../src/adapters');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

test('回寫改過的、刪掉新增的、還原刪掉的;沒動過的不碰', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-revert-'));
  fs.writeFileSync(path.join(dir, 'changed.js'), '原本\n');
  fs.writeFileSync(path.join(dir, 'same.js'), '沒動過\n');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'gone.txt'), '被刪掉的\n');
  const base = await captureBaseline(dir, await snapshotDir(dir));
  const sameBefore = fs.statSync(path.join(dir, 'same.js')).mtimeMs;

  fs.writeFileSync(path.join(dir, 'changed.js'), '被改壞(\n');
  fs.writeFileSync(path.join(dir, 'added.js'), '任務新增\n');
  fs.rmSync(path.join(dir, 'sub', 'gone.txt'));

  const r = await revertToBaseline(base);
  assert.deepStrictEqual(r.restored.sort(), ['changed.js', 'sub/gone.txt']);
  assert.deepStrictEqual(r.deleted, ['added.js']);
  assert.deepStrictEqual(r.failed, []);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'changed.js'), 'utf8'), '原本\n');
  assert.strictEqual(fs.existsSync(path.join(dir, 'added.js')), false);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'sub', 'gone.txt'), 'utf8'), '被刪掉的\n');
  assert.strictEqual(fs.statSync(path.join(dir, 'same.js')).mtimeMs, sameBefore, '沒動過的檔案不該被重寫');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('沒留下內容的檔案還原不了:要照實列出,不能靜靜跳過', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-revert-big-'));
  fs.writeFileSync(path.join(dir, 'big.bin'), 'x'.repeat(4096));
  // fileMax 很小:大檔案不會被留下內容
  const base = await captureBaseline(dir, await snapshotDir(dir), { fileMax: 10 });
  fs.writeFileSync(path.join(dir, 'big.bin'), 'y'.repeat(4096));
  const r = await revertToBaseline(base);
  assert.deepStrictEqual(r.skipped, ['big.bin']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'big.bin'), 'utf8')[0], 'y', '沒有內容就不該亂改');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('只收回修復回合:執行階段做對的部分留著,修復弄壞的收回來', async () => {
  // 實驗 7 裡有好幾次是修復回合把檔案改到載不起來,而執行階段其實已經做對了一部分。
  // 整個任務還原會把那部分一起丟掉,所以要能只收回修復那一段。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-revert-fix-'));
  fs.writeFileSync(path.join(dir, 'a.js'), '原本\n');
  const taskBase = await captureBaseline(dir, await snapshotDir(dir));

  // 執行階段:做對了,而且新增一個檔案
  fs.writeFileSync(path.join(dir, 'a.js'), '執行階段修好的樣子\n');
  fs.writeFileSync(path.join(dir, 'b.js'), '執行階段新增的\n');
  const fixBase = await captureBaseline(dir, await snapshotDir(dir));

  // 修復階段:把 a.js 改壞,又多加一個檔案
  fs.writeFileSync(path.join(dir, 'a.js'), '修復改壞的(\n');
  fs.writeFileSync(path.join(dir, 'c.js'), '修復新增的\n');

  const r = await revertToBaseline(fixBase);
  assert.deepStrictEqual(r.restored, ['a.js']);
  assert.deepStrictEqual(r.deleted, ['c.js']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), '執行階段修好的樣子\n', '回到修復前,不是回到任務開始前');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'b.js'), 'utf8'), '執行階段新增的\n', '執行階段新增的檔案要留著');
  assert.strictEqual(fs.existsSync(path.join(dir, 'c.js')), false);
  // 任務基準點還在:使用者想整個還原仍然可以
  await revertToBaseline(taskBase);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), '原本\n');
  assert.strictEqual(fs.existsSync(path.join(dir, 'b.js')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('任務進行中或沒有基準點:不還原,並說明原因', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-revert-orc-'));
  adapters.setRegistry({ get: () => ({ id: 'x', supportsEdit: true, run: async () => ({ text: '[AGREED]' }) }) });
  const agents = [{ id: 'a', name: 'A', cli: 'x', enabled: true, canEdit: true, color: '#000', persona: '', model: '', effort: '', customCommand: '' }];
  const settings = { maxTranscriptChars: 0, language: '繁體中文', workDir: dir, maxRounds: 1, mode: 'divide', uiLocale: 'zh-Hant', leadAgentId: 'a' };
  const orc = new O.Orchestrator({ get: () => ({ agents, settings }), userDataDir: os.tmpdir() });
  assert.deepStrictEqual(await orc.revertTask(), { ok: false, reason: 'no-baseline', restored: 0, deleted: 0, skipped: [], failed: [] });
  orc.running = true;
  orc.taskBaseline = await captureBaseline(dir, await snapshotDir(dir));
  assert.strictEqual((await orc.revertTask()).reason, 'running', '任務進行中不能還原');
  orc.running = false;
  fs.writeFileSync(path.join(dir, 'new.js'), 'x\n');
  const r = await orc.revertTask();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.deleted, 1);
  assert.ok(orc.messages.some((m: any) => m.tag === 'revert' && /已還原/.test(m.text)), '還原後要在對話裡說一聲');
  fs.rmSync(dir, { recursive: true, force: true });
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} revert tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
