'use strict';

// 測試鎖:任務開始前就存在的測試檔,修復回合不可以改。
//
// 為什麼重要:自動驗證讓「測試通過」成為流程的判斷依據,而讓測試通過有兩條路——
// 改實作或改測試。擋不住後者的話,這道保證就是假的。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isTestFile, lockedTests, changedTests } = require('../src/test-lock');
const { FileToolSession } = require('../src/adapters/file-tools');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

test('認得出測試檔,而且不把一般程式誤認成測試', () => {
  for (const f of ['a.test.js', 'a.spec.ts', 'test/a.js', 'tests/deep/b.js', '__tests__/c.tsx', 'src/x_test.py', 'spec/d.rb']) {
    assert.ok(isTestFile(f), f);
  }
  for (const f of ['src/app.js', 'latest.js', 'contest.ts', 'src/testing-utils.js', 'protest/a.js', 'README.md']) {
    assert.ok(!isTestFile(f), f);
  }
});

test('只鎖任務開始前就存在的測試檔:新寫的測試不鎖', () => {
  const before = new Map([['a.test.js', '1:1'], ['src/app.js', '1:1']]);
  assert.deepStrictEqual(lockedTests(before, ['a.test.js', 'new.test.js', 'src/app.js']), ['a.test.js']);
  assert.deepStrictEqual(lockedTests(before, ['new.test.js']), [], '新增的測試不算');
  assert.deepStrictEqual(lockedTests(null, ['a.test.js']), [], '拿不到快照就不鎖(寧可不擋,也不要亂擋)');
  assert.deepStrictEqual(changedTests(['a.test.js', 'src/app.js']), ['a.test.js']);
});

test('檔案工具:鎖住的檔案讀得到、寫不了,其他檔案照常', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-lock-'));
  fs.writeFileSync(path.join(dir, 'a.test.js'), "assert(add(1,2) === 3);\n");
  fs.writeFileSync(path.join(dir, 'app.js'), 'module.exports = 1;\n');
  const s = new FileToolSession(dir, { locked: ['a.test.js'] });
  assert.strictEqual(s.execute('read_file', { path: 'a.test.js' }).ok, true, '鎖住也要讀得到');
  const write = s.execute('write_file', { path: 'a.test.js', content: 'assert(true);\n', reason: '讓測試通過' });
  assert.strictEqual(write.ok, false);
  assert.match(write.error, /測試檔|test file/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.test.js'), 'utf8'), "assert(add(1,2) === 3);\n", '檔案不能被改到');
  const replace = s.execute('replace_text', { path: './a.test.js', oldText: 'assert(add(1,2) === 3);', newText: 'assert(true);', reason: '讓測試通過' });
  assert.strictEqual(replace.ok, false, './ 開頭的同一個檔案也要擋');
  // 覆寫既有檔案要帶 read_file 給的 sha:沒鎖的檔案照常走完整流程
  const sha = s.execute('read_file', { path: 'app.js' }).sha256;
  assert.strictEqual(s.execute('write_file', { path: 'app.js', content: 'module.exports = 2;\n', reason: '修正實作', expectedSha256: sha }).ok, true, '沒鎖的檔案照常');
  fs.rmSync(dir, { recursive: true, force: true });
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} test lock tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
