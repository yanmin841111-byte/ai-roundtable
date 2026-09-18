'use strict';

// 分工任務結束時的結果卡:誰做完了、審查結論、改了哪些檔案、花了多少時間與 token。
// 每位成員的結果必須和流程實際的走向一致(審查通過 / 修復 / 沒修好 / 沒審到 / 失敗)。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const O = require('../src/orchestrator');
const adapters = require('../src/adapters');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

// review:當審查者時的回覆;error:執行階段失敗;usage:每回合回報的用量
type Member = { id: string; name: string; canEdit: boolean; task: string; writes?: Record<string, string>; review?: string; error?: string; usage?: any };
async function run(dir: string, team: Member[], after?: (orc: any) => Promise<void>) {
  const prompts: string[] = [];
  const plan = { summary: 's', assignments: team.map((m, i) => ({ agent: `A${i + 1}`, task: m.task })) };
  adapters.setRegistry({ get: (id: string) => {
    const m = team.find((x) => x.id === id);
    if (!m) return null;
    return { id, supportsEdit: true, supportsResume: false, capabilities: { attachments: ['filePath'] },
      run: async (_a: any, ctx: any) => {
        prompts.push(ctx.prompt);
        const reply = (text: string, extra: any = {}) => ({ text, ...(m.usage ? { usage: m.usage } : {}), ...extra });
        if (/【分工】/.test(ctx.prompt)) return reply(JSON.stringify(plan));
        if (/【執行】/.test(ctx.prompt)) {
          for (const [f, c] of Object.entries(m.writes || {})) fs.writeFileSync(path.join(dir, f), c);
          return m.error ? { text: '', error: m.error } : reply('完成');
        }
        if (/【交叉審查】/.test(ctx.prompt)) return reply(m.review || '[NO_ISSUES]');
        if (/【修復】/.test(ctx.prompt)) return reply('已修正');
        if (/【總結】/.test(ctx.prompt)) return reply('總結');
        return reply('[AGREED]');
      } };
  } });
  const agents = team.map((m) => ({ id: m.id, name: m.name, cli: m.id, enabled: true, canEdit: m.canEdit, color: '#123456', persona: '', model: '', effort: '', customCommand: '' }));
  const settings = { maxTranscriptChars: 0, language: '繁體中文', workDir: dir, maxRounds: 1, mode: 'divide', uiLocale: 'zh-Hant', leadAgentId: team[0].id };
  const orc = new O.Orchestrator({ get: () => ({ agents, settings }), userDataDir: os.tmpdir() });
  const idle = () => new Promise<void>((r) => { const f = (st: any) => { if (!st.running && st.phase && st.phase.code === 'idle') { orc.off('state', f); r(); } }; orc.on('state', f); });
  const done = idle();
  await orc.userMessage('分工', 'divide');
  await done;
  if (after) await after(orc);
  const card = orc.messages.find((m: any) => m.tag === 'task-summary');
  return { card, prompts, orc };
}

test('每位成員的結果和流程的走向一致;改了哪些檔案、用量都整理進來', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-card-'));
  const { card } = await run(dir, [
    { id: 'alice', name: 'Alice', canEdit: true, task: '寫 a.js', writes: { 'a.js': 'one\ntwo\n' }, review: 'b.js 少了分號', usage: { prompt_tokens: 100, completion_tokens: 10 } },
    { id: 'bob', name: 'Bob', canEdit: true, task: '寫 b.js', writes: { 'b.js': 'b\n' }, review: 'Carol 的分析漏了一段' },
    { id: 'carol', name: 'Carol', canEdit: false, task: '分析架構', review: '沒問題\n[NO_ISSUES]' },
    { id: 'dave', name: 'Dave', canEdit: true, task: '寫 d.js', error: '逾時' },
  ]);
  assert.ok(card, '任務結束要有結果卡');
  const s = card.taskSummary;
  const outcome = Object.fromEntries(s.members.map((m: any) => [m.name, m.outcome]));
  // 輪替審查:Alice 審 Bob、Bob 審 Carol、Carol 審 Alice
  assert.deepStrictEqual(outcome, { Alice: 'approved', Bob: 'repaired', Carol: 'unresolved', Dave: 'failed' });
  assert.deepStrictEqual(s.members.find((m: any) => m.name === 'Alice').reviewers, ['Carol']);
  const files = Object.fromEntries(s.files.map((f: any) => [f.path, f]));
  assert.deepStrictEqual(Object.keys(files).sort(), ['a.js', 'b.js']);
  assert.deepStrictEqual([files['a.js'].status, files['a.js'].added, files['a.js'].removed], ['added', 2, 0]);
  assert.ok(s.usage.turnsWithUsage > 0 && s.usage.turnsWithUsage < s.usage.turns, '只有 Alice 回報用量:要記下有回合沒回報');
  assert.strictEqual(s.usage.inputTokens, 100 * s.usage.turnsWithUsage);
  assert.ok(s.endedAt >= s.startedAt);
  assert.match(card.text, /任務結果/, '純文字版給匯出與歷史紀錄用');
  assert.match(card.text, /a\.js \+2 −0/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// git repo 的「檔案改動」相對上一次 commit,會包含使用者自己之前的改動;結果卡只列這次任務的
test('git repo 裡:使用者之前就有的改動不算進這次任務', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-card-git-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'mine.txt'), 'v0\n');
  git('init', '-q'); git('config', 'user.email', 't@e.com'); git('config', 'user.name', 't'); git('add', '.'); git('commit', '-qm', 'i');
  fs.writeFileSync(path.join(dir, 'mine.txt'), 'v1 使用者自己改的\n');
  const { card } = await run(dir, [
    { id: 'alice', name: 'Alice', canEdit: true, task: '寫 a.js', writes: { 'a.js': 'a\n' } },
    { id: 'bob', name: 'Bob', canEdit: false, task: '看看' },
  ]);
  assert.deepStrictEqual(card.taskSummary.files.map((f: any) => f.path), ['a.js']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('結果卡只給人看,不送進成員之後的提示詞', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-card-tr-'));
  const { prompts } = await run(dir, [
    { id: 'alice', name: 'Alice', canEdit: true, task: '寫 a.js', writes: { 'a.js': 'a\n' } },
    { id: 'bob', name: 'Bob', canEdit: false, task: '看看' },
  ], async (orc) => {
    const done = new Promise<void>((r) => { const f = (st: any) => { if (!st.running && st.phase && st.phase.code === 'idle') { orc.off('state', f); r(); } }; orc.on('state', f); });
    await orc.userMessage('@Alice 剛剛做得如何', 'divide');
    await done;
  });
  assert.ok(!prompts[prompts.length - 1].includes('任務結果'), '下一回合的提示詞不含結果卡');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('載入紀錄:形狀正確的保留,壞掉的欄位丟掉', () => {
  const ok = O.restoreMessage({ id: 's', kind: 'system', tag: 'task-summary', text: 'x', taskSummary: {
    startedAt: 1, endedAt: 5, members: [{ name: 'A', outcome: 'approved', reviewers: ['B', 3] }, { name: 'X', outcome: 'magic' }],
    files: [{ path: 'a.js', status: 'added', added: 2, removed: -1 }, { path: '', status: 'added' }], moreFiles: 0,
    usage: { inputTokens: 10, outputTokens: 'x', costUsd: null, turns: 3, turnsWithUsage: 1 },
  } });
  assert.deepStrictEqual(ok.taskSummary.members, [{ name: 'A', outcome: 'approved', reviewers: ['B'] }]);
  assert.deepStrictEqual(ok.taskSummary.files, [{ path: 'a.js', status: 'added', added: 2, removed: 0 }]);
  assert.strictEqual(ok.taskSummary.usage.outputTokens, 0);
  assert.strictEqual(O.restoreMessage({ id: 't', kind: 'system', taskSummary: { members: 'x' } }).taskSummary, undefined);
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} task summary tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
