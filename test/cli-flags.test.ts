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
const { claudeArgs } = require('../src/adapters/builtin');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

// 導向檔案再讀:直接用管線收 claude --help 會在 8192 位元組被截斷(實測),
// 截斷之後後半段的旗標全都「找不到」,這個檢查就會變成一直誤報
function helpText(bin: string): string | null {
  const file = path.join(os.tmpdir(), `rt-help-${bin}-${process.pid}.txt`);
  try {
    execSync(`${bin} --help > ${JSON.stringify(file)} 2>/dev/null`, { timeout: 30000 });
    return fs.readFileSync(file, 'utf8');
  } catch { return null; } finally { fs.rmSync(file, { force: true }); }
}

// 參數裡的旗標(--foo);值不檢查
const flagsIn = (args: string[]) => args.filter((a) => a.startsWith('--'));

test('claude:唯讀與可改檔兩條路的旗標,安裝的 CLI 都支援', () => {
  const help = helpText('claude');
  if (help === null) { console.log('   (沒有安裝 claude,跳過)'); return; }
  const agent = { model: '', effort: '' };
  const both = [
    ...claudeArgs({ ...agent, canEdit: false }, { sessionId: 'abc', systemPrompt: 'x' }, { model: 'claude-opus-5', effort: 'high' }),
    ...claudeArgs({ ...agent, canEdit: true }, {}, {}),
  ];
  const unknown = [...new Set(flagsIn(both))].filter((f) => !help.includes(f));
  assert.deepStrictEqual(unknown, [], `這些旗標在 claude --help 裡找不到:${unknown.join(' ')}`);
});

test('claude:唯讀成員不會拿到可以改檔的旗標', () => {
  const readOnly = claudeArgs({ model: '', effort: '', canEdit: false }, {});
  assert.ok(!readOnly.includes('--dangerously-skip-permissions'));
  assert.deepStrictEqual(readOnly.slice(-2), ['--permission-mode', 'dontAsk']);
  const canEdit = claudeArgs({ model: '', effort: '', canEdit: true }, {});
  assert.ok(canEdit.includes('--dangerously-skip-permissions'));
  assert.ok(!canEdit.includes('--permission-mode'));
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} cli flag tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
