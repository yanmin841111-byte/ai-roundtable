'use strict';

// 專案規則:工作目錄的 CLAUDE.md / AGENTS.md 自動進每位成員的系統提示。
// 規則是「每回合都會送」的東西,所以長度要有上限,而且截斷了要說出來。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readProjectRules, RULE_FILES, RULES_MAX_CHARS } = require('../src/project-rules');
const O = require('../src/orchestrator');
const adapters = require('../src/adapters');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

const tmp = (files: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-rules-'));
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  return dir;
};

test('依序找規則檔,CLAUDE.md 優先;沒有就回 null;空檔案不算', () => {
  assert.strictEqual(readProjectRules(tmp({})), null);
  assert.strictEqual(readProjectRules(tmp({ 'CLAUDE.md': '   \n' })), null, '空檔案不算規則');
  assert.strictEqual(readProjectRules(tmp({ 'AGENTS.md': '用 tabs\n' })).file, 'AGENTS.md');
  const both = readProjectRules(tmp({ 'CLAUDE.md': 'A\n', 'AGENTS.md': 'B\n' }));
  assert.strictEqual(both.file, 'CLAUDE.md');
  assert.strictEqual(both.text, 'A');
  assert.ok(RULE_FILES.includes('CLAUDE.md') && RULE_FILES.includes('AGENTS.md'));
});

test('太長就截斷,而且標明截斷過', () => {
  const long = readProjectRules(tmp({ 'CLAUDE.md': 'x'.repeat(RULES_MAX_CHARS + 500) }));
  assert.strictEqual(long.text.length, RULES_MAX_CHARS);
  assert.strictEqual(long.truncated, true);
  const short = readProjectRules(tmp({ 'CLAUDE.md': 'x'.repeat(10) }));
  assert.strictEqual(short.truncated, false);
});

test('規則會進每位成員的系統提示,並在對話裡說明套用了哪個檔案', async () => {
  const dir = tmp({ 'CLAUDE.md': '這個專案的規矩:不要碰 legacy/ 目錄。\n' });
  const prompts: string[] = [];
  adapters.setRegistry({ get: () => ({ id: 'x', supportsEdit: true, run: async (_a: any, ctx: any) => { prompts.push(ctx.systemPrompt || ''); return { text: '[AGREED]' }; } }) });
  const agents = [{ id: 'a', name: 'A', cli: 'x', enabled: true, canEdit: true, color: '#000', persona: '', model: '', effort: '', customCommand: '' }];
  const settings = { maxTranscriptChars: 0, language: '繁體中文', workDir: dir, maxRounds: 1, mode: 'discuss', uiLocale: 'zh-Hant', leadAgentId: 'a' };
  const orc = new O.Orchestrator({ get: () => ({ agents, settings }), userDataDir: os.tmpdir() });
  const done = new Promise<void>((r) => { const f = (st: any) => { if (!st.running && st.phase && st.phase.code === 'idle') { orc.off('state', f); r(); } }; orc.on('state', f); });
  await orc.userMessage('討論一下', 'discuss');
  await done;
  assert.ok(prompts.length > 0);
  assert.ok(prompts.every((p) => /不要碰 legacy\/ 目錄/.test(p)), '每一回合的系統提示都要帶著規則');
  assert.ok(prompts.every((p) => /CLAUDE\.md/.test(p)), '要說明規則來自哪個檔案');
  assert.ok(orc.messages.some((m: any) => m.tag === 'project-rules' && /CLAUDE\.md/.test(m.text)), '對話裡要說一聲');
  fs.rmSync(dir, { recursive: true, force: true });
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} project rules tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
