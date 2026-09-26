'use strict';

// 審查的兩個漏洞(評測 eval/ab.ts 找到的):
//   1. 執行回合中途失敗、但已經改了檔案:以前直接跳過審查,寫壞的檔案沒有人看
//   2. 修復後不再審查:修復把原本對的地方改壞,也沒有人看得到
// 現在:動過檔案的失敗成員照樣送審;修好的成員由原本的審查者複查一次,複查通過才算通過。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const O = require('../src/orchestrator');
const adapters = require('../src/adapters');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

// review:當審查者時依序的回覆(第一次審查、複查);api:用 OpenAI 相容型(看工具紀錄)
type Member = { id: string; name: string; task?: string; writes?: Record<string, string>; fixWrites?: Record<string, string>; execError?: string; fixError?: string; review?: string[]; api?: boolean; canEdit?: boolean; verifyCommand?: string; workStyle?: 'general' | 'code'; mode?: string;
  /** 寫測試回合要寫的檔案 */ testWrites?: Record<string, string>;
  /** 任務開始前就存在的檔案 */ before?: Record<string, string>;
  /** 修復回合改用檔案工具寫(測試鎖擋的就是這條路);值是 { 路徑: 內容 } */ fixViaTools?: Record<string, string>;
  expectFiles?: Record<string, string>; execBarrier?: () => Promise<void>; discussion?: string; planReview?: string[];
  maxRounds?: number; stopOnPlan?: boolean; stopOnReview?: boolean; fixSequence?: Array<Record<string, string>>; acceptance?: string[]; allowGit?: boolean };
async function run(team: Member[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-loop-'));
  for (const m of team) for (const [f, c] of Object.entries(m.before || {})) fs.writeFileSync(path.join(dir, f), c);
  const workers = team.filter((m) => m.task);
  const plan = { summary: 's', assignments: workers.map((m) => ({ agent: m.name, task: m.task })), acceptance: team[0].acceptance ?? ['完成指派的工作'] };
  const prompts: Record<string, string[]> = {};
  const turns: Array<{ who: string; phase: string; sessionId: string | null; lockedPaths: string[] }> = [];
  const editableTurns: string[] = [];
  const gitAllowed: boolean[] = [];
  const reviewsGiven: Record<string, number> = {};
  const plansReviewed: Record<string, number> = {};
  const repairsMade: Record<string, number> = {};
  adapters.setRegistry({ get: (id: string) => {
    const m = team.find((x) => x.id === id);
    if (!m) return null;
    return { id, type: m.api ? 'openai' : 'cli', supportsEdit: true, supportsResume: false, capabilities: { attachments: ['textInline'] },
      run: async (_a: any, ctx: any) => {
        (prompts[m.name] ||= []).push(ctx.prompt);
        const phase = /【寫測試】/.test(ctx.prompt) ? 'tests' : /【執行】/.test(ctx.prompt) ? 'execute' : /【交叉審查】/.test(ctx.prompt) ? 'review' : /【修復】/.test(ctx.prompt) ? 'repair' : 'other';
        turns.push({ who: m.name, phase, sessionId: ctx.sessionId ?? null, lockedPaths: ctx.lockedPaths || [] });
        gitAllowed.push(ctx.allowGit === true);
        if (_a.canEdit) editableTurns.push(/【計畫審核】/.test(ctx.prompt) ? 'plan' : /【分工】/.test(ctx.prompt) ? 'divide' : /【總結】/.test(ctx.prompt) ? 'summary' : phase === 'other' ? 'discuss' : phase);
        if (/【分工】/.test(ctx.prompt)) return { text: JSON.stringify(plan) };
        if (/【計畫審核】/.test(ctx.prompt)) {
          if (m.stopOnPlan) orc.stop();
          const index = plansReviewed[m.name] = (plansReviewed[m.name] || 0) + 1;
          const text = m.planReview?.[index - 1] || '[AGREED]';
          return text.startsWith('ERROR:') ? { text: '', error: text.slice(6) } : { text };
        }
        if (/【寫測試】/.test(ctx.prompt)) {
          for (const [f, c] of Object.entries(m.testWrites || {})) fs.writeFileSync(path.join(dir, f), c);
          return { text: '測試寫好了', toolEvents: Object.keys(m.testWrites || {}).map((f) => ({ name: 'write_file', ok: true, path: f, result: {} })) };
        }
        if (/【執行】/.test(ctx.prompt)) {
          for (const [file, content] of Object.entries(m.expectFiles || {})) assert.strictEqual(fs.readFileSync(path.join(ctx.cwd, file), 'utf8'), content);
          if (m.execBarrier) await m.execBarrier();
          for (const [f, c] of Object.entries(m.writes || {})) fs.writeFileSync(path.join(ctx.cwd, f), c);
          const toolEvents = Object.keys(m.writes || {}).map((f) => ({ name: 'write_file', ok: true, path: f, result: {} }));
          return m.execError ? { text: '', error: m.execError, toolEvents } : { text: '完成', toolEvents };
        }
        if (/【交叉審查】/.test(ctx.prompt)) {
          if (m.stopOnReview) orc.stop();
          const i = reviewsGiven[m.name] = (reviewsGiven[m.name] || 0) + 1;
          const say = (m.review || [])[i - 1] || '沒問題\n[NO_ISSUES]';
          // 「ERROR:」開頭代表這一次審查回合失敗(逾時、端點錯誤)
          // sessionId:審查回合開出來的 session 不該被沿用到成員自己的回合
          return say.startsWith('ERROR:') ? { text: '', error: say.slice(6) } : { text: say, sessionId: 'review-session-' + m.id };
        }
        if (/【修復】/.test(ctx.prompt)) {
          const index = repairsMade[m.name] = (repairsMade[m.name] || 0) + 1;
          for (const [f, c] of Object.entries(m.fixSequence?.[index - 1] || m.fixWrites || {})) fs.writeFileSync(path.join(dir, f), c);
          // 用檔案工具寫:測試鎖擋的就是這條路,ctx.lockedPaths 會傳進工具層
          const toolEvents: any[] = [];
          if (m.fixViaTools) {
            const { FileToolSession } = require('../src/adapters/file-tools');
            const session = new FileToolSession(dir, { locked: ctx.lockedPaths || [] });
            for (const [f, c] of Object.entries(m.fixViaTools)) {
              const sha = session.execute('read_file', { path: f }).sha256;
              const r = session.execute('write_file', { path: f, content: c, reason: '修復', expectedSha256: sha });
              toolEvents.push({ name: 'write_file', ok: r.ok, path: f, result: r });
            }
          }
          return { text: m.fixError ? '' : '已修正', error: m.fixError, toolEvents };
        }
        if (/【總結】/.test(ctx.prompt)) return { text: '總結' };
        return { text: m.discussion || '[AGREED]' };
      } };
  } });
  const agents = team.map((m) => ({ id: m.id, name: m.name, cli: m.id, enabled: true, canEdit: m.canEdit !== false, color: '#000', persona: '', model: '', effort: '', customCommand: '' }));
  const settings = { maxTranscriptChars: 0, language: '繁體中文', workDir: dir, maxRounds: team[0].maxRounds || 1, mode: 'divide', uiLocale: 'zh-Hant', leadAgentId: team[0].id, verifyCommand: team.find((m) => m.verifyCommand)?.verifyCommand || '', workStyle: team.find((m) => m.workStyle)?.workStyle || 'code', allowGitCommit: team[0].allowGit === true };
  const orc = new O.Orchestrator({ get: () => ({ agents, settings }), userDataDir: os.tmpdir() });
  const done = new Promise<void>((r) => { const f = (st: any) => { if (!st.running && st.phase && st.phase.code === 'idle') { orc.off('state', f); r(); } }; orc.on('state', f); });
  await orc.userMessage('分工', team.find((m) => m.mode)?.mode || 'divide');
  await done;
  const retained: string[] = [];
  for (const message of orc.messages.filter((message: any) => message.tag === 'conflict')) {
    const root = /`([^`]*ai-roundtable-lanes-[^`]*)`/.exec(message.text)?.[1];
    if (!root || !fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      const file = path.join(root, name, 'shared.js');
      if (fs.existsSync(file)) retained.push(fs.readFileSync(file, 'utf8'));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  // 先把工作目錄拍下來再清:停損有沒有真的回退,只能看磁碟,不能看訊息。
  const files = new Map<string, string>();
  const walk = (rel = '') => {
    for (const name of fs.readdirSync(path.join(dir, rel))) {
      const child = rel ? `${rel}/${name}` : name;
      if (fs.statSync(path.join(dir, child)).isDirectory()) walk(child);
      else files.set(child, fs.readFileSync(path.join(dir, child), 'utf8'));
    }
  };
  walk();
  fs.rmSync(dir, { recursive: true, force: true });
  const read = (file: string) => (files.has(file) ? files.get(file)! : null);
  const card = orc.messages.find((m: any) => m.tag === 'task-summary')?.taskSummary;
  const outcome = Object.fromEntries((card?.members || []).map((m: any) => [m.name, m.outcome]));
  const reviews = orc.messages.filter((m: any) => m.review);
  const summaryPrompt = (prompts[team[0].name] || []).find((p) => /【總結】/.test(p)) || '';
  return { outcome, card, reviews, prompts, summaryPrompt, turns, editableTurns, gitAllowed, orc, read, retained };
}

test('多 AI 把關:一票通過不能蓋過另一票失敗,且不沿用修改前的通過票', async () => {
  for (const votes of [['ERROR:timeout'], ['有問題', 'ERROR:timeout'], ['有問題', '仍有問題', '仍有問題', '仍有問題']]) {
    const result = await run([
      { id: 'lead', name: '主持人', mode: 'guarded', canEdit: false },
      { id: 'author', name: '作者', task: '寫 a.txt', writes: { 'a.txt': 'done' } },
      { id: 'reviewer', name: '審查者', canEdit: false, review: votes },
    ]);
    assert.notStrictEqual(result.outcome['作者'], 'approved');
    assert.strictEqual(result.card.guard.status, 'blocked');
    assert.ok(result.turns.filter((turn) => turn.phase === 'repair').length <= 3);
    assert.ok(result.turns.filter((turn) => turn.phase === 'review').every((turn) => turn.sessionId === null));
  }
});

test('多 AI 把關:可以修正多輪,每輪所有審查者都必須重新通過', async () => {
  const result = await run([
    { id: 'lead', name: '主持人', mode: 'guarded', canEdit: false },
    { id: 'author', name: '作者', task: '寫 a.txt', writes: { 'a.txt': 'done' } },
    { id: 'reviewer', name: '審查者', canEdit: false, review: ['有問題', '還有問題', '[NO_ISSUES]'] },
  ]);
  assert.strictEqual(result.outcome['作者'], 'approved');
  assert.strictEqual(result.turns.filter((turn) => turn.phase === 'repair').length, 2);
  assert.strictEqual(result.turns.filter((turn) => turn.phase === 'review' && turn.who === '主持人').length, 3);
  assert.deepStrictEqual(result.card.guard, { stage: 'review', status: 'passed', reviewers: 2, repairRounds: 2 });
  assert.deepStrictEqual(result.card.members[0].reviewers, ['主持人', '審查者']);
});

test('多 AI 把關:其中一份成果修正後,其他成果也要重新送審', async () => {
  const result = await run([
    { id: 'lead', name: '主持人', mode: 'guarded', canEdit: false, review: ['a 有問題', '[NO_ISSUES]'] },
    { id: 'author', name: '作者', task: '寫 a.txt', writes: { 'a.txt': 'done' } },
    { id: 'other', name: '另一位作者', task: '寫 b.txt', writes: { 'b.txt': 'done' } },
  ]);
  assert.strictEqual(result.reviews.length, 8);
  assert.ok(result.card.members.every((member: any) => member.outcome === 'approved'));
});

test('多 AI 把關:複查新增的反例確實執行,全員同意也不能覆蓋失敗證據', async () => {
  const counterexample = '```counterexample new finding\nrequire("assert").strictEqual(1, 2);\n```\n[NO_ISSUES]';
  const result = await run([
    { id: 'lead', name: '主持人', mode: 'guarded', canEdit: false },
    { id: 'author', name: '作者', task: '寫 a.txt', writes: { 'a.txt': 'done' } },
    { id: 'reviewer', name: '審查者', canEdit: false, review: ['請修正', counterexample, '[NO_ISSUES]', '[NO_ISSUES]'] },
  ]);
  assert.strictEqual(result.card.guard.status, 'blocked');
  assert.strictEqual(result.outcome['作者'], 'unresolved');
  assert.ok(result.card.counterexamples.some((item: any) => item.title === 'new finding' && item.confirmation === 'confirmed' && item.afterRepair === 'failed'));
});

test('多 AI 把關:四位成員的一般任務需要三位審查者,不執行程式驗證', async () => {
  const result = await run([
    { id: 'lead', name: '主持人', mode: 'guarded', canEdit: false, workStyle: 'general', verifyCommand: 'exit 1' },
    { id: 'author', name: '作者', task: '寫文件', writes: { 'a.txt': 'done' } },
    { id: 'second', name: '第二位', canEdit: false },
    { id: 'third', name: '第三位', canEdit: false },
  ]);
  assert.strictEqual(result.card.guard.reviewers, 3);
  assert.strictEqual(result.card.guard.status, 'passed');
  assert.strictEqual(result.card.verify, undefined);
  assert.strictEqual(result.reviews.length, 3);
});

test('多 AI 把關:計畫被退回後重新審核,只有新版全員同意才執行', async () => {
  const result = await run([
    { id: 'lead', name: '主持人', mode: 'guarded', maxRounds: 2, canEdit: false },
    { id: 'author', name: '作者', task: '寫文件', writes: { 'a.txt': 'done' } },
    { id: 'second', name: '第二位', canEdit: false, planReview: ['請補充驗收', '[AGREED]'] },
  ]);
  assert.strictEqual(result.orc.messages.filter((message: any) => message.tag === 'plan-review').length, 2);
  assert.strictEqual(result.read('a.txt'), 'done');
  assert.strictEqual(result.card.guard.status, 'passed');
});

test('多 AI 把關:唯讀成員的報告被退回時可重寫並重新送審,不會改檔', async () => {
  const result = await run([
    { id: 'lead', name: '主持人', mode: 'guarded', workStyle: 'general', canEdit: false, review: ['報告與檔案不符', '[NO_ISSUES]'] },
    { id: 'analyst', name: '分析者', task: '整理風險', canEdit: false },
    { id: 'reviewer', name: '審查者', canEdit: false },
  ]);
  assert.ok(result.turns.some((turn) => turn.who === '分析者' && turn.phase === 'repair'));
  assert.ok(result.prompts['分析者'].some((prompt) => /唯讀/.test(prompt) && /【修復】/.test(prompt)));
  assert.deepStrictEqual(result.editableTurns, []);
  assert.strictEqual(result.card.guard.status, 'passed');
  assert.strictEqual(result.card.guard.repairRounds, 1);
});

test('git 提交權限:預設告訴主持人不要安排提交且不授權轉接器;使用者開啟後才放行', async () => {
  const team = (allowGit: boolean): Member[] => [
    { id: 'lead', name: '主持人', mode: 'guarded', canEdit: false, allowGit },
    { id: 'author', name: '作者', task: '寫 a.txt', writes: { 'a.txt': 'done' } },
  ];
  const blocked = await run(team(false));
  assert.ok(blocked.prompts['主持人'].some((prompt: string) => /【分工】/.test(prompt) && /不允許成員建立 git 提交/.test(prompt)));
  assert.ok(blocked.gitAllowed.every((allowed) => !allowed));
  const allowed = await run(team(true));
  assert.ok(!allowed.prompts['主持人'].some((prompt: string) => /不允許成員建立 git 提交/.test(prompt)));
  assert.ok(allowed.gitAllowed.every((value) => value));
});

test('有改檔權限的 CLI 成員只在執行與修復回合可寫,討論、計畫審核、審查與總結都唯讀', async () => {
  const result = await run([
    { id: 'lead', name: '主持人', mode: 'guarded', review: ['請修正', '[NO_ISSUES]'] },
    { id: 'author', name: '作者', task: '寫文件', writes: { 'a.txt': 'draft' }, fixWrites: { 'a.txt': 'done' } },
    { id: 'reviewer', name: '審查者' },
  ]);
  assert.strictEqual(result.read('a.txt'), 'done');
  assert.deepStrictEqual([...new Set(result.editableTurns)].sort(), ['execute', 'repair']);
});

test('多 AI 把關:討論與計畫審核接受句尾的同意標記,否定語境仍阻擋', async () => {
  const agreed = await run([
    { id: 'lead', name: '主持人', mode: 'guarded', canEdit: false, discussion: '同意這個方向。[AGREED]' },
    { id: 'author', name: '作者', task: '寫文件', writes: { 'a.txt': 'done' } },
    { id: 'second', name: '第二位', canEdit: false, planReview: ['計畫可行。[AGREED]'] },
  ]);
  assert.strictEqual(agreed.read('a.txt'), 'done');
  assert.strictEqual(agreed.card.guard.status, 'passed');
  const refused = await run([
    { id: 'lead', name: '主持人', mode: 'guarded', canEdit: false },
    { id: 'author', name: '作者', task: '寫文件', writes: { 'a.txt': 'done' } },
    { id: 'second', name: '第二位', canEdit: false, planReview: ['驗收條件不清楚,所以我不寫 [AGREED]'] },
  ]);
  assert.strictEqual(refused.read('a.txt'), null);
  assert.ok(refused.orc.messages.some((message: any) => message.tag === 'guarded-stop'));
});

test('多 AI 把關:停止計畫或成果審查後,不能繼續執行或修正', async () => {
  for (const duringPlan of [true, false]) {
    const result = await run([
      { id: 'lead', name: '主持人', mode: 'guarded', canEdit: false },
      { id: 'author', name: '作者', task: '寫文件', writes: { 'a.txt': 'done' } },
      { id: 'reviewer', name: '審查者', canEdit: false, stopOnPlan: duringPlan, stopOnReview: !duringPlan, review: ['請修正'] },
    ]);
    assert.strictEqual(result.card, undefined);
    assert.ok(!result.turns.some((turn) => turn.phase === 'repair'));
    if (duringPlan) assert.strictEqual(result.read('a.txt'), null);
  }
});

test('多 AI 把關:第二輪修正退步仍可收回整段修正,不標成通過', async () => {
  const result = await run([
    { id: 'lead', name: '主持人', mode: 'guarded', canEdit: false, review: ['請修正', '還有問題', '[NO_ISSUES]'] },
    { id: 'author', name: '作者', task: '寫程式', writes: { 'a.js': 'module.exports = 1;' }, fixSequence: [{ 'a.js': 'module.exports = 2;' }, { 'a.js': 'module.exports = };' }] },
    { id: 'reviewer', name: '審查者', canEdit: false },
  ]);
  assert.strictEqual(result.read('a.js'), 'module.exports = 1;');
  assert.strictEqual(result.card.guard.status, 'blocked');
  assert.deepStrictEqual(result.card.rollback, { scope: 'repair', status: 'complete' });
});

test('多 AI 把關:每份成果由所有其他成員審查,至少兩票且全數通過', () => {
  const { pickReviewPairs, allReviewsPassed } = require('../src/flow/review');
  const agents = ['author', 'reviewer1', 'reviewer2', 'reviewer3'].map((id) => ({ id }));
  const reports = agents.slice(0, 2).map((agent) => ({ agent, task: 'task', report: 'done' }));
  const pairs = pickReviewPairs(agents, reports, true);
  assert.strictEqual(pairs.length, 6);
  assert.ok(pairs.every((pair: any) => pair.reviewer.id !== pair.target.agent.id));
  const reviews = pairs.map((pair: any) => ({ ...pair, text: '[NO_ISSUES]' }));
  assert.strictEqual(allReviewsPassed(agents, 'author', reviews), true);
  assert.strictEqual(allReviewsPassed(agents, 'author', reviews.slice(1)), false);
  assert.strictEqual(allReviewsPassed(agents, 'author', [{ ...reviews[0], error: 'timeout' }, ...reviews.slice(1)]), false);
  assert.strictEqual(allReviewsPassed(agents, 'author', [{ ...reviews[0], text: 'needs repair' }, ...reviews.slice(1)]), false);
  assert.strictEqual(allReviewsPassed(agents.slice(0, 2), 'author', reviews), false);
  assert.strictEqual(allReviewsPassed(agents, 'author', [...reviews, reviews[0]]), false);
});

test('多 AI 把關:少於兩位、討論未同意、計畫被否決或審核失敗都不開工', async () => {
  for (const reason of ['members', 'discussion', 'plan', 'error']) {
    const team: Member[] = [
      { id: 'lead', name: '主持人', mode: 'guarded', canEdit: false },
      { id: 'author', name: '作者', task: '寫 a.txt', writes: { 'a.txt': 'done' },
        discussion: reason === 'discussion' ? '不同意' : undefined,
        planReview: reason === 'plan' ? ['缺少驗收條件'] : reason === 'error' ? ['ERROR:timeout'] : undefined },
      { id: 'reviewer', name: '審查者', canEdit: false },
    ];
    const result = await run(reason === 'members' ? team.slice(0, 1) : team);
    assert.strictEqual(result.read('a.txt'), null, reason);
    assert.ok(!result.turns.some((turn) => turn.phase === 'execute'), reason);
    assert.ok(result.orc.messages.some((message: any) => message.tag === 'guarded-stop'), reason);
  }
});

test('多 AI 把關:兩位成員時,作者另開全新上下文擔任第二位審查者,兩票都過才通過', async () => {
  const passed = await run([
    { id: 'lead', name: '主持人', mode: 'guarded', canEdit: false },
    { id: 'author', name: '作者', task: '寫 a.txt', writes: { 'a.txt': 'done' } },
  ]);
  assert.deepStrictEqual(passed.reviews.map((message: any) => message.agentName).sort(), ['主持人', '作者']);
  const selfPrompt = passed.prompts['作者'].find((prompt: string) => /【交叉審查】/.test(prompt)) || '';
  assert.match(selfPrompt, /全新上下文的獨立審查者/);
  assert.strictEqual(passed.card.guard.status, 'passed');
  assert.strictEqual(passed.card.guard.reviewers, 2);
  const blocked = await run([
    { id: 'lead', name: '主持人', mode: 'guarded', canEdit: false },
    { id: 'author', name: '作者', task: '寫 a.txt', writes: { 'a.txt': 'done' }, review: ['驗收條件沒有達成', '仍未達成', '仍未達成', '仍未達成'] },
  ]);
  assert.strictEqual(blocked.card.guard.status, 'blocked', '作者的獨立審查不通過就不算通過');
});

test('多 AI 把關:計畫必須列出驗收條件,並交給審查者逐條對照', async () => {
  const missing = await run([
    { id: 'lead', name: '主持人', mode: 'guarded', canEdit: false, acceptance: [] },
    { id: 'author', name: '作者', task: '寫 a.txt', writes: { 'a.txt': 'done' } },
    { id: 'reviewer', name: '審查者', canEdit: false },
  ]);
  assert.strictEqual(missing.read('a.txt'), null);
  assert.ok(missing.orc.messages.some((message: any) => /沒有列出驗收條件/.test(message.text)));
  assert.ok(!missing.turns.some((turn) => turn.phase === 'execute'));
  assert.ok(!missing.prompts['審查者'].some((prompt: string) => /【計畫審核】/.test(prompt)), '沒有驗收條件就不送審');
  const listed = await run([
    { id: 'lead', name: '主持人', mode: 'guarded', canEdit: false, acceptance: ['a.txt 內容為 done'] },
    { id: 'author', name: '作者', task: '寫 a.txt', writes: { 'a.txt': 'done' } },
    { id: 'reviewer', name: '審查者', canEdit: false },
  ]);
  assert.ok(listed.orc.messages.some((message: any) => message.tag === 'plan' && /驗收條件[\s\S]*a\.txt 內容為 done/.test(message.text)));
  assert.match(listed.prompts['審查者'].find((prompt: string) => /【交叉審查】/.test(prompt)) || '', /完成標準[\s\S]*1\. a\.txt 內容為 done[\s\S]*不要要求它做分工以外/);
  assert.ok(listed.prompts['主持人'].some((prompt: string) => /【分工】/.test(prompt) && /acceptance/.test(prompt)));
});

test('多 AI 把關:具體計畫獲所有其他成員同意後才執行', async () => {
  const result = await run([
    { id: 'lead', name: '主持人', mode: 'guarded', canEdit: false },
    { id: 'author', name: '作者', task: '寫 a.txt', writes: { 'a.txt': 'done' } },
    { id: 'reviewer', name: '審查者', canEdit: false },
  ]);
  assert.strictEqual(result.read('a.txt'), 'done');
  assert.ok(result.orc.messages.some((message: any) => message.tag === 'plan-approved'));
  assert.match(result.prompts['審查者'].find((prompt) => prompt.includes('【計畫審核】'))!, /寫 a.txt/);
});

test('修好之後複查通過:才算審查通過;複查看得到上一輪的意見', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', review: ['a.js 少了分號', '修好了\n[NO_ISSUES]'], canEdit: false },
    { id: 'alice', name: 'Alice', task: '寫 a.js', writes: { 'a.js': 'x\n' } },
  ]);
  assert.strictEqual(r.outcome.Alice, 'approved');
  const recheck = r.reviews.find((m: any) => m.review.recheck);
  assert.ok(recheck, '修復後要有一則複查');
  assert.strictEqual(recheck.review.target, 'Alice');
  assert.strictEqual(recheck.review.verdict, 'pass');
  const prompt = r.prompts['主持人'].filter((p: string) => /【交叉審查】/.test(p))[1];
  assert.match(prompt, /這是修復後的複查/);
  assert.match(prompt, /a\.js 少了分號/, '複查要看得到上一輪的意見');
  assert.match(prompt, /已修正/, '複查看的是修復回報');
});

test('複查仍有問題:不再修,帶進總結;結果卡是「有未解決的問題」', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', review: ['a.js 少了分號', '還是少了分號'], canEdit: false },
    { id: 'alice', name: 'Alice', task: '寫 a.js', writes: { 'a.js': 'x\n' } },
  ]);
  assert.strictEqual(r.outcome.Alice, 'unresolved');
  assert.strictEqual(r.orc.messages.filter((m: any) => m.phase && m.phase.code === 'repair').length, 1, '只修一次');
  assert.match(r.summaryPrompt, /還是少了分號/, '複查的意見要進總結');
  assert.ok(r.orc.messages.some((m: any) => m.kind === 'system' && /複查後「Alice」仍有問題/.test(m.text)));
});

test('複查本身失敗:維持「已修復(未再審查)」,不能當成通過', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', review: ['a.js 少了分號', 'ERROR:逾時'], canEdit: false },
    { id: 'alice', name: 'Alice', task: '寫 a.js', writes: { 'a.js': 'x\n' } },
  ]);
  assert.strictEqual(r.outcome.Alice, 'repaired');
});

test('第一次就通過:不修也不複查', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', canEdit: false },
    { id: 'alice', name: 'Alice', task: '寫 a.js', writes: { 'a.js': 'x\n' } },
  ]);
  assert.strictEqual(r.outcome.Alice, 'approved');
  assert.strictEqual(r.reviews.length, 1);
});

test('執行中途失敗但改了檔案(唯一的 CLI 寫入者):照樣送審,審查者知道檔案可能只改了一半', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', review: ['a.js 語法錯誤,載不起來', '修好了\n[NO_ISSUES]'], canEdit: false },
    { id: 'alice', name: 'Alice', task: '寫 a.js', writes: { 'a.js': 'module.exports = 1;\n' }, execError: '工具呼叫往返超過 10 次' },
  ]);
  const prompt = r.prompts['主持人'].find((p: string) => /【交叉審查】/.test(p));
  assert.ok(prompt, '中途失敗但改了檔案,要送審');
  assert.match(prompt, /執行回合中途失敗\(工具呼叫往返超過 10 次\)/);
  assert.match(prompt, /a\.js/);
  assert.ok(r.orc.messages.some((m: any) => m.kind === 'system' && /執行回合中途失敗\*\*,但已經改了檔案/.test(m.text)));
  // 審查出問題 → 修復 → 複查通過:留下來的檔案能用了
  assert.strictEqual(r.outcome.Alice, 'approved');
});

test('執行中途失敗、沒有改任何檔案:不送審,維持「執行失敗」', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', canEdit: false },
    { id: 'alice', name: 'Alice', task: '寫 a.js', execError: 'CLI 沒有安裝' },
  ]);
  assert.strictEqual(r.reviews.length, 0);
  assert.strictEqual(r.outcome.Alice, 'failed');
  assert.ok(r.orc.messages.some((m: any) => m.kind === 'system' && /\*\*執行失敗\*\*,這些成員的成果不會進入審查/.test(m.text)));
});

test('API 成員看自己的工具紀錄:它寫過檔就送審,就算其他成員也平行改了檔案', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', canEdit: false },
    { id: 'alice', name: 'Alice', task: '寫 a.js', writes: { 'a.js': 'x\n' }, api: true, execError: '工具呼叫往返超過 10 次' },
    { id: 'bob', name: 'Bob', task: '寫 b.js', writes: { 'b.js': 'y\n' }, api: true, execError: '逾時' },
    { id: 'carol', name: 'Carol', task: '分析', api: true, execError: '逾時' },
  ]);
  assert.strictEqual(r.outcome.Alice, 'approved');
  assert.strictEqual(r.outcome.Bob, 'approved');
  assert.strictEqual(r.outcome.Carol, 'failed', '沒寫過檔的不送審');
});

test('自動驗證沒過:審查說通過也要修,修好了才算通過', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', canEdit: false },
    { id: 'alice', name: 'Alice', task: '寫 a.js', writes: { 'a.js': 'function broken( {\n' }, fixWrites: { 'a.js': 'module.exports = 1;\n' } },
  ]);
  assert.ok(r.orc.messages.some((m: any) => m.tag === 'verify' && /自動驗證沒過/.test(m.text)), '要有自動驗證沒過的訊息');
  const fixPrompt = r.prompts['Alice'].find((p: string) => /【修復】/.test(p));
  assert.ok(fixPrompt, '驗證沒過就要進修復回合,即使審查說通過');
  assert.match(fixPrompt, /自動語法檢查沒過/);
  assert.match(fixPrompt, /a\.js/);
  assert.strictEqual(r.card.verify, 'syntax-only', '修復後重驗通過,但沒有專案驗證指令');
  assert.strictEqual(r.outcome.Alice, 'approved');
});

test('修復之後還是壞的:結果卡說沒過,成員是「有未解決的問題」', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', canEdit: false },
    { id: 'alice', name: 'Alice', task: '寫 a.js', writes: { 'a.js': 'function broken( {\n' } },
  ]);
  // 過程中確實沒過(修復前的那則系統訊息),但載不起來的新檔已先回退。
  // 結果卡描述的是回退之後的工作目錄:沒有留下的 .js,就沒有東西可驗。
  assert.ok(r.orc.messages.some((m: any) => m.tag === 'verify' && /自動驗證沒過/.test(m.text)));
  assert.strictEqual(r.card.verify, 'none');
  assert.strictEqual(r.outcome.Alice, 'unresolved', '壞檔已收回,沒有交付就不能算審查通過');
  const text = r.orc.messages.find((m: any) => m.tag === 'task-summary').text;
  assert.match(text, /沒有自動驗證/, '純文字版要講回退後的狀態,不能再把已刪掉的壞檔說成沒過');
  assert.strictEqual(r.read('a.js'), null, '載不起來的新檔不該留在工作目錄');
  assert.ok(r.orc.messages.some((m: any) => m.tag === 'revert' && /已先把工作目錄還原/.test(m.text)));
  const revertAt = r.orc.messages.findIndex((m: any) => m.tag === 'revert');
  const cardAt = r.orc.messages.findIndex((m: any) => m.tag === 'task-summary');
  assert.ok(revertAt >= 0 && revertAt < cardAt, '先回退,結果卡描述的才是回退後的工作目錄');
});

test('修復把通過的檔案改到載不起來:只收回修復,執行階段的成果留下', async () => {
  // 補測 2 的 poker-fix 圓桌:自動驗證、複查、結果卡都指出多一個 } 的壞檔,最後仍留在工作目錄。
  const r = await run([
    { id: 'lead', name: '主持人', review: ['這裡還有一個邊界沒處理', '還是沒處理好'], canEdit: false },
    { id: 'alice', name: 'Alice', task: '寫 a.js', writes: { 'a.js': 'module.exports = { ok: true };\n' }, fixWrites: { 'a.js': 'module.exports = { ok: true;\n' } },
  ]);
  assert.strictEqual(r.read('a.js'), 'module.exports = { ok: true };\n', '回到修復前,不是整個任務重來');
  assert.strictEqual(r.card.repairBroke, true, '結果卡仍要說修復把事情弄糟,退路也還在');
  assert.strictEqual(r.card.verify, 'syntax-only', '收回修復後重驗,執行階段的檔案載得起來,但仍只是語法檢查');
  assert.deepStrictEqual(r.card.rollback, { scope: 'repair', status: 'complete' });
  assert.strictEqual(r.outcome.Alice, 'unresolved');
  assert.ok(r.orc.messages.some((m: any) => m.tag === 'revert' && /已先收回修復回合/.test(m.text)));
});

test('執行階段只有文字成果:修復新增壞 JS 時不撤回原成果', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', review: ['還需要補一份範例'], canEdit: false },
    { id: 'alice', name: 'Alice', task: '寫文件', writes: { 'notes.txt': 'execute result\n' }, fixWrites: { 'example.js': 'module.exports = };\n' } },
  ]);
  assert.strictEqual(r.read('notes.txt'), 'execute result\n');
  assert.strictEqual(r.read('example.js'), null);
  assert.deepStrictEqual(r.card.rollback, { scope: 'repair', status: 'complete' });
  assert.strictEqual(r.card.verify, 'none');
  assert.strictEqual(r.outcome.Alice, 'unresolved');
});

test('修復報錯仍重驗並回退;即使審查放行也不能算交付', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', review: ['請修正邊界條件'], canEdit: false },
    { id: 'alice', name: 'Alice', task: '寫 a.js', writes: { 'a.js': 'module.exports = 1;\n' }, fixWrites: { 'a.js': 'module.exports = };\n' }, fixError: '工具連續失敗' },
  ]);
  assert.strictEqual(r.read('a.js'), 'module.exports = 1;\n');
  assert.deepStrictEqual(r.card.rollback, { scope: 'repair', status: 'complete' });
  assert.strictEqual(r.card.verify, 'syntax-only');
  assert.strictEqual(r.outcome.Alice, 'unresolved');
  assert.match(r.summaryPrompt, /工具連續失敗/);
});

test('語法原本通過但測試未過:修復弄壞語法仍只收回修復', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', canEdit: false, verifyCommand: 'exit 7' },
    { id: 'alice', name: 'Alice', task: '寫 a.js', writes: { 'a.js': 'module.exports = 1;\n' }, fixWrites: { 'a.js': 'module.exports = };\n' } },
  ]);
  assert.strictEqual(r.read('a.js'), 'module.exports = 1;\n');
  assert.deepStrictEqual(r.card.rollback, { scope: 'repair', status: 'complete' });
  assert.strictEqual(r.card.verify, 'failed');
  assert.strictEqual(r.outcome.Alice, 'unresolved');
});

test('整個任務回退後重新檢查還原的檔案,所有被撤回的寫入者均未交付', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', canEdit: false },
    { id: 'alice', name: 'Alice', api: true, task: '修正 a.js', before: { 'a.js': 'module.exports = 0;\n' }, writes: { 'a.js': 'module.exports = };\n' } },
    { id: 'bob', name: 'Bob', api: true, task: '寫文件', writes: { 'b.txt': '完成\n' } },
  ]);
  assert.strictEqual(r.read('a.js'), 'module.exports = 0;\n');
  assert.strictEqual(r.read('b.txt'), null);
  assert.strictEqual(r.card.verify, 'syntax-only');
  assert.deepStrictEqual(r.card.rollback, { scope: 'task', status: 'complete' });
  assert.deepStrictEqual(r.outcome, { Alice: 'unresolved', Bob: 'unresolved' });
  assert.deepStrictEqual(r.card.files, []);
  assert.match(r.summaryPrompt, /成果仍未交付/);
});

test('驗證指令沒過不自動回退:那可能是沒做完,不是檔案壞了', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', review: ['測試沒過', '還是沒過'], canEdit: false, verifyCommand: 'exit 7' },
    { id: 'alice', name: 'Alice', task: '寫 a.js', writes: { 'a.js': 'module.exports = 1;\n' }, fixWrites: { 'a.js': 'module.exports = 2;\n' } },
  ]);
  assert.strictEqual(r.read('a.js'), 'module.exports = 2;\n', '執行階段就失敗、修復沒有讓它變得更差,不該擅自回退');
  assert.strictEqual(r.orc.messages.some((m: any) => m.tag === 'revert'), false);
  assert.notStrictEqual(r.card.repairBroke, true, '執行後指令就失敗,不是修復造成退步');
  assert.strictEqual(r.card.verify, 'failed');
});

test('修復把原本通過的驗證指令改成失敗:只收回修復', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', review: ['還要再改', '還是不行'], canEdit: false, verifyCommand: 'node -e "process.exit(require(\'./a.js\')===1?0:3)"' },
    { id: 'alice', name: 'Alice', task: '寫 a.js', writes: { 'a.js': 'module.exports = 1;\n' }, fixWrites: { 'a.js': 'module.exports = 2;\n' } },
  ]);
  assert.strictEqual(r.read('a.js'), 'module.exports = 1;\n', '驗證從通過變成失敗,要回到修復前');
  assert.strictEqual(r.card.repairBroke, true);
  assert.deepStrictEqual(r.card.rollback, { scope: 'repair', status: 'complete' });
  assert.strictEqual(r.card.verify, 'passed', '收回後專案驗證指令再次通過');
  assert.strictEqual(r.outcome.Alice, 'unresolved');
});

test('驗證指令失敗也要修;沒有東西可驗時照實說', async () => {
  const fail = await run([
    { id: 'lead', name: '主持人', canEdit: false, verifyCommand: 'exit 7' },
    { id: 'alice', name: 'Alice', task: '寫 a.txt', writes: { 'a.txt': 'x\n' } },
  ]);
  assert.strictEqual(fail.card.verify, 'failed');
  assert.match(fail.prompts['Alice'].find((p: string) => /【修復】/.test(p)) || '', /驗證指令失敗.*結束代碼 7/s);
  const none = await run([
    { id: 'lead', name: '主持人', canEdit: false },
    { id: 'alice', name: 'Alice', task: '寫 a.txt', writes: { 'a.txt': 'x\n' } },
  ]);
  assert.strictEqual(none.card.verify, 'none');
  assert.ok(none.orc.messages.some((m: any) => /沒有可以自動驗證的東西/.test(m.text)));
  assert.strictEqual(none.outcome.Alice, 'approved');
});

test('已有失敗的驗證指令,修復仍不得弄壞前面通過的關卡', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', canEdit: false, verifyCommand: 'node -e "process.exit(require(\'./a.js\')===1?0:3)"\nexit 7' },
    { id: 'alice', name: 'Alice', task: '寫 a.js', writes: { 'a.js': 'module.exports = 1;\n' }, fixWrites: { 'a.js': 'module.exports = 2;\n' } },
  ]);
  assert.strictEqual(r.read('a.js'), 'module.exports = 1;\n');
  assert.strictEqual(r.card.repairBroke, true);
  assert.deepStrictEqual(r.card.rollback, { scope: 'repair', status: 'complete' });
  assert.strictEqual(r.card.verify, 'failed');
});

test('有改檔權限的專職審查者直接修復,由第三位成員獨立複查', async () => {
  const r = await run([
    { id: 'lead', name: 'Reviewer', review: ['a.js 邊界情況錯誤'], fixWrites: { 'a.js': 'module.exports = 2;\n' } },
    { id: 'alice', name: 'Alice', api: true, task: '寫 a.js', writes: { 'a.js': 'module.exports = 1;\n' }, fixWrites: { 'a.js': 'module.exports = 3;\n' } },
    { id: 'checker', name: 'Checker', canEdit: false },
  ]);
  assert.strictEqual(r.read('a.js'), 'module.exports = 2;\n');
  assert.deepStrictEqual(r.turns.filter((turn) => turn.phase === 'repair').map((turn) => turn.who), ['Reviewer']);
  assert.strictEqual(r.reviews.find((message: any) => message.review.recheck).agentName, 'Checker');
  assert.strictEqual(r.outcome.Alice, 'approved');
  assert.ok(r.orc.messages.some((message: any) => message.tag === 'repair' && /Reviewer.*Checker/.test(message.text)));
});

test('沒有第三位獨立複查者時不把修復交給原審查者自審', async () => {
  const r = await run([
    { id: 'lead', name: 'Reviewer', review: ['a.js 要修'], fixWrites: { 'a.js': 'module.exports = 2;\n' } },
    { id: 'alice', name: 'Alice', task: '寫 a.js', writes: { 'a.js': 'module.exports = 1;\n' }, fixWrites: { 'a.js': 'module.exports = 3;\n' } },
  ]);
  assert.strictEqual(r.read('a.js'), 'module.exports = 3;\n');
  assert.deepStrictEqual(r.turns.filter((turn) => turn.phase === 'repair').map((turn) => turn.who), ['Alice']);
});

test('審查者看得到自動驗證的結果', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', canEdit: false },
    { id: 'alice', name: 'Alice', task: '寫 a.js', writes: { 'a.js': 'module.exports = 1;\n' } },
  ]);
  const prompt = r.prompts['主持人'].find((p: string) => /【交叉審查】/.test(p)) || '';
  assert.match(prompt, /通過 app 的自動驗證/);
  assert.strictEqual(r.card.verify, 'syntax-only', '沒有專案驗證指令時不能標成完整通過');
});

test('測試鎖:修復回合不能改既有的測試檔,審查者也被告知', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', review: ['實作有問題', '還是有問題'], canEdit: false },
    {
      id: 'alice', name: 'Alice', task: '改 app.js',
      before: { 'a.test.js': "require('assert').strictEqual(require('./app').add(1, 2), 3);\n", 'app.js': 'exports.add = (a, b) => a - b;\n' },
      // 執行階段先改了既有測試(要被標出來),修復階段再試著用工具改一次(要被擋下)
      writes: { 'a.test.js': "require('assert').ok(true);\n" },
      fixViaTools: { 'a.test.js': "require('assert').ok(true); // 再放寬一次\n" },
    },
  ]);
  assert.ok(r.orc.messages.some((m: any) => m.tag === 'test-lock' && /動到任務開始前就有的測試檔/.test(m.text)), '動到既有測試要說出來');
  const reviewPrompt = r.prompts['主持人'].find((p: string) => /【交叉審查】/.test(p)) || '';
  assert.match(reviewPrompt, /動到了任務開始前就存在的測試檔.*a\.test\.js/s, '審查者要被提醒去看那幾個測試檔');
  const fixPrompt = r.prompts['Alice'].find((p: string) => /【修復】/.test(p)) || '';
  assert.match(fixPrompt, /不可以修改任務開始前就存在的測試檔.*a\.test\.js/s);
  const audits = r.orc.messages.filter((m: any) => m.tag === 'tool-audit').flatMap((m: any) => m.toolAudit || []);
  const blocked = audits.find((a: any) => a.path === 'a.test.js' && !a.ok);
  assert.ok(blocked, '修復回合用工具改既有測試要被擋下');
  assert.match(blocked.error, /測試檔/);
  assert.strictEqual(r.card.testsTouched, true, '結果卡要標出動到既有測試');
});

test('新寫的測試不鎖:第一次就建立的測試檔可以自己再改', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', review: ['實作有問題', '好了'], canEdit: false },
    {
      id: 'alice', name: 'Alice', task: '寫 app.js 與測試',
      writes: { 'app.js': 'exports.add = (a, b) => a + b;\n', 'new.test.js': "require('assert').ok(true);\n" },
      fixViaTools: { 'new.test.js': "require('assert').ok(true); // 補一個案例\n" },
    },
  ]);
  const audits = r.orc.messages.filter((m: any) => m.tag === 'tool-audit').flatMap((m: any) => m.toolAudit || []);
  assert.ok(audits.some((a: any) => a.path === 'new.test.js' && a.ok), '這次任務新增的測試檔不該被鎖');
  assert.ok(!r.card.testsTouched, '沒有動到既有測試');
});

test('一般任務模式:不做自動驗證、不鎖測試(文件與分析用)', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', canEdit: false, workStyle: 'general' },
    {
      id: 'alice', name: 'Alice', task: '整理文件',
      before: { 'a.test.js': "require('assert').ok(true);\n" },
      writes: { 'a.test.js': "require('assert').ok(1);\n", 'notes.js': 'function broken( {\n' },
    },
  ]);
  assert.ok(!r.orc.messages.some((m: any) => m.tag === 'verify'), '一般任務不跑自動驗證');
  assert.ok(!r.orc.messages.some((m: any) => m.tag === 'test-lock'), '一般任務不鎖測試');
  assert.strictEqual(r.card.verify, undefined);
  assert.ok(!r.card.testsTouched);
  assert.strictEqual(r.outcome.Alice, 'approved', '語法錯誤的檔案在一般任務模式不影響結論');
});

test('測試先行流程:先寫測試,實作回合鎖住它們,並要求讓測試通過', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', canEdit: false, mode: 'tdd' },
    {
      id: 'alice', name: 'Alice', task: '實作 add',
      testWrites: { 'add.test.js': "require('assert').strictEqual(require('./add').add(1, 2), 3);\n" },
      writes: { 'add.js': 'exports.add = (a, b) => a + b;\n' },
    },
  ]);
  const phases = r.orc.messages.filter((m: any) => m.kind === 'agent' && m.phase).map((m: any) => m.phase.code);
  assert.ok(phases.indexOf('tests') >= 0 && phases.indexOf('tests') < phases.indexOf('execute'), `先寫測試再實作(${phases.join(',')})`);
  assert.ok(r.orc.messages.some((m: any) => m.tag === 'tests' && /add\.test\.js/.test(m.text)), '說出寫了哪些測試檔');
  const execPrompt = r.prompts['Alice'].find((p: string) => /【執行】/.test(p)) || '';
  assert.match(execPrompt, /測試已經鎖住,不能修改.*add\.test\.js/s);
  assert.match(execPrompt, /實作到這些測試通過/);
  const testPrompt = r.prompts['Alice'].find((p: string) => /【寫測試】/.test(p)) || '';
  assert.match(testPrompt, /只寫測試,不要實作/);
});

test('平行改到同一個檔案:不合併重疊,各自的其他改動仍寫回', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', canEdit: false },
    { id: 'alice', name: 'Alice', task: '改 shared.js', writes: { 'shared.js': 'a\n', 'only-a.txt': 'alice\n' }, api: true },
    { id: 'bob', name: 'Bob', task: '也改 shared.js', writes: { 'shared.js': 'b\n', 'only-b.txt': 'bob\n' }, api: true },
  ]);
  assert.strictEqual(r.read('shared.js'), null, '重疊檔案不該被後寫的蓋進工作目錄');
  assert.strictEqual(r.read('only-a.txt'), 'alice\n');
  assert.strictEqual(r.read('only-b.txt'), 'bob\n');
  assert.deepStrictEqual(r.retained.sort(), ['a\n', 'b\n'], '任務結束後衝突版本仍在');
  assert.deepStrictEqual(r.outcome, { Alice: 'unresolved', Bob: 'unresolved' });
  assert.ok(r.orc.messages.some((m: any) => m.tag === 'conflict' && /shared\.js/.test(m.text)), '要說出哪個檔案被同時改到');
  assert.ok(r.orc.messages.some((m: any) => /隔離目錄/.test(m.text)), '要說明使用了隔離目錄');
  const reviewPrompt = r.prompts['主持人'].concat(r.prompts['Alice'] || [], r.prompts['Bob'] || []).find((p: string) => /【交叉審查】/.test(p) && /被多位成員同時改到/.test(p));
  assert.ok(reviewPrompt, '審查者要被提醒');
});

test('審查用乾淨 context:看不到討論與執行過程,但看得到實際的檔案操作', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', canEdit: false },
    { id: 'alice', name: 'Alice', task: '寫 a.js', writes: { 'a.js': 'module.exports = 1;\n' }, api: true },
  ]);
  const reviewPrompt = r.prompts['主持人'].find((p: string) => /【交叉審查】/.test(p)) || '';
  assert.ok(!/\[Alice\]:/.test(reviewPrompt), `審查提示不該帶討論與執行的發言(${reviewPrompt.slice(0, 200)})`);
  assert.ok(!/同意直接進入分工|\[AGREED\]/.test(reviewPrompt), '不該帶討論階段的內容');
  // 拿掉紀錄之後,實際做過的檔案操作要改由提示詞直接附上,否則審查者連改了什麼都看不到
  assert.match(reviewPrompt, /實際做過的檔案操作/);
  assert.match(reviewPrompt, /write_file a\.js/);
  const review = r.turns.find((t: any) => t.phase === 'review')!;
  assert.strictEqual(review.sessionId, null, '審查回合不續接自己的 session');
});

test('多位 CLI 中途失敗,各自的實際隔離改動仍送審', async () => {
  const r = await run([
    { id: 'lead', name: 'Reviewer', canEdit: false },
    { id: 'alice', name: 'Alice', task: '寫 a.js', writes: { 'a.js': 'module.exports = 1;\n' }, execError: '中途失敗' },
    { id: 'bob', name: 'Bob', task: '寫 b.js', writes: { 'b.js': 'module.exports = 2;\n' }, execError: '中途失敗' },
  ]);
  assert.deepStrictEqual(r.reviews.map((message: any) => message.review.target).sort(), ['Alice', 'Bob']);
  assert.strictEqual(r.read('a.js'), 'module.exports = 1;\n');
  assert.strictEqual(r.read('b.js'), 'module.exports = 2;\n');
});

test('測試先行的隔離目錄包含剛寫出的測試檔', async () => {
  const expected = { 'new.test.js': 'require("assert").ok(true);\n' };
  const r = await run([
    { id: 'lead', name: 'Reviewer', canEdit: false, mode: 'tdd' },
    { id: 'alice', name: 'Alice', task: '寫 a.js', testWrites: expected, expectFiles: expected, writes: { 'a.js': 'module.exports = 1;\n' } },
    { id: 'bob', name: 'Bob', task: '寫 b.js', expectFiles: expected, writes: { 'b.js': 'module.exports = 2;\n' } },
  ]);
  assert.strictEqual(r.read('new.test.js'), expected['new.test.js']);
  assert.deepStrictEqual(r.outcome, { Alice: 'approved', Bob: 'approved' });
});

test('隔離超過複製上限時依序執行,不再平行寫原目錄', async () => {
  let active = 0;
  let maximum = 0;
  const barrier = async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
  };
  const r = await run([
    { id: 'lead', name: 'Reviewer', canEdit: false, before: { 'large.txt': 'x'.repeat(256 * 1024 + 1) } },
    { id: 'alice', name: 'Alice', task: '寫 a.js', writes: { 'a.js': 'module.exports = 1;\n' }, execBarrier: barrier },
    { id: 'bob', name: 'Bob', task: '寫 b.js', writes: { 'b.js': 'module.exports = 2;\n' }, execBarrier: barrier },
  ]);
  assert.strictEqual(maximum, 1);
  assert.ok(r.orc.messages.some((message: any) => /無法準備隔離目錄.*依序執行/.test(message.text)));
  assert.strictEqual(r.read('a.js'), 'module.exports = 1;\n');
  assert.strictEqual(r.read('b.js'), 'module.exports = 2;\n');
});

test('審查回合不覆寫成員原本的 session', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', canEdit: false },
    { id: 'alice', name: 'Alice', task: '寫 a.js', writes: { 'a.js': 'module.exports = 1;\n' } },
  ]);
  // 主持人審查後又做總結:總結那回合不能拿到審查回合開出來的 session
  const summaryTurn = r.prompts['主持人'].findIndex((p: string) => /【總結】/.test(p));
  assert.ok(summaryTurn >= 0);
  const lead = r.turns.filter((t: any) => t.who === '主持人');
  assert.ok(lead.every((t: any) => t.sessionId !== 'review-session-lead'), `審查開的 session 不該被沿用(${JSON.stringify(lead)})`);
});

test('測試先行:實作回合真的鎖住剛寫好的測試檔', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', canEdit: false, mode: 'tdd' },
    {
      id: 'alice', name: 'Alice', task: '實作 add',
      testWrites: { 'add.test.js': "require('assert').ok(true);\n" },
      writes: { 'add.js': 'exports.add = (a, b) => a + b;\n' },
    },
  ]);
  const exec = r.turns.find((t: any) => t.phase === 'execute')!;
  assert.deepStrictEqual(exec.lockedPaths, ['add.test.js'], '實作回合要把測試檔傳進工具層鎖起來');
});

test('多 AI 把關:依計畫順序一棒接一棒,後一棒看得到前一棒的檔案與交接', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', canEdit: false, mode: 'guarded' },
    { id: 'alice', name: 'Alice', api: true, task: '寫規格 spec.txt', writes: { 'spec.txt': 'add(a,b)\n' } },
    { id: 'bob', name: 'Bob', api: true, task: '照規格實作 add.js', expectFiles: { 'spec.txt': 'add(a,b)\n' }, writes: { 'add.js': 'exports.add = (a, b) => a + b;\n' } },
  ]);
  assert.deepStrictEqual(r.turns.filter((t) => t.phase === 'execute').map((t) => t.who), ['Alice', 'Bob']);
  assert.match(r.prompts['Bob'].find((p: string) => /【執行】/.test(p)) || '', /第 1 棒:Alice[\s\S]*寫規格 spec\.txt/);
  assert.ok(r.prompts['主持人'].some((p: string) => /【分工】/.test(p) && /接力/.test(p)), '分工時告訴主持人會依序執行');
  assert.ok(!r.orc.messages.some((m: any) => /隔離目錄/.test(m.text)), '依序執行不開隔離目錄');
  assert.strictEqual(r.card.guard.status, 'passed');
});

test('接力:照順序在同一個目錄一棒接一棒,後一棒看得到前一棒的檔案與交接', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', canEdit: false, mode: 'relay' },
    { id: 'alice', name: 'Alice', api: true, task: '寫規格 spec.txt', writes: { 'spec.txt': 'add(a,b)\n' } },
    { id: 'bob', name: 'Bob', api: true, task: '照規格實作 add.js', expectFiles: { 'spec.txt': 'add(a,b)\n' }, writes: { 'add.js': 'exports.add = (a, b) => a + b;\n' } },
  ]);
  assert.deepStrictEqual(r.turns.filter((t) => t.phase === 'execute').map((t) => t.who), ['Alice', 'Bob']);
  const bobPrompt = r.prompts['Bob'].find((p: string) => /【執行】/.test(p)) || '';
  assert.match(bobPrompt, /接力的第 2\/2 棒/);
  assert.match(bobPrompt, /第 1 棒:Alice[\s\S]*寫規格 spec\.txt[\s\S]*完成/, '交接要帶前一棒的工作與回報');
  assert.doesNotMatch(r.prompts['Alice'].find((p: string) => /【執行】/.test(p)) || '', /前面各棒的交接/);
  assert.ok(!r.orc.messages.some((m: any) => /隔離目錄/.test(m.text)), '接力不開隔離目錄');
  assert.strictEqual(r.read('spec.txt'), 'add(a,b)\n');
  assert.strictEqual(r.read('add.js'), 'exports.add = (a, b) => a + b;\n');
  assert.deepStrictEqual(r.outcome, { Alice: 'approved', Bob: 'approved' });
  assert.ok(r.orc.messages.some((m: any) => m.tag === 'plan' && /1\. \*\*Alice\*\*[\s\S]*2\. \*\*Bob\*\*/.test(m.text)), '分工卡照棒次編號');
});

test('接力:某一棒失敗就停,後面的不在壞掉的基礎上繼續', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', canEdit: false, mode: 'relay' },
    { id: 'alice', name: 'Alice', task: '寫規格', execError: 'CLI 沒有安裝' },
    { id: 'bob', name: 'Bob', task: '照規格實作' },
  ]);
  assert.deepStrictEqual(r.turns.filter((t) => t.phase === 'execute').map((t) => t.who), ['Alice']);
  assert.ok(r.orc.messages.some((m: any) => m.level === 'warn' && /接力停在 Alice[\s\S]*2\. \*\*Bob\*\*/.test(m.text)));
  assert.deepStrictEqual(r.outcome, { Alice: 'failed', Bob: 'failed' });
  assert.match(r.summaryPrompt, /此工作尚未執行:照規格實作/);
});

test('接力修改同一檔案不是平行衝突,CLI 中途失敗的改動仍送審', async () => {
  const r = await run([
    { id: 'lead', name: '主持人', canEdit: false, mode: 'relay' },
    { id: 'alice', name: 'Alice', task: '建立規格', writes: { 'spec.txt': 'first\n' } },
    { id: 'bob', name: 'Bob', task: '修改規格', expectFiles: { 'spec.txt': 'first\n' }, writes: { 'spec.txt': 'second\n' }, execError: 'interrupted after writing' },
  ]);
  assert.strictEqual(r.read('spec.txt'), 'second\n');
  assert.ok(r.reviews.some((message: any) => message.review.target === 'Bob'));
  assert.ok(!r.orc.messages.some((message: any) => message.tag === 'conflict'));
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} review loop tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
