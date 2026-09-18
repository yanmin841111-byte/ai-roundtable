'use strict';

// 紅綠 diff 的解析與收集測試。
// 重點在「介面拿到的數字與顏色是不是事實」:+/- 統計錯了或新增檔被漏掉,
// 使用者就會以為成員沒改到東西,而這正是這個功能要解決的問題。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseUnifiedDiff, collectChanges } = require('../src/diff');

// collectChanges 改成非同步了(在主程序同步跑 git 會凍結視窗),所以測試也要能 await。
// 先收集再依序執行,保持輸出順序與臨時目錄互不干擾。
let passed = 0;
const cases: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => { cases.push([name, fn]); };

test('parseUnifiedDiff:一般修改的 +/- 統計與行別正確', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@',
    ' const keep = 1;',
    '-const old = 2;',
    '+const fresh = 2;',
    '+const extra = 3;',
    ' const tail = 4;',
    '',
  ].join('\n');
  const files = parseUnifiedDiff(patch);
  assert.strictEqual(files.length, 1);
  assert.strictEqual(files[0].path, 'src/a.ts');
  assert.strictEqual(files[0].status, 'modified');
  assert.strictEqual(files[0].added, 2);
  assert.strictEqual(files[0].removed, 1);
  // hunk 標頭要保留但標成 hunk,不能被當成內容行染成綠色或紅色
  assert.deepStrictEqual(files[0].lines.map((l: any) => l.kind), ['hunk', 'ctx', 'del', 'add', 'add', 'ctx']);
  // 行首的 +/- 要被剝掉,否則介面會同時看到符號欄和文字裡的符號
  assert.strictEqual(files[0].lines[3].text, 'const fresh = 2;');
});

test('parseUnifiedDiff:新增、刪除、改名各自判對狀態', () => {
  const patch = [
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1 @@',
    '+hello',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/old-name.ts b/new-name.ts',
    'similarity index 96%',
    'rename from old-name.ts',
    'rename to new-name.ts',
    '--- a/old-name.ts',
    '+++ b/new-name.ts',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '',
  ].join('\n');
  const files = parseUnifiedDiff(patch);
  assert.deepStrictEqual(files.map((f: any) => [f.path, f.status]), [
    ['new.txt', 'added'],
    ['gone.txt', 'deleted'],
    ['new-name.ts', 'renamed'],
  ]);
  // 改名要帶出原本的路徑,否則使用者看到一個「新檔」卻找不到舊檔去哪了
  assert.strictEqual(files[2].oldPath, 'old-name.ts');
});

test('parseUnifiedDiff:二進位檔的路徑與狀態要正確,不能誤判成新增', () => {
  // 二進位檔沒有 ---/+++ 兩行。照「看不到舊檔就是新增」的推法,改一張既有的圖
  // 會被報成新增檔,路徑還會變成 "a/logo.png b/logo.png" 這種不存在的檔名。
  const patch = [
    'diff --git a/logo.png b/logo.png',
    'index 1111111..2222222 100644',
    'Binary files a/logo.png and b/logo.png differ',
    '',
  ].join('\n');
  const files = parseUnifiedDiff(patch);
  assert.strictEqual(files[0].path, 'logo.png');
  assert.strictEqual(files[0].status, 'modified');
  assert.strictEqual(files[0].binary, true);
  assert.strictEqual(files[0].lines.length, 0);
});

test('parseUnifiedDiff:只有權限變更的檔案也判成修改', () => {
  // 純 mode 變更同樣沒有 ---/+++,是上一條的另一種形態
  const patch = ['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755', ''].join('\n');
  const files = parseUnifiedDiff(patch);
  assert.strictEqual(files[0].path, 'run.sh');
  assert.strictEqual(files[0].status, 'modified');
});

test('parseUnifiedDiff:新增的二進位檔仍判成新增', () => {
  // 有 new file mode 就該相信它,不能因為缺 ---/+++ 就一律當修改
  const patch = [
    'diff --git a/icon.png b/icon.png',
    'new file mode 100644',
    'index 0000000..2222222',
    'GIT binary patch',
    '',
  ].join('\n');
  const files = parseUnifiedDiff(patch);
  assert.strictEqual(files[0].path, 'icon.png');
  assert.strictEqual(files[0].status, 'added');
  assert.strictEqual(files[0].binary, true);
});

test('parseUnifiedDiff:路徑含空白時不會被切錯', () => {
  const patch = [
    'diff --git a/my docs/read me.md b/my docs/read me.md',
    'index 1111111..2222222 100644',
    'Binary files a/my docs/read me.md and b/my docs/read me.md differ',
    '',
  ].join('\n');
  assert.strictEqual(parseUnifiedDiff(patch)[0].path, 'my docs/read me.md');
});

test('parseUnifiedDiff:"\\ No newline" 註記不算成內容行', () => {
  const patch = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-old',
    '\\ No newline at end of file',
    '+new',
    '\\ No newline at end of file',
    '',
  ].join('\n');
  const files = parseUnifiedDiff(patch);
  assert.strictEqual(files[0].added, 1);
  assert.strictEqual(files[0].removed, 1);
  assert.deepStrictEqual(files[0].lines.map((l: any) => l.kind), ['hunk', 'del', 'add']);
});

test('collectChanges:沒有工作目錄時回 no-workdir,非 repo 時回 not-a-repo', async () => {
  assert.deepStrictEqual(await collectChanges(''), { ok: false, reason: 'no-workdir' });
  assert.deepStrictEqual(await collectChanges(path.join(os.tmpdir(), 'rt-does-not-exist-' + process.pid)), { ok: false, reason: 'no-workdir' });
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-plain-'));
  try {
    const r = await collectChanges(plain);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'not-a-repo');
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test('collectChanges:真實 repo 同時抓到已追蹤的修改與未追蹤的新檔', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\ntwo\nthree\n');
    git('add', '.');
    git('commit', '-qm', 'init');

    // 乾淨的工作目錄:介面要顯示「沒有改動」,而不是錯誤
    const clean = await collectChanges(dir);
    assert.strictEqual(clean.ok, true);
    assert.deepStrictEqual(clean.files, []);

    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\nTWO\nthree\n');
    fs.writeFileSync(path.join(dir, 'fresh.txt'), 'brand new\n');
    const r = await collectChanges(dir);
    assert.strictEqual(r.ok, true);
    const byPath = Object.fromEntries(r.files.map((f: any) => [f.path, f]));
    assert.deepStrictEqual(Object.keys(byPath).sort(), ['fresh.txt', 'tracked.txt']);
    assert.strictEqual(byPath['tracked.txt'].status, 'modified');
    assert.strictEqual(byPath['tracked.txt'].added, 1);
    assert.strictEqual(byPath['tracked.txt'].removed, 1);
    // 未追蹤的新檔正是成員新增的檔案,最需要被看到;git diff 本身不含它們
    assert.strictEqual(byPath['fresh.txt'].status, 'added');
    assert.strictEqual(byPath['fresh.txt'].added, 1);
    assert.strictEqual(byPath['fresh.txt'].lines.some((l: any) => l.kind === 'add' && l.text === 'brand new'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 工作目錄是 repo 的子資料夾:git diff 的路徑相對於 repo 根目錄,ls-files 的相對於工作目錄。
// 以前同一份清單裡兩種基準混在一起(web/a.ts 和 b.ts),從審查訊息點檔名也會對錯檔案。
test('collectChanges:工作目錄在子資料夾時,路徑一律相對於 repo 根目錄,並回報 prefix', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-sub-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  try {
    fs.mkdirSync(path.join(repo, 'web'));
    fs.writeFileSync(path.join(repo, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(repo, 'web', 'a.ts'), 'a\n');
    git('init', '-q'); git('config', 'user.email', 't@e.com'); git('config', 'user.name', 't');
    git('add', '.'); git('commit', '-qm', 'init');
    fs.writeFileSync(path.join(repo, 'package.json'), '{"x":1}\n'); // 工作目錄以外、使用者自己的改動
    fs.writeFileSync(path.join(repo, 'web', 'a.ts'), 'a2\n');
    fs.writeFileSync(path.join(repo, 'web', 'b.ts'), 'b\n');     // 未追蹤
    const r = await collectChanges(path.join(repo, 'web'));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.prefix, 'web/');
    assert.deepStrictEqual(r.files.map((f: any) => f.path).sort(), ['package.json', 'web/a.ts', 'web/b.ts']);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('collectChanges:已加入暫存區的改動一樣看得到', async () => {
  // 對使用者來說「相對上一次 commit 改了什麼」才是有意義的單位;
  // git add 過的東西從介面上消失會讓人以為改動被還原了。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-staged-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'y\n');
    git('add', '.');
    const r = await collectChanges(dir);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.files.length, 1);
    assert.strictEqual(r.files[0].path, 'a.txt');
    assert.strictEqual(r.files[0].added, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectChanges:全新的 repo 還沒有 HEAD 時不會整份失敗', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-empty-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'first.txt'), 'hello\n');
    const r = await collectChanges(dir);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.files.length, 1);
    assert.strictEqual(r.files[0].status, 'added');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectChanges:真實 repo 裡改動的二進位檔不會被誤報成新增', async () => {
  // 這是上面那條 parser 測試的端到端版本:成員換掉一張既有的圖時,
  // 介面必須顯示「修改 logo.png」,而不是「新增 a/logo.png b/logo.png」。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-bin-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    git('add', '.');
    git('commit', '-qm', 'init');
    fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02, 0x03]));
    const r = await collectChanges(dir);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.files.length, 1);
    assert.strictEqual(r.files[0].path, 'logo.png');
    assert.strictEqual(r.files[0].status, 'modified');
    assert.strictEqual(r.files[0].binary, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectChanges:totalFiles 是真實總數,介面才知道有沒有被截斷', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-total-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), `x${i}\n`);
    const r = await collectChanges(dir);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.totalFiles, 5);
    assert.strictEqual(r.files.length, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

(async () => {
  for (const [name, fn] of cases) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed} 項通過`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
