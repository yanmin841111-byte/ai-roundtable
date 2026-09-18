'use strict';

// 寫檔工具的閘門與稽核紀錄測試。
//
// 核心風險:本地模型會真的改使用者的檔案。閘門若判錯,就會出現「給了寫入工具、
// 事後卻沒有人審」——而那種失敗在畫面上跟順利跑完一模一樣,使用者不可能自己發現。
// 這組測試走真正的 runTask divide 流程,只把轉接器換成假的。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const O = require('../src/orchestrator');
const adapters = require('../src/adapters');

let passed = 0;
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => { cases.push([name, fn]); };

// 每次 run 收到的 ctx.fileToolsEnabled 都記下來,才驗得到閘門到底有沒有生效
interface Call { name: string; phase: string; fileToolsEnabled: boolean; prompt: string }

// scripts:成員名稱 -> 依序回傳的文字;toolEvents:成員名稱 -> 執行階段要回傳的工具紀錄
function fakeOrc(names: string[], opts: { scripts?: Record<string, string[]>; toolEvents?: Record<string, any[]>; supportsEdit?: boolean } = {}) {
  const { scripts = {}, toolEvents = {}, supportsEdit = true } = opts;
  const agents = names.map((name, i) => ({ id: `a${i}`, name, cli: 'fake', enabled: true, canEdit: true, color: '#000', persona: '', model: '', effort: '', customCommand: '' }));
  const queues: Record<string, string[]> = {};
  for (const name of names) queues[name] = [...(scripts[name] || [])];
  const calls: Call[] = [];
  adapters.setRegistry({
    get: () => ({
      id: 'fake', supportsResume: false, supportsEdit,
      run: async (agent: any, ctx: any) => {
        const phase = /分工|assign/.test(ctx.prompt) ? 'assign' : '';
        calls.push({ name: agent.name, phase, fileToolsEnabled: ctx.fileToolsEnabled === true, prompt: ctx.prompt });
        await new Promise((r: any) => setTimeout(r, 1));
        const next = queues[agent.name].shift();
        const events = toolEvents[agent.name];
        return {
          text: next != null ? next : `${agent.name} 完成了`,
          // 只有真的被允許用工具的那一回合才回報工具紀錄,模擬 adapter 的行為
          ...(events && ctx.fileToolsEnabled ? { toolEvents: events } : {}),
        };
      },
    }),
  });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-gate-'));
  const settings = {
    maxTranscriptChars: 0, language: '繁體中文', workDir,
    maxRounds: 1, mode: 'divide', uiLocale: 'zh-Hant', leadAgentId: 'a0',
  };
  const orc = new O.Orchestrator({ get: () => ({ agents, settings }), userDataDir: os.tmpdir() });
  const idle = () => new Promise((resolve: any) => {
    const check = (s: any) => { if (!s.running && s.phase && s.phase.code === 'idle') { orc.off('state', check); resolve(); } };
    orc.on('state', check);
  });
  return { orc, calls, agents, workDir, idle, cleanup: () => fs.rmSync(workDir, { recursive: true, force: true }) };
}

// 分工階段要求主持人回傳 JSON;代號 A1/A2… 依成員順序對應
const plan = (codes: string[]) => JSON.stringify({
  summary: '改一個檔案',
  assignments: codes.map((agent) => ({ agent, task: '修改 src/a.ts' })),
});

const auditEvent = (overrides: any = {}) => ({
  toolCallId: 'c1', name: 'replace_text', path: 'src/a.ts', ok: true,
  summary: 'replace_text src/a.ts 完成',
  result: { path: 'src/a.ts', added: 2, removed: 1, newSha256: 'b'.repeat(64), replacements: 1 },
  ...overrides,
});

test('只有一位成員時不給寫入工具:沒有人能審查這次改動', async () => {
  const h = fakeOrc(['甲'], { scripts: { 甲: ['[AGREED]', plan(['A1']), '我改好了'] } });
  const done = h.idle();
  await h.orc.userMessage('請改一下 src/a.ts', 'divide');
  await done;
  const exec = h.calls.filter((c) => /執行|你負責/.test(c.prompt));
  assert.ok(exec.length >= 1, '應該有執行階段的呼叫');
  assert.strictEqual(exec.every((c) => !c.fileToolsEnabled), true, '沒有合格 reviewer 時不得傳入 fileToolsEnabled');
  h.cleanup();
});

test('有另一位成員時才給寫入工具', async () => {
  const h = fakeOrc(['甲', '乙'], { scripts: { 甲: ['[AGREED]', plan(['A1']), '我改好了'], 乙: ['[AGREED]', '沒問題'] } });
  const done = h.idle();
  await h.orc.userMessage('請改一下 src/a.ts', 'divide');
  await done;
  const exec = h.calls.filter((c) => /執行|你負責/.test(c.prompt));
  assert.ok(exec.some((c) => c.fileToolsEnabled), '有合格 reviewer 時應該傳入 fileToolsEnabled');
  h.cleanup();
});

test('成員不允許改檔時,即使有 reviewer 也不給工具', async () => {
  // 三層閘門缺任何一層都不該給工具;這裡缺的是 adapter 的 supportsEdit
  const h = fakeOrc(['甲', '乙'], { scripts: { 甲: ['[AGREED]', plan(['A1']), '我改好了'], 乙: ['[AGREED]', '沒問題'] }, supportsEdit: false });
  const done = h.idle();
  await h.orc.userMessage('請改一下 src/a.ts', 'divide');
  await done;
  assert.strictEqual(h.calls.every((c) => !c.fileToolsEnabled), true);
  h.cleanup();
});

test('工具紀錄會寫成 tool-audit 訊息並讓審查者讀到', async () => {
  const h = fakeOrc(['甲', '乙'], {
    scripts: { 甲: ['[AGREED]', plan(['A1']), '我改好了'], 乙: ['[AGREED]', '看過了,沒問題'] },
    toolEvents: { 甲: [auditEvent()] },
  });
  const done = h.idle();
  await h.orc.userMessage('請改一下 src/a.ts', 'divide');
  await done;
  const audit = h.orc.messages.filter((m: any) => m.tag === 'tool-audit');
  assert.strictEqual(audit.length, 1, '應該寫入一則稽核訊息');
  assert.strictEqual(audit[0].kind, 'system', '必須是 system 訊息,不可偽裝成使用者發言');
  assert.strictEqual(audit[0].toolAudit[0].tool, 'replace_text');
  assert.strictEqual(audit[0].toolAudit[0].path, 'src/a.ts');
  assert.strictEqual(audit[0].toolAudit[0].added, 2);
  assert.strictEqual(audit[0].toolAudit[0].removed, 1);
  assert.strictEqual(audit[0].toolAudit[0].shaAfter, 'b'.repeat(64));
  // 審查者必須在提示詞裡看到實際改動,否則它只是在審一篇作文
  const reviewCall = h.calls.find((c) => /審查/.test(c.prompt) && c.name === '乙');
  assert.ok(reviewCall, '應該有審查階段的呼叫');
  assert.ok(reviewCall!.prompt.includes('replace_text'), '審查者的提示詞要包含工具稽核紀錄');
  assert.ok(reviewCall!.prompt.includes('src/a.ts'));
  h.cleanup();
});

test('稽核紀錄不夾帶完整檔案內容', async () => {
  // read_file 的回傳動輒數萬字;放進 transcript 會把每一回合的提示詞撐爆
  const huge = 'X'.repeat(50000);
  const h = fakeOrc(['甲', '乙'], {
    scripts: { 甲: ['[AGREED]', plan(['A1']), '我改好了'], 乙: ['[AGREED]', '沒問題'] },
    toolEvents: { 甲: [
      { toolCallId: 'r1', name: 'read_file', path: 'src/a.ts', ok: true, summary: 'read', result: { path: 'src/a.ts', sha256: 'a'.repeat(64), content: huge } },
      auditEvent(),
    ] },
  });
  const done = h.idle();
  await h.orc.userMessage('請改一下 src/a.ts', 'divide');
  await done;
  const audit = h.orc.messages.find((m: any) => m.tag === 'tool-audit');
  assert.ok(audit, '應該有稽核訊息');
  assert.strictEqual(JSON.stringify(audit).includes(huge), false, '稽核紀錄不可含完整檔案內容');
  // 成功的 read_file 不列出來(它沒有改變任何東西,只會稀釋審查者的注意力)
  assert.strictEqual(audit.toolAudit.every((e: any) => e.tool !== 'read_file'), true);
  const reviewCall = h.calls.find((c) => /審查/.test(c.prompt) && c.name === '乙');
  assert.strictEqual(reviewCall!.prompt.includes(huge), false, '審查提示詞也不可含完整檔案內容');
  h.cleanup();
});

test('工具失敗會留在稽核紀錄裡,不會靜默', async () => {
  // 靜默失敗會造成「模型以為改了、審查看到沒改、diff 面板空白」三層都不報錯
  const h = fakeOrc(['甲', '乙'], {
    scripts: { 甲: ['[AGREED]', plan(['A1']), '我改好了'], 乙: ['[AGREED]', '沒問題'] },
    toolEvents: { 甲: [auditEvent({ ok: false, result: { path: 'src/a.ts', error: '檔案已被其他成員修改，sha256 不符' } })] },
  });
  const done = h.idle();
  await h.orc.userMessage('請改一下 src/a.ts', 'divide');
  await done;
  const audit = h.orc.messages.find((m: any) => m.tag === 'tool-audit');
  assert.strictEqual(audit.toolAudit[0].ok, false);
  assert.ok(audit.toolAudit[0].error.includes('sha256'));
  assert.strictEqual(audit.level, 'warn', '有失敗時整則訊息要標成警告');
  h.cleanup();
});

test('近似的行數統計要標示出來,不能讓審查者當成精確值', async () => {
  // 逐行 diff 超過運算保護值時會退回「整檔行數」,那個數字看起來精確卻可能高估好幾個數量級。
  // 旗標若沒跟著傳到 transcript 與介面,文件承諾的「請以紅綠 diff 為準」就等於不存在。
  const h = fakeOrc(['甲', '乙'], {
    scripts: { 甲: ['[AGREED]', plan(['A1']), '我改好了'], 乙: ['[AGREED]', '沒問題'] },
    toolEvents: { 甲: [auditEvent({ result: { path: 'src/a.ts', added: 2000, removed: 2000, newSha256: 'b'.repeat(64), statsApproximate: true } })] },
  });
  const done = h.idle();
  await h.orc.userMessage('請改一下 src/a.ts', 'divide');
  await done;
  const audit = h.orc.messages.find((m: any) => m.tag === 'tool-audit');
  assert.strictEqual(audit.toolAudit[0].statsApproximate, true, '近似旗標要傳到稽核紀錄');
  assert.ok(audit.text.includes('近似值'), '審查者讀到的文字也要講明這是近似值');
  h.cleanup();
});

test('事前有 reviewer,但事後審查失敗,仍要標記 unreviewed', async () => {
  // Codex 的第二層:事前可用不等於事後真的審完
  const h = fakeOrc(['甲', '乙'], {
    scripts: { 甲: ['[AGREED]', plan(['A1']), '我改好了'], 乙: ['[AGREED]', ''] }, // 審查回空字串 = 審查失敗
    toolEvents: { 甲: [auditEvent()] },
  });
  const done = h.idle();
  await h.orc.userMessage('請改一下 src/a.ts', 'divide');
  await done;
  const execMsg = h.orc.messages.find((m: any) => m.kind === 'agent' && m.agentName === '甲' && m.phase?.code === 'execute');
  assert.ok(execMsg, '應該有執行階段的訊息');
  assert.strictEqual(execMsg.unreviewed, true, '審查沒有實際完成時必須標記');
  h.cleanup();
});

(async () => {
  for (const [name, fn] of cases) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed} 項通過`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
