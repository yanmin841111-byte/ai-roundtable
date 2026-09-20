'use strict';

// 審查訊息帶著「審查者看了什麼、結論是什麼」,介面據此顯示結論徽章與依據。
//
// 結論必須和流程是同一個判斷:介面說「審查通過」,流程卻進了修復回合(或反過來),
// 比不顯示還糟。這裡走真正的 divide 流程,同時檢查訊息上的結論與流程實際的走向。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const O = require('../src/orchestrator');
const adapters = require('../src/adapters');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

// review:這位成員當審查者時的回覆;reviewError:當審查者時出錯
type Member = { id: string; name: string; task: string; writes?: Record<string, string>; report?: string; review?: string; reviewError?: string };
async function run(team: Member[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-verdict-'));
  const plan = { summary: 's', assignments: team.map((m, i) => ({ agent: `A${i + 1}`, task: m.task })) };
  let orc: any = null;
  // 審查進行中,那則訊息就要帶著依據:使用者在等的時候就該看到它在審誰、看哪些檔案
  const whileRunning: boolean[] = [];
  adapters.setRegistry({ get: (id: string) => {
    const m = team.find((x) => x.id === id);
    if (!m) return null;
    // CLI 型(沒有工具紀錄)、當審查者時只看附上的內容
    return { id, supportsEdit: true, supportsResume: false, capabilities: { attachments: ['textInline'] },
      run: async (_a: any, ctx: any) => {
        if (/【分工】/.test(ctx.prompt)) return { text: JSON.stringify(plan) };
        if (/【執行】/.test(ctx.prompt)) { for (const [f, c] of Object.entries(m.writes || {})) fs.writeFileSync(path.join(dir, f), c); return { text: m.report || '完成' }; }
        if (/【交叉審查】/.test(ctx.prompt)) {
          const live = orc.messages.find((x: any) => x.status === 'running' && x.agentName === m.name && x.phase && x.phase.code === 'review');
          whileRunning.push(!!(live && live.review && live.review.target && !live.review.verdict));
        }
        if (/【交叉審查】/.test(ctx.prompt)) return m.reviewError ? { text: '', error: m.reviewError } : { text: m.review || '[NO_ISSUES]' };
        if (/【總結】/.test(ctx.prompt)) return { text: '完成' };
        return { text: '[AGREED]' };
      } };
  } });
  const agents = team.map((m) => ({ id: m.id, name: m.name, cli: m.id, enabled: true, canEdit: true, color: '#000', persona: '', model: '', effort: '', customCommand: '' }));
  const settings = { maxTranscriptChars: 0, language: '繁體中文', workDir: dir, maxRounds: 1, mode: 'divide', uiLocale: 'zh-Hant', leadAgentId: team[0].id };
  orc = new O.Orchestrator({ get: () => ({ agents, settings }), userDataDir: os.tmpdir() });
  const done = new Promise<void>((r) => { const f = (st: any) => { if (!st.running && st.phase && st.phase.code === 'idle') { orc.off('state', f); r(); } }; orc.on('state', f); });
  await orc.userMessage('分工', 'divide');
  await done;
  fs.rmSync(dir, { recursive: true, force: true });
  const reviewOf = (name: string) => orc.messages.find((m: any) => m.review && m.review.target === name);
  const repairedBy = (name: string) => orc.messages.some((m: any) => m.kind === 'agent' && m.agentName === name && m.phase && m.phase.code === 'repair');
  const executeOf = (name: string) => orc.messages.find((m: any) => m.kind === 'agent' && m.agentName === name && m.phase && m.phase.code === 'execute');
  return { reviewOf, repairedBy, executeOf, whileRunning };
}

test('審查訊息帶著依據與結論,結論和流程的走向一致(通過 / 提出問題)', async () => {
  const r = await run([
    { id: 'alice', name: 'Alice', task: '寫 a.ts', writes: { 'a.ts': 'a\n' }, report: '完成 a.ts', review: 'b.ts 少了匯出,請補上' },
    { id: 'bob', name: 'Bob', task: '寫 b.ts', writes: { 'b.ts': 'b\n' }, report: '完成 b.ts', review: '看過了\n[NO_ISSUES]' },
  ]);
  // Bob 審 Alice:通過
  const ofAlice = r.reviewOf('Alice');
  assert.ok(ofAlice, 'Alice 的審查訊息要帶 review');
  assert.strictEqual(ofAlice.review.verdict, 'pass');
  assert.strictEqual(ofAlice.review.access, 'inline');
  assert.strictEqual(ofAlice.review.scope, 'listed');
  assert.strictEqual(ofAlice.review.files[0], 'a.ts', '回報提到的檔案排第一');
  assert.ok(!r.repairedBy('Alice'), '通過的就不進修復回合');
  // Alice 審 Bob:提出問題 → Bob 進修復回合
  const ofBob = r.reviewOf('Bob');
  assert.strictEqual(ofBob.review.verdict, 'issues');
  assert.ok(r.repairedBy('Bob'), '徽章說提出問題,流程就要真的進修復回合');
  // 第三則是修復後的複查(Alice 再看一次 Bob)
  assert.deepStrictEqual(r.whileRunning, [true, true, true], '審查進行中就要帶著依據(結論等回合結束才有)');
});

test('審查失敗:結論是 failed,被審者標成尚未審查', async () => {
  const r = await run([
    { id: 'alice', name: 'Alice', task: '寫 a.ts', writes: { 'a.ts': 'a\n' }, reviewError: '逾時' },
    { id: 'bob', name: 'Bob', task: '寫 b.ts', writes: { 'b.ts': 'b\n' }, reviewError: '逾時' },
  ]);
  assert.strictEqual(r.reviewOf('Alice').review.verdict, 'failed');
  assert.strictEqual(r.executeOf('Alice').unreviewed, true, '審查失敗就不算審查過');
});

// 標記要單獨一行才算數。接在句尾的 [NO_ISSUES] 流程不認,徽章也不能說通過
test('[NO_ISSUES] 接在句尾不算通過,徽章與流程一致', async () => {
  const r = await run([
    { id: 'alice', name: 'Alice', task: '寫 a.ts', writes: { 'a.ts': 'a\n' }, review: '沒問題' },
    { id: 'bob', name: 'Bob', task: '寫 b.ts', writes: { 'b.ts': 'b\n' }, review: '看起來都正確,無遺漏。[NO_ISSUES]' },
  ]);
  assert.strictEqual(r.reviewOf('Alice').review.verdict, 'issues');
  assert.ok(r.repairedBy('Alice'));
});

// 讀不到的檔案(二進位、已刪除)以前被算成「附上了內容」:畫面說附上 3 個,審查者其實只看到 1 個
test('讀不到的檔案另外列出,不算成附上了內容', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-unread-'));
  adapters.setRegistry({ get: (id: string) => ({
    exec: { id: 'exec', supportsEdit: true, supportsResume: false, capabilities: { attachments: ['filePath'] }, run: async () => ({ text: '' }) },
    reviewer: { id: 'reviewer', supportsResume: false, type: 'openai', supportsEdit: false, capabilities: { attachments: ['textInline'] }, run: async () => ({ text: '[NO_ISSUES]' }) },
  } as any)[id] || null });
  fs.writeFileSync(path.join(dir, 'ok.js'), 'ok\n');
  fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00]));
  const agents = [
    { id: 'e', name: '執行者', cli: 'exec', enabled: true, canEdit: true, color: '#000', persona: '', model: '', effort: '', customCommand: '' },
    { id: 'r', name: '審查者', cli: 'reviewer', enabled: true, canEdit: false, color: '#111', persona: '', model: '', effort: '', customCommand: '' },
  ];
  const settings = { maxTranscriptChars: 0, language: '繁體中文', workDir: dir, maxRounds: 1, mode: 'divide', uiLocale: 'zh-Hant', leadAgentId: 'e' };
  const orc = new O.Orchestrator({ get: () => ({ agents, settings }), userDataDir: os.tmpdir() });
  await orc.reviewPhase(agents, [{ agent: agents[0], task: '寫 ok.js 與 logo.png', report: '完成', error: null, toolEvents: [] }], ['deleted.js', 'logo.png', 'ok.js']);
  const review = orc.messages.find((m: any) => m.review).review;
  assert.deepStrictEqual(review.unreadable.sort(), ['deleted.js', 'logo.png']);
  assert.deepStrictEqual(review.omitted, []);
  assert.strictEqual(review.files.length - review.omitted.length - review.unreadable.length, 1, '真正附上內容的只有 ok.js');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('載入紀錄時:形狀正確的保留,壞掉的整個丟掉', () => {
  const ok = O.restoreMessage({ id: 'm1', kind: 'agent', text: 'x', review: { target: 'Alice', access: 'tool', scope: 'listed', files: ['a.ts', 3, 'b.ts', 'c.ts'], more: 2, omitted: ['b.ts'], unreadable: ['c.ts'], verdict: 'pass' } });
  assert.deepStrictEqual(ok.review, { target: 'Alice', access: 'tool', scope: 'listed', files: ['a.ts', 'b.ts', 'c.ts'], more: 2, omitted: ['b.ts'], unreadable: ['c.ts'], verdict: 'pass' });
  // 被改壞的紀錄:沒附上 / 讀不到的必須是清單裡的檔案,空字串不算檔名,審查對象不能是空的
  const bent = O.restoreMessage({ id: 'm5', kind: 'agent', review: { target: 'A', access: 'inline', scope: 'listed', files: ['a.ts', ''], omitted: ['x', 'y', 'z'], unreadable: ['a.ts', 'q'] } });
  assert.deepStrictEqual(bent.review, { target: 'A', access: 'inline', scope: 'listed', files: ['a.ts'], more: 0, omitted: [], unreadable: ['a.ts'] });
  assert.strictEqual(O.restoreMessage({ id: 'm6', kind: 'agent', review: { target: '  ', access: 'open', scope: 'none' } }).review, undefined, '審查對象不能是空的');
  assert.strictEqual(O.restoreMessage({ id: 'm2', kind: 'agent', review: { target: 'A', access: 'magic', scope: 'listed' } }).review, undefined, '不認得的 access');
  assert.strictEqual(O.restoreMessage({ id: 'm3', kind: 'agent', review: 'pass' }).review, undefined);
  const noVerdict = O.restoreMessage({ id: 'm4', kind: 'agent', review: { target: 'A', access: 'open', scope: 'none', files: 'x', verdict: 'maybe' } });
  assert.deepStrictEqual(noVerdict.review, { target: 'A', access: 'open', scope: 'none', files: [], more: 0, omitted: [], unreadable: [] }, '壞掉的欄位補成安全值,不認得的結論不帶');
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} review visibility tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
