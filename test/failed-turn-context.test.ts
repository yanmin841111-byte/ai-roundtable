'use strict';

// 回合失敗後,成員不能失去前情。
//
// 實測過的 bug:可續接的 CLI(Claude、Codex)在建立 session 之前就失敗(例如沒登入)時,
// 以前 lastSeen 照樣往前推,下一回合只送「失敗之後」的新訊息,CLI 手上又沒有記憶——
// 成員就在完全不知道原本任務的狀況下回答。這裡走真正的 userMessage 流程驗證。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const O = require('../src/orchestrator');
const adapters = require('../src/adapters');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

function harness(results: Array<{ text: string; error?: string; sessionId?: string }>) {
  const prompts: string[] = [];
  let i = 0;
  adapters.setRegistry({ get: () => ({
    id: 'fake', supportsEdit: false, supportsResume: true,
    run: async (_a: any, ctx: any) => { prompts.push(ctx.prompt); return results[Math.min(i++, results.length - 1)]; },
  }) });
  const agents = [{ id: 'a0', name: '甲', cli: 'fake', enabled: true, canEdit: false, color: '#000', persona: '', model: '', effort: '', customCommand: '' }];
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ctx-'));
  const settings = { maxTranscriptChars: 0, language: '繁體中文', workDir, maxRounds: 1, mode: 'divide', uiLocale: 'zh-Hant', leadAgentId: 'a0' };
  const orc = new O.Orchestrator({ get: () => ({ agents, settings }), userDataDir: os.tmpdir() });
  const ask = async (text: string) => {
    const done = new Promise<void>((r) => { const f = (s: any) => { if (!s.running) { orc.off('state', f); r(); } }; orc.on('state', f); });
    await orc.userMessage(text, 'divide');
    await done;
  };
  return { orc, prompts, ask, cleanup: () => fs.rmSync(workDir, { recursive: true, force: true }) };
}

test('第一回合在建立 session 前失敗,下一回合仍收得到原本的訊息', async () => {
  const h = harness([{ text: '', error: '尚未登入' }, { text: '好的', sessionId: 's1' }]);
  await h.ask('@甲 暗號是「藍色鯨魚」');
  await h.ask('@甲 剛剛的暗號是什麼?');
  assert.ok(h.prompts[1].includes('藍色鯨魚'), '失敗的那一回合甲沒有真正收到,下一回合必須重送');
  h.cleanup();
});

test('成功之後改為只送新訊息(續接模式照舊運作)', async () => {
  const h = harness([{ text: '收到', sessionId: 's1' }, { text: '好的', sessionId: 's1' }]);
  await h.ask('@甲 第一件事');
  await h.ask('@甲 第二件事');
  assert.ok(h.prompts[1].includes('第二件事'));
  assert.ok(!h.prompts[1].includes('第一件事'), '已經成功看過的內容不重送,session 裡已經有了');
  h.cleanup();
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} failed-turn context tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
