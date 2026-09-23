'use strict';

// app 傳給內建 CLI 的參數,真的 CLI 支不支援。
//
// 為什麼需要:其他測試用假的 CLI 重播輸出,假 CLI 什麼參數都收,所以「參數組合正確」的測試
// 全綠,實際上唯讀的 Claude 成員每次都失敗——那條路傳了一個現行版本不存在的 --restricted。
// 這裡拿 `claude --help` 的實際內容比對;沒安裝 CLI 就跳過(CI 上本來就沒有)。

const assert = require('assert');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claudeArgs, codexArgs } = require('../src/adapters/builtin');
const { cursorArgs } = require('../src/adapters/cursor');
const { copilotArgs } = require('../src/adapters/copilot');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

// 導向檔案再讀:直接用管線收 claude --help 會在 8192 位元組被截斷(實測),
// 截斷之後後半段的旗標全都「找不到」,這個檢查就會變成一直誤報
function helpText(cmd: string): string | null {
  const file = path.join(os.tmpdir(), `rt-help-${cmd.replace(/\W+/g, '-')}-${process.pid}.txt`);
  try {
    execSync(`${cmd} --help > ${JSON.stringify(file)} 2>/dev/null`, { timeout: 30000 });
    return fs.readFileSync(file, 'utf8');
  } catch { return null; } finally { fs.rmSync(file, { force: true }); }
}

// 整個詞比對,不是 includes:--force 是 --forceable 的前綴,用 includes 的話
// 旗標被改名了照樣「找得到」,這個檢查就白做了。
const mentions = (help: string, token: string) =>
  new RegExp(`(^|[\\s,("'\\[|<])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s,.)"'\\]|>=])`).test(help);

// 這些旗標的值是固定選項(不是路徑、模型名那種自由文字),所以值本身也要對照 help。
// 選項被改名跟旗標被改名一樣會讓成員每次都失敗——--restricted 那次就是差一個詞。
const ENUM_FLAGS = new Set(['--permission-mode', '--effort', '--output-format', '--mode', '-s', '--sandbox']);

// 檢查一組參數:短旗標也要算(-p、-s、-C、-m、-c 都是真的有在用的)
function unsupported(help: string, args: string[]): string[] {
  const bad: string[] = [];
  args.forEach((token, i) => {
    if (!/^-./.test(token)) return; // 子指令、路徑、prompt 的 `-` 都不是旗標
    const flag = token.split('=')[0];
    if (!mentions(help, flag)) { bad.push(flag); return; }
    const value = token.includes('=') ? token.split('=').slice(1).join('=') : args[i + 1];
    if (ENUM_FLAGS.has(flag) && value && !mentions(help, value)) bad.push(`${flag} ${value}`);
  });
  return [...new Set(bad)];
}

// 每一條真的會送出去的參數組合,對照它真正會跑到的那份 help。
// (codex 的 resume 是另一個子指令,吃的旗標跟 codex exec 不一樣,所以分開對照。)
const CASES: Array<{ name: string; help: string; args: string[] }> = [
  { name: 'claude 唯讀', help: 'claude', args: claudeArgs({ model: '', effort: '', canEdit: false }, { sessionId: 'abc', systemPrompt: 'x' }, { model: 'claude-opus-5', effort: 'high' }) },
  { name: 'claude 可改檔', help: 'claude', args: claudeArgs({ model: '', effort: '', canEdit: true }, {}, { model: 'claude-haiku-4-5-20251001' }) },
  { name: 'codex 唯讀', help: 'codex exec', args: codexArgs({ canEdit: false }, { cwd: '/tmp' }, { model: 'gpt-5.6-sol', effort: 'high' }) },
  { name: 'codex 可改檔', help: 'codex exec', args: codexArgs({ canEdit: true }, { cwd: '/tmp' }, {}) },
  { name: 'codex 續談', help: 'codex exec resume', args: codexArgs({ canEdit: true }, { cwd: '/tmp', sessionId: 'abc' }, { effort: 'high' }) },
  { name: 'cursor 唯讀', help: 'cursor-agent', args: cursorArgs({ canEdit: false }, { cwd: '/tmp', sessionId: 'abc' }, 'gpt-5') },
  { name: 'cursor 可改檔', help: 'cursor-agent', args: cursorArgs({ canEdit: true }, { cwd: '/tmp' }, '') },
  { name: 'copilot read-only', help: 'copilot', args: copilotArgs({ canEdit: false, model: 'auto', effort: 'high' }, { cwd: '/tmp', sessionId: 'abc' }) },
  { name: 'copilot editing', help: 'copilot', args: copilotArgs({ canEdit: true, model: '', effort: '' }, { newSessionId: '6c77123b-bc12-4476-bf69-7f7adb198e5c', attachments: [{ path: '/tmp/file.txt' }] }) },
];

test('送出去的參數(含短旗標與固定選項的值),安裝的 CLI 都支援', () => {
  const cache = new Map<string, string | null>();
  let ran = 0;
  for (const c of CASES) {
    if (!cache.has(c.help)) cache.set(c.help, helpText(c.help));
    const help = cache.get(c.help) || null;
    if (!help) { console.log(`   (沒有安裝 ${c.help.split(' ')[0]},跳過 ${c.name})`); continue; }
    ran++;
    const bad = unsupported(help, c.args);
    assert.deepStrictEqual(bad, [], `${c.name}:這些在 \`${c.help} --help\` 裡找不到:${bad.join(' / ')}`);
  }
  console.log(`   (對照了 ${ran}/${CASES.length} 組)`);
});

test('比對方式本身要抓得到改名:整個詞比對,不是前綴', () => {
  const help = '  --permission-mode <mode>  (choices: "dontAsk", "plan")\n  -p, --print\n';
  assert.deepStrictEqual(unsupported(help, ['--permission-mode', 'dontAsk', '-p']), []);
  assert.deepStrictEqual(unsupported(help, ['--permission']), ['--permission'], '前綴不算數');
  assert.deepStrictEqual(unsupported(help, ['--permission-mode', 'restricted']), ['--permission-mode restricted'], '選項的值改名也要抓到');
});

test('claude:唯讀成員不會拿到可以改檔的旗標', () => {
  const readOnly = claudeArgs({ model: '', effort: '', canEdit: false }, {});
  assert.ok(!readOnly.includes('--dangerously-skip-permissions'));
  assert.deepStrictEqual(readOnly.slice(-2), ['--permission-mode', 'dontAsk']);
  const canEdit = claudeArgs({ model: '', effort: '', canEdit: true }, {});
  assert.ok(canEdit.includes('--dangerously-skip-permissions'));
  assert.ok(!canEdit.includes('--permission-mode'));
});

test('copilot: read-only tools and explicit sessions', () => {
  const readOnly = copilotArgs({ canEdit: false, model: '', effort: '' }, { sessionId: 'session-a' });
  assert.ok(readOnly.includes('--available-tools=view,glob,grep'));
  assert.ok(readOnly.includes('--deny-tool=write'));
  assert.ok(readOnly.includes('--deny-tool=shell'));
  assert.ok(!readOnly.includes('--allow-all-tools'));
  assert.ok(!readOnly.includes('--allow-all-paths'));
  assert.ok(!readOnly.includes('--continue'));
  assert.equal(readOnly[readOnly.indexOf('--resume') + 1], 'session-a');
  const editing = copilotArgs({ canEdit: true, model: '', effort: '' }, {});
  assert.ok(editing.includes('--allow-all-tools'));
  assert.ok(!editing.includes('--resume'));
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} cli flag tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
