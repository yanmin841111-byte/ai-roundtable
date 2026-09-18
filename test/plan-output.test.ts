'use strict';

// 主持人的分工原文(多半是一串 JSON)成功解析後,介面收起來,只看下方的「分工結果」卡片。
// 解析失敗的那次不能收:使用者要看得到主持人到底輸出了什麼,才知道哪裡不對。

const assert = require('assert');
const os = require('os');
const O = require('../src/orchestrator');
const adapters = require('../src/adapters');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

const GOOD = JSON.stringify({ summary: '寫檔', assignments: [{ agent: 'A1', task: '寫 a.ts' }] });

// divideReplies:主持人每一次分工回合的輸出,依序使用
async function run(divideReplies: string[]) {
  let i = 0;
  adapters.setRegistry({ get: (id: string) => (id === 'lead' ? {
    id, supportsEdit: false, supportsResume: false, capabilities: { attachments: ['filePath'] },
    run: async (_a: any, ctx: any) => {
      if (/【分工】/.test(ctx.prompt)) return { text: divideReplies[Math.min(i++, divideReplies.length - 1)] };
      if (/【總結】/.test(ctx.prompt)) return { text: '完成' };
      if (/【執行】/.test(ctx.prompt)) return { text: '做好了' };
      return { text: '[AGREED]' };
    },
  } : null) });
  const agents = [{ id: 'l', name: '主持人', cli: 'lead', enabled: true, canEdit: false, color: '#000', persona: '', model: '', effort: '', customCommand: '' }];
  const settings = { maxTranscriptChars: 0, language: '繁體中文', workDir: os.tmpdir(), maxRounds: 1, mode: 'divide', uiLocale: 'zh-Hant', leadAgentId: 'l' };
  const orc = new O.Orchestrator({ get: () => ({ agents, settings }), userDataDir: os.tmpdir() });
  const done = new Promise<void>((r) => { const f = (st: any) => { if (!st.running && st.phase && st.phase.code === 'idle') { orc.off('state', f); r(); } }; orc.on('state', f); });
  await orc.userMessage('分工', 'divide');
  await done;
  return orc.messages.filter((m: any) => m.kind === 'agent' && m.phase && m.phase.code === 'divide');
}

test('解析成功:主持人的原文標成已整理', async () => {
  const divides = await run([GOOD]);
  assert.strictEqual(divides.length, 1);
  assert.strictEqual(divides[0].rawPlan, true);
});

test('第一次解析失敗、第二次成功:失敗那次照樣完整顯示,只收成功的那次', async () => {
  const divides = await run(['我覺得可以這樣分:先寫 a.ts', GOOD]);
  assert.strictEqual(divides.length, 2);
  assert.ok(!divides[0].rawPlan, '解析失敗的原文要留著,看得出哪裡不對');
  assert.strictEqual(divides[1].rawPlan, true);
});

test('兩次都失敗:都不收', async () => {
  const divides = await run(['不是 JSON', '還是不是']);
  assert.ok(divides.length === 2 && divides.every((m: any) => !m.rawPlan));
});

test('載入紀錄:只認 true', () => {
  assert.strictEqual(O.restoreMessage({ id: 'a', kind: 'agent', rawPlan: true }).rawPlan, true);
  assert.strictEqual(O.restoreMessage({ id: 'b', kind: 'agent', rawPlan: 'yes' }).rawPlan, undefined);
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} plan output tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
