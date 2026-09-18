'use strict';

// 工作目錄不是 git repo 時的「檔案改動」:任務開始前記下內容,之後拿現在的檔案比對。
// 預設工作區就不是 git repo——以前用預設設定的使用者永遠看不到紅綠對照。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const T = require('../src/task-changes');
const { snapshotDir } = require('../src/snapshot');
const { parseUnifiedDiff } = require('../src/diff');
const O = require('../src/orchestrator');
const adapters = require('../src/adapters');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

// 逐行比對要和 git 的結果一模一樣:同一個介面同時顯示兩種來源,不能一個說法一種樣子
test('逐行比對與 git diff 相同(隨機修改 60 組)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-vsgit-'));
  let seed = 11;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const strip = (ls: any[]) => ls.map((l) => (l.kind === 'hunk' ? { ...l, text: l.text.replace(/^(@@ [^@]+ @@).*$/, '$1') } : l));
  for (let t = 0; t < 60; t++) {
    const base = Array.from({ length: 10 + rnd(60) }, (_, i) => `line ${i} ${rnd(4)}`);
    const next = base.slice();
    for (let e = 0, E = 1 + rnd(6); e < E; e++) {
      const at = rnd(next.length + 1);
      const op = rnd(3);
      if (op === 0) next.splice(at, 0, `new ${t}-${e}`);
      else if (next.length && op === 1) next.splice(Math.min(at, next.length - 1), 1);
      else if (next.length) next[Math.min(at, next.length - 1)] = `changed ${t}-${e}`;
    }
    fs.writeFileSync(path.join(dir, 'a.txt'), base.join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), next.join('\n') + '\n');
    let out = '';
    try { out = execFileSync('git', ['diff', '--no-index', '--no-color', '-U3', 'a.txt', 'b.txt'], { cwd: dir, encoding: 'utf8' }); } catch (e: any) { out = e.stdout; }
    const g = parseUnifiedDiff(out)[0] || { added: 0, removed: 0, lines: [] };
    const mine = T.unifiedLines(base, next);
    assert.deepStrictEqual([mine.added, mine.removed], [g.added, g.removed], `第 ${t} 組的增刪數`);
    assert.deepStrictEqual(strip(mine.lines), strip(g.lines), `第 ${t} 組的區段內容`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('差異極大時不會卡住主程序', () => {
  const a = Array.from({ length: 6000 }, (_, i) => `old ${i} ${i % 7}`);
  const b = Array.from({ length: 6000 }, (_, i) => `new ${i} ${i % 5}`);
  const t0 = Date.now();
  const r = T.unifiedLines(a, b);
  assert.ok(Date.now() - t0 < 1500, `花了 ${Date.now() - t0} ms`);
  assert.deepStrictEqual([r.added, r.removed], [6000, 6000]);
  assert.ok(r.truncated && r.lines.length === 800, '內容只帶前 800 行,統計照樣完整');
});

test('任務開始以來:修改、新增、刪除、二進位、超過保存上限都照實標示;沒動的不列', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-base-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(dir, 'gone.txt'), 'bye\n');
  fs.writeFileSync(path.join(dir, 'same.txt'), 'same\n');
  fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  fs.writeFileSync(path.join(dir, 'big.log'), 'x'.repeat(300 * 1024));
  const baseline = await T.captureBaseline(dir, await snapshotDir(dir));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n');
  fs.rmSync(path.join(dir, 'gone.txt'));
  fs.writeFileSync(path.join(dir, 'new.txt'), 'hello\n');
  fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x02]));
  fs.writeFileSync(path.join(dir, 'big.log'), 'y'.repeat(300 * 1024));
  const r = await T.changesSince(baseline);
  assert.ok(r.ok && r.source === 'task' && r.since === baseline.at && r.prefix === '');
  const by = Object.fromEntries(r.files.map((f: any) => [f.path, f]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['a.txt', 'big.log', 'gone.txt', 'logo.png', 'new.txt']);
  assert.deepStrictEqual([by['a.txt'].status, by['a.txt'].added, by['a.txt'].removed], ['modified', 1, 1]);
  assert.ok(by['a.txt'].lines.some((l: any) => l.kind === 'del' && l.text === 'two') && by['a.txt'].lines.some((l: any) => l.kind === 'add' && l.text === 'TWO'));
  assert.deepStrictEqual([by['gone.txt'].status, by['gone.txt'].removed], ['deleted', 1]);
  assert.deepStrictEqual([by['new.txt'].status, by['new.txt'].added], ['added', 1]);
  assert.strictEqual(by['logo.png'].binary, true);
  assert.strictEqual(by['big.log'].unavailable, 'not-kept', '任務開始前就超過保存上限:照樣列出,但標明沒有原始內容');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('「檔案改動」:git repo 照舊用 git;不是的話用任務前的內容;沒有或不是同一個資料夾就照實說', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-plain-'));
  fs.writeFileSync(path.join(plain, 'a.txt'), 'a\n');
  const noBaseline = await T.workdirChanges(plain, null);
  assert.deepStrictEqual([noBaseline.ok, noBaseline.reason], [false, 'not-a-repo']);
  const baseline = await T.captureBaseline(plain, await snapshotDir(plain));
  fs.writeFileSync(path.join(plain, 'a.txt'), 'b\n');
  const viaTask = await T.workdirChanges(plain, baseline);
  assert.ok(viaTask.ok && viaTask.source === 'task' && viaTask.files.length === 1);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-other-'));
  assert.strictEqual((await T.workdirChanges(other, baseline)).reason, 'not-a-repo', '別的資料夾的基準不能拿來用');

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-gitrepo-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  fs.writeFileSync(path.join(repo, 'r.txt'), 'r\n');
  git('init', '-q'); git('config', 'user.email', 't@e.com'); git('config', 'user.name', 't'); git('add', '.'); git('commit', '-qm', 'i');
  fs.writeFileSync(path.join(repo, 'r.txt'), 'R\n');
  const viaGit = await T.workdirChanges(repo, await T.captureBaseline(repo, await snapshotDir(repo)));
  assert.ok(viaGit.ok && viaGit.source === 'git', 'git repo 一律用 git');
  for (const d of [plain, other, repo]) fs.rmSync(d, { recursive: true, force: true });
});

// ---------- code review 找到的 ----------

test('沒有逐行比對的原因各自說清楚:沒保存、現在太大', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-reason-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'aaaa\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'bbbb\n');
  // 總量上限只夠記一個檔案:另一個是「沒保存」,不是「太大」
  const baseline = await T.captureBaseline(dir, await snapshotDir(dir), { totalMax: 6 });
  assert.strictEqual(baseline.contents.size, 1);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'AAAA\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'BBBB\n');
  fs.writeFileSync(path.join(dir, 'lock.json'), 'x'.repeat(300 * 1024)); // 新增的大檔:原本根本不存在
  const r = await T.changesSince(baseline);
  const by = Object.fromEntries(r.files.map((f: any) => [f.path, f]));
  const reasons = ['a.txt', 'b.txt'].map((f) => by[f].unavailable || 'diffed').sort();
  assert.deepStrictEqual(reasons, ['diffed', 'not-kept']);
  assert.strictEqual(by['lock.json'].unavailable, 'too-large', '新增的大檔不能說成「原本就太大」');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 只改換行、補上檔尾換行也是改動(git 也這樣算);重寫成一模一樣的內容則不是
test('換行符號的改動照實列出;內容完全沒變的檔案不列', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-eol-'));
  fs.writeFileSync(path.join(dir, 'crlf.txt'), 'a\r\nb\r\n');
  fs.writeFileSync(path.join(dir, 'tail.txt'), 'a\nb');
  fs.writeFileSync(path.join(dir, 'same.txt'), 'same\n');
  const baseline = await T.captureBaseline(dir, await snapshotDir(dir));
  fs.writeFileSync(path.join(dir, 'crlf.txt'), 'a\nb\n');
  fs.writeFileSync(path.join(dir, 'tail.txt'), 'a\nb\n');
  fs.writeFileSync(path.join(dir, 'same.txt'), 'x\n');
  fs.writeFileSync(path.join(dir, 'same.txt'), 'same\n'); // 修改時間變了,內容沒變
  const r = await T.changesSince(baseline);
  const by = Object.fromEntries(r.files.map((f: any) => [f.path, f]));
  assert.deepStrictEqual([by['crlf.txt'].added, by['crlf.txt'].removed], [2, 2]);
  assert.ok(by['crlf.txt'].lines.every((l: any) => !l.text.includes('\r')), '顯示時拿掉換行符號');
  assert.deepStrictEqual([by['tail.txt'].added, by['tail.txt'].removed], [1, 1]);
  assert.ok(!by['same.txt'], '內容沒變就不是改動');
  assert.strictEqual(r.totalFiles, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 以前 push(...陣列) 在幾萬行時超過函式參數上限,整份清單跟著失敗
test('幾萬行的短行檔案整個改寫:照樣比得出來,不會讓整份清單失敗', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-long-'));
  // 12 萬行、240 KB:整段替換會產生 24 萬個逐行操作
  fs.writeFileSync(path.join(dir, 'ids.txt'), 'a\n'.repeat(120000));
  fs.writeFileSync(path.join(dir, 'other.txt'), 'o\n');
  const baseline = await T.captureBaseline(dir, await snapshotDir(dir));
  fs.writeFileSync(path.join(dir, 'ids.txt'), 'b\n'.repeat(120000));
  fs.writeFileSync(path.join(dir, 'other.txt'), 'O\n');
  const r = await T.changesSince(baseline);
  assert.ok(r.ok, r.reason);
  assert.deepStrictEqual(r.files.map((f: any) => f.path).sort(), ['ids.txt', 'other.txt']);
  const ids = r.files.find((f: any) => f.path === 'ids.txt');
  assert.deepStrictEqual([ids.added, ids.removed], [120000, 120000]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 一次改了幾百個檔案(例如格式化工具跑過整個專案):不能讓整個 app 卡好幾秒
test('改動的檔案很多時,比對不會卡住主程序;超過時間上限的檔案照樣列出', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-many-'));
  const lines = Array.from({ length: 1500 }, (_, i) => `const v${i} = ${i};`);
  for (let f = 0; f < 300; f++) fs.writeFileSync(path.join(dir, `f${f}.js`), lines.join('\n') + '\n');
  const baseline = await T.captureBaseline(dir, await snapshotDir(dir));
  for (let f = 0; f < 300; f++) fs.writeFileSync(path.join(dir, `f${f}.js`), lines.map((l) => `  ${l}`).join('\n') + '\n');
  let last = Date.now();
  let maxGap = 0;
  const timer = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 5);
  const t0 = Date.now();
  const r = await T.changesSince(baseline);
  clearInterval(timer);
  assert.strictEqual(r.files.length, 300, '每個檔案都列出來');
  assert.ok(maxGap < 250, `主程序最長卡住 ${maxGap} ms`);
  assert.ok(Date.now() - t0 < 6000, `整份清單花了 ${Date.now() - t0} ms`);
  // 比對時間用完之後的檔案照樣列出,只是標明沒有逐行比對
  const short = await T.changesSince(baseline, { budgetMs: 30 });
  assert.strictEqual(short.files.length, 300);
  const skipped = short.files.filter((f: any) => f.unavailable === 'too-many').length;
  assert.ok(skipped > 0 && skipped < 300, `時間用完之後的檔案標成「改動太多」(${skipped} 個)`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 只有不是 git repo 時才記:git repo 有自己的歷史可以比對,不必多占記憶體
test('分工任務開始前:不是 git repo 才記下內容', async () => {
  const run = async (dir: string) => {
    adapters.setRegistry({ get: (id: string) => (id === 'x' ? { id, supportsEdit: true, supportsResume: false, capabilities: { attachments: ['filePath'] },
      run: async (_a: any, ctx: any) => ({ text: /【分工】/.test(ctx.prompt) ? JSON.stringify({ summary: 's', assignments: [{ agent: 'A1', task: 't' }] }) : /【總結】/.test(ctx.prompt) ? '完成' : /【執行】/.test(ctx.prompt) ? '好' : '[AGREED]' }) } : null) });
    const agents = [{ id: 'a', name: 'A', cli: 'x', enabled: true, canEdit: false, color: '#000', persona: '', model: '', effort: '', customCommand: '' }];
    const settings = { maxTranscriptChars: 0, language: '繁體中文', workDir: dir, maxRounds: 1, mode: 'divide', uiLocale: 'zh-Hant', leadAgentId: 'a' };
    const orc = new O.Orchestrator({ get: () => ({ agents, settings }), userDataDir: os.tmpdir() });
    const done = new Promise<void>((r) => { const f = (st: any) => { if (!st.running && st.phase && st.phase.code === 'idle') { orc.off('state', f); r(); } }; orc.on('state', f); });
    await orc.userMessage('做', 'divide');
    await done;
    return orc.taskBaseline;
  };
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-orcplain-'));
  fs.writeFileSync(path.join(plain, 'a.txt'), 'a\n');
  const b = await run(plain);
  assert.ok(b && b.cwd === plain && b.contents.get('a.txt').toString() === 'a\n');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-orcgit-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  assert.strictEqual(await run(repo), null);
  for (const d of [plain, repo]) fs.rmSync(d, { recursive: true, force: true });
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} task changes tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
