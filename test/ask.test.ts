// [ASK] 選項式提問的流程測試。
// 走真正的 turn() / discussPhase,只把轉接器換成假的,所以 stripAsk 的顯示剝除、
// 節流、first-answer-wins、stop 解鎖都是在正式程式碼路徑上驗證的。

const assert = require('assert');
const os = require('os');
const O = require('../src/orchestrator');
const adapters = require('../src/adapters');

const ASK = (question: string, ...options: string[]) =>
  ['[ASK]', question, ...options.map((o: string) => `- ${o}`), '[/ASK]'].join('\n');

// names:成員名稱;scripts:名稱 -> 依序要回傳的文字(用完之後回傳預設句子)
function fakeOrc(names: string[], scripts: Record<string, string[]> = {}, settingsPatch: any = {}) {
  const agents = names.map((name, i) => ({ id: `a${i}`, name, cli: 'fake', enabled: true, canEdit: false }));
  const queues: Record<string, string[]> = {};
  for (const name of names) queues[name] = [...(scripts[name] || [])];
  const calls: any[] = [];
  adapters.setRegistry({
    get: () => ({
      id: 'fake', supportsResume: false, supportsEdit: false,
      run: async (agent: any, ctx: any) => {
        calls.push({ name: agent.name, prompt: ctx.prompt, systemPrompt: ctx.systemPrompt, sessionId: ctx.sessionId });
        await new Promise((r: any) => setTimeout(r, 1));
        const next = queues[agent.name].shift();
        return { text: next != null ? next : `${agent.name} 沒有其他意見` };
      },
    }),
  });
  const settings = {
    maxTranscriptChars: 0, language: '繁體中文', workDir: os.tmpdir(),
    maxRounds: 1, mode: 'discuss', uiLocale: 'zh-Hant', ...settingsPatch,
  };
  const orc = new O.Orchestrator({ get: () => ({ agents, settings }), userDataDir: os.tmpdir() });
  const states: any[] = [];
  orc.on('state', (s: any) => states.push(s));
  const idle = () => new Promise((resolve: any) => {
    const check = (s: any) => { if (!s.running && s.phase && s.phase.code === 'idle') { orc.off('state', check); resolve(); } };
    orc.on('state', check);
  });
  return { orc, agents, calls, settings, states, idle };
}

// 輪詢等待條件成立;逾時就讓斷言自己失敗,不要讓測試永遠掛著
async function waitFor(fn: () => any, label: string, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r: any) => setTimeout(r, 2));
  }
  throw new Error(`等待逾時:${label}`);
}

const agentTexts = (orc: any) => orc.messages.filter((m: any) => m.kind === 'agent').map((m: any) => m.text);
const userTexts = (orc: any) => orc.messages.filter((m: any) => m.kind === 'user').map((m: any) => m.text);

(async () => {
  let n = 0;
  const at = async (name: string, fn: () => Promise<void>) => { await fn(); n++; console.log('ok -', name); };

  // ---------- 基本流程 ----------

  await at('獨立首輪不看彼此答案、不續接 session,公開後才互評', async () => {
    const { orc, agents, calls } = fakeOrc(['甲', '乙'], {
      甲: ['alpha-private\n[AGREED]', '[AGREED]'],
      乙: ['beta-private\n[AGREED]', '[AGREED]'],
    }, { discussionMode: 'independent-first', maxRounds: 1 });
    orc.sessions = { a0: 'old-alpha', a1: 'old-beta' };
    orc.lastSeen = { a0: 0, a1: 0 };
    await orc.discussPhase(agents, 'shared-task');
    assert.strictEqual(calls.length, 4);
    for (const call of calls.slice(0, 2)) {
      assert.ok(call.prompt.includes('shared-task'));
      assert.ok(!call.prompt.includes('alpha-private') && !call.prompt.includes('beta-private'));
      assert.strictEqual(call.sessionId, null);
    }
    for (const call of calls.slice(2)) {
      assert.ok(call.prompt.includes('alpha-private') && call.prompt.includes('beta-private'));
    }
  });

  await at('獨立首輪的附件不標成正式 session 已讀,第二輪仍收到完整內容', async () => {
    const fs = require('fs');
    const path = require('path');
    const { addAttachments } = require('../src/attachments');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-independent-attachments-'));
    try {
      for (const previousSession of [null, 'previous-task-session']) {
        const agent = { id: 'member', name: 'Member', cli: 'fake', enabled: true, canEdit: false };
        const calls: any[] = [];
        adapters.setRegistry({ get: () => ({
          id: 'fake', supportsResume: true, capabilities: { attachments: ['textInline'] },
          run: async (_agent: any, ctx: any) => {
            calls.push({ sessionId: ctx.sessionId, attachments: ctx.attachments, prompt: ctx.prompt });
            return { text: 'Generic response', sessionId: ctx.sessionId || `session-${calls.length}` };
          },
        }) });
        const settings = { workDir: root, discussionMode: 'independent-first', maxRounds: 3, maxTranscriptChars: 0 };
        const orc = new O.Orchestrator({ userDataDir: root, get: () => ({ agents: [agent], settings }) });
        if (previousSession) orc.sessions[agent.id] = previousSession;
        orc.attachments = addAttachments(root, orc.conversationId, [{ name: 'requirements.txt', data: Buffer.from('UNIQUE_ATTACHMENT_REQUIREMENT') }]).added;
        await orc.discussPhase([agent], 'Use the attachment');
        assert.deepStrictEqual(calls.map((call) => call.attachments.length), [1, 1, 0]);
        assert.deepStrictEqual(calls.map((call) => call.prompt.includes('UNIQUE_ATTACHMENT_REQUIREMENT')), [true, true, false]);
        assert.deepStrictEqual(calls.map((call) => call.sessionId), [null, previousSession, previousSession || 'session-2']);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await at('獨立首輪全部完成後才受理提問', async () => {
    const { orc, agents, calls } = fakeOrc(['甲', '乙'], {
      甲: [ASK('which?', 'shared-answer')],
      乙: ['beta-private'],
    }, { discussionMode: 'independent-first', maxRounds: 2 });
    const done = orc.discussPhase(agents, 'task');
    await waitFor(() => orc.pendingQuestion, '首輪後提問');
    assert.strictEqual(calls.length, 2);
    assert.ok(!calls[1].prompt.includes('which?'));
    orc.answerQuestion({ id: orc.pendingQuestion.id, optionIds: ['a'], decision: 'answered' });
    await done;
    assert.ok(calls[2].prompt.includes('shared-answer'));
    assert.ok(calls[3].prompt.includes('shared-answer'));
  });

  await at('討論階段提問會暫停流程,回答後寫進對話紀錄並繼續', async () => {
    const { orc, calls, states, idle } = fakeOrc(['甲', '乙'], {
      甲: ['先確認一件事\n' + ASK('要先支援哪一種端點?', 'Ollama', 'LM Studio')],
    });
    const done = idle();
    void orc.userMessage('接本地模型', 'discuss');

    await waitFor(() => orc.pendingQuestion, '提問出現');
    const q = orc.pendingQuestion;
    assert.strictEqual(q.agentName, '甲');
    assert.strictEqual(q.question, '要先支援哪一種端點?');
    assert.deepStrictEqual(q.options.map((o: any) => [o.id, o.label]), [['a', 'Ollama'], ['b', 'LM Studio']]);
    assert.strictEqual(q.allowFree, true);
    assert.ok(q.expiresAt > Date.now(), 'expiresAt 必須是未來時間');
    assert.strictEqual(orc.phase.code, 'ask');

    const withQuestion = states.filter((s: any) => s.question);
    assert.strictEqual(withQuestion.length, 1, '進入等待只送一次帶問題的 state');
    assert.strictEqual(withQuestion[0].question.id, q.id);

    // 等待期間第二位成員不能被叫上場
    assert.deepStrictEqual(calls.map((c: any) => c.name), ['甲']);

    orc.answerQuestion({ id: q.id, optionIds: ['b'], decision: 'answered' });
    await done;

    assert.strictEqual(orc.pendingQuestion, null, '結算後不能留著待答狀態');
    const cleared = states.filter((s: any) => Object.prototype.hasOwnProperty.call(s, 'question') && s.question === null);
    assert.strictEqual(cleared.length, 1, '結算要送一次 question: null 讓卡片收起來');

    const answer = userTexts(orc).find((t: string) => t.includes('LM Studio'));
    assert.ok(answer, `回答必須進對話紀錄,實際:${JSON.stringify(userTexts(orc))}`);
    assert.ok(answer.includes('甲'), '回答要標明是回覆誰的提問');
    // 後面的成員看得到這個回答,才不會重複問同一件事
    const later = calls.find((c: any) => c.name === '乙');
    assert.ok(later && later.prompt.includes('LM Studio'), '回答必須帶進下一位成員的提示詞');
  });

  await at('提問期間 phase 為 ask,結算後回到原本的討論回合', async () => {
    const { orc, states, idle } = fakeOrc(['甲'], { 甲: [ASK('要繼續嗎?', '好', '不要')] }, { maxRounds: 2 });
    const done = idle();
    void orc.userMessage('任務', 'discuss');
    await waitFor(() => orc.pendingQuestion, '提問出現');
    assert.deepStrictEqual(orc.phase, { code: 'ask', names: ['甲'] });
    orc.answerQuestion({ id: orc.pendingQuestion.id, optionIds: ['a'], decision: 'answered' });
    await done;
    const codes = states.map((s: any) => s.phase && s.phase.code);
    assert.ok(codes.indexOf('ask') < codes.lastIndexOf('discuss'), '結算後要回到討論階段,不能停在 ask');
  });

  await at('自由輸入的回答會原樣帶進對話紀錄', async () => {
    const { orc, idle } = fakeOrc(['甲'], { 甲: [ASK('用哪個模型?', 'A', 'B')] });
    const done = idle();
    void orc.userMessage('任務', 'discuss');
    await waitFor(() => orc.pendingQuestion, '提問出現');
    orc.answerQuestion({ id: orc.pendingQuestion.id, text: '用 qwen3:8b', decision: 'answered' });
    await done;
    assert.ok(userTexts(orc).some((t: string) => t.includes('用 qwen3:8b')));
  });

  // ---------- id 驗證與 first-answer-wins ----------

  await at('id 不符的回答被忽略,流程仍停在等待', async () => {
    const { orc, idle } = fakeOrc(['甲', '乙'], { 甲: [ASK('要問的事', 'A', 'B')] });
    const done = idle();
    void orc.userMessage('任務', 'discuss');
    await waitFor(() => orc.pendingQuestion, '提問出現');
    const q = orc.pendingQuestion;
    orc.answerQuestion({ id: 'not-the-same-id', optionIds: ['a'], decision: 'answered' });
    await new Promise((r: any) => setTimeout(r, 20));
    assert.ok(orc.pendingQuestion === q, '過期卡片的回答不能結算目前的問題');
    orc.answerQuestion({ id: q.id, optionIds: ['a'], decision: 'answered' });
    await done;
  });

  await at('first-answer-wins:第二次回答不再產生任何效果', async () => {
    const { orc, idle } = fakeOrc(['甲'], { 甲: [ASK('要問的事', '先做 A', '先做 B')] });
    const done = idle();
    void orc.userMessage('任務', 'discuss');
    await waitFor(() => orc.pendingQuestion, '提問出現');
    const id = orc.pendingQuestion.id;
    orc.answerQuestion({ id, optionIds: ['a'], decision: 'answered' });
    orc.answerQuestion({ id, optionIds: ['b'], decision: 'answered' });
    await done;
    const answers = userTexts(orc).filter((t: string) => t.includes('先做'));
    assert.strictEqual(answers.length, 1, '只能寫進一則回答');
    assert.ok(answers[0].includes('先做 A') && !answers[0].includes('先做 B'));
  });

  await at('結算過後再呼叫 settleQuestion 回傳 false,不重複清狀態', async () => {
    const { orc, idle } = fakeOrc(['甲'], { 甲: [ASK('要問的事', 'A')] });
    const done = idle();
    void orc.userMessage('任務', 'discuss');
    await waitFor(() => orc.pendingQuestion, '提問出現');
    const id = orc.pendingQuestion.id;
    assert.strictEqual(orc.settleQuestion({ id, decision: 'defer' }), true);
    assert.strictEqual(orc.settleQuestion({ id, decision: 'defer' }), false);
    await done;
  });

  // ---------- 回答內容的正規化 ----------

  await at('宣稱已回答但選項與文字都空,視為 defer', async () => {
    const { orc, idle } = fakeOrc(['甲'], { 甲: [ASK('要問的事', 'A', 'B')] });
    const done = idle();
    void orc.userMessage('任務', 'discuss');
    await waitFor(() => orc.pendingQuestion, '提問出現');
    orc.answerQuestion({ id: orc.pendingQuestion.id, optionIds: [], text: '   ', decision: 'answered' });
    await done;
    assert.ok(userTexts(orc).some((t: string) => t.includes('自行決定')), '空回答要退回成「你決定」');
  });

  await at('不存在的 optionId 會被過濾掉', async () => {
    const { orc, idle } = fakeOrc(['甲'], { 甲: [ASK('要問的事', '選項一', '選項二')] });
    const done = idle();
    void orc.userMessage('任務', 'discuss');
    await waitFor(() => orc.pendingQuestion, '提問出現');
    orc.answerQuestion({ id: orc.pendingQuestion.id, optionIds: ['z', 'b'], decision: 'answered' });
    await done;
    const answer = userTexts(orc).find((t: string) => t.includes('選項二'));
    assert.ok(answer, '合法選項要保留');
    assert.ok(!answer.includes('選項一'));
  });

  await at('decision 為 defer 時寫入「由你們決定」而不是空白', async () => {
    const { orc, idle } = fakeOrc(['甲'], { 甲: [ASK('要問的事', 'A')] });
    const done = idle();
    void orc.userMessage('任務', 'discuss');
    await waitFor(() => orc.pendingQuestion, '提問出現');
    orc.answerQuestion({ id: orc.pendingQuestion.id, decision: 'defer' });
    await done;
    assert.ok(userTexts(orc).some((t: string) => t.includes('甲') && t.includes('自行決定')));
  });

  // ---------- stop:最高風險項 ----------

  await at('等待回答中按停止不會卡死,且不留下待答狀態', async () => {
    const { orc, idle } = fakeOrc(['甲', '乙'], { 甲: [ASK('要問的事', 'A', 'B')] });
    const done = idle();
    void orc.userMessage('任務', 'discuss');
    await waitFor(() => orc.pendingQuestion, '提問出現');
    orc.stop();
    // 沒有解開 await 的話這裡會等到逾時失敗
    await Promise.race([done, new Promise((_r: any, reject: any) => setTimeout(() => reject(new Error('stop 後流程沒有結束,await 被卡住')), 3000))]);
    assert.strictEqual(orc.pendingQuestion, null);
    assert.strictEqual(orc.askResolve, null);
    assert.strictEqual(orc.running, false);
    assert.ok(!userTexts(orc).some((t: string) => t.includes('自行決定')), '停止時不該再補一則回答訊息');
  });

  await at('reset 會清掉待答問題與提問次數', async () => {
    const { orc, idle } = fakeOrc(['甲'], { 甲: [ASK('要問的事', 'A')] });
    const done = idle();
    void orc.userMessage('任務', 'discuss');
    await waitFor(() => orc.pendingQuestion, '提問出現');
    orc.reset();
    await done;
    assert.strictEqual(orc.pendingQuestion, null);
    assert.strictEqual(orc.askCount, 0);
    assert.deepStrictEqual(orc.askLastRound, {});
  });

  // ---------- 節流 ----------

  await at('同一回合只受理一題,第二位成員的提問被略過', async () => {
    const { orc, idle } = fakeOrc(['甲', '乙'], {
      甲: [ASK('甲的問題', 'A')],
      乙: [ASK('乙的問題', 'A')],
    });
    const done = idle();
    void orc.userMessage('任務', 'discuss');
    await waitFor(() => orc.pendingQuestion, '甲的提問出現');
    assert.strictEqual(orc.pendingQuestion.agentName, '甲');
    orc.answerQuestion({ id: orc.pendingQuestion.id, optionIds: ['a'], decision: 'answered' });
    await done;
    assert.strictEqual(orc.askCount, 1, '同一回合第二題不能受理');
    assert.ok(!agentTexts(orc).some((t: string) => t.includes('乙的問題')), '被節流的問題也要從訊息本體剝掉');
  });

  await at('同一成員不得連續兩個回合提問', async () => {
    const { orc, idle } = fakeOrc(['甲'], {
      甲: [ASK('第一題', 'A'), ASK('第二題', 'A'), ASK('第三題', 'A')],
    }, { maxRounds: 3 });
    const done = idle();
    void orc.userMessage('任務', 'discuss');
    await waitFor(() => orc.pendingQuestion, '第一題出現');
    assert.strictEqual(orc.pendingQuestion.question, '第一題');
    orc.answerQuestion({ id: orc.pendingQuestion.id, optionIds: ['a'], decision: 'answered' });
    // 第 2 回合必須被擋(連續),第 3 回合才能再問
    await waitFor(() => orc.pendingQuestion, '第三題出現');
    assert.strictEqual(orc.pendingQuestion.question, '第三題', '第 2 回合的提問應該被節流');
    orc.answerQuestion({ id: orc.pendingQuestion.id, optionIds: ['a'], decision: 'answered' });
    await done;
    assert.strictEqual(orc.askCount, 2);
  });

  await at('整個對話最多三題,超過就不再打斷使用者', async () => {
    const { orc, idle } = fakeOrc(['甲', '乙'], {
      甲: [ASK('甲一', 'A'), ASK('甲二', 'A'), ASK('甲三', 'A'), ASK('甲四', 'A'), ASK('甲五', 'A')],
      乙: [ASK('乙一', 'A'), ASK('乙二', 'A'), ASK('乙三', 'A'), ASK('乙四', 'A'), ASK('乙五', 'A')],
    }, { maxRounds: 8 });
    const done = idle();
    void orc.userMessage('任務', 'discuss');
    for (let i = 0; i < 3; i++) {
      await waitFor(() => orc.pendingQuestion, `第 ${i + 1} 題出現`);
      orc.answerQuestion({ id: orc.pendingQuestion.id, optionIds: ['a'], decision: 'answered' });
    }
    await done;
    assert.strictEqual(orc.askCount, 3, '上限就是 3,之後的提問一律不暫停');
    assert.strictEqual(orc.pendingQuestion, null);
  });

  await at('被節流的問題不計入三題額度', async () => {
    // 只有甲會提問,乙每回合都提問但一定被同回合規則擋掉
    const { orc, idle } = fakeOrc(['甲', '乙'], {
      甲: [ASK('甲一', 'A'), '甲沒問題', ASK('甲二', 'A')],
      乙: [ASK('乙一', 'A'), ASK('乙二', 'A'), ASK('乙三', 'A')],
    }, { maxRounds: 3 });
    const done = idle();
    void orc.userMessage('任務', 'discuss');
    await waitFor(() => orc.pendingQuestion, '甲一出現');
    assert.strictEqual(orc.pendingQuestion.question, '甲一');
    orc.answerQuestion({ id: orc.pendingQuestion.id, optionIds: ['a'], decision: 'answered' });
    // 第 2 回合:甲沒問題,乙可以問(不同成員、不同回合)
    await waitFor(() => orc.pendingQuestion, '乙二出現');
    assert.strictEqual(orc.pendingQuestion.question, '乙二');
    orc.answerQuestion({ id: orc.pendingQuestion.id, optionIds: ['a'], decision: 'answered' });
    await waitFor(() => orc.pendingQuestion, '甲二出現');
    assert.strictEqual(orc.pendingQuestion.question, '甲二', '被節流的乙一不該吃掉額度');
    orc.answerQuestion({ id: orc.pendingQuestion.id, optionIds: ['a'], decision: 'answered' });
    await done;
    assert.strictEqual(orc.askCount, 3);
  });

  await at('canAsk:等待中不能再開第二個問題', async () => {
    const { orc } = fakeOrc(['甲']);
    orc.askResolve = () => {};
    assert.strictEqual(orc.canAsk(orc.agents[0], 1), false);
    orc.askResolve = null;
    assert.strictEqual(orc.canAsk(orc.agents[0], 1), true);
    orc.stopped = true;
    assert.strictEqual(orc.canAsk(orc.agents[0], 1), false, '已停止就不該再提問');
  });

  // ---------- 顯示與階段限制 ----------

  await at('[ASK] 區塊不會留在訊息本體,其餘內容保留', async () => {
    const { orc, idle } = fakeOrc(['甲'], {
      甲: ['我的看法是先做 A。\n' + ASK('要問的事', '選一', '選二') + '\n以上。'],
    });
    const done = idle();
    void orc.userMessage('任務', 'discuss');
    await waitFor(() => orc.pendingQuestion, '提問出現');
    orc.answerQuestion({ id: orc.pendingQuestion.id, optionIds: ['a'], decision: 'answered' });
    await done;
    const first = agentTexts(orc)[0];
    assert.ok(first.includes('我的看法是先做 A。'), '正文要保留');
    assert.ok(first.includes('以上。'), '區塊後面的內容也要保留');
    assert.ok(!first.includes('[ASK]') && !first.includes('[/ASK]'), '不能留下標記');
    assert.ok(!first.includes('要問的事'), '問題由卡片呈現,不能在氣泡裡再出現一次');
  });

  await at('@ 指定等平行階段的 [ASK] 不會觸發提問,只會被剝掉', async () => {
    const { orc, idle } = fakeOrc(['甲', '乙'], { 乙: [ASK('平行階段的問題', 'A')] });
    const done = idle();
    void orc.userMessage('@乙 看一下', 'discuss');
    await done;
    assert.strictEqual(orc.pendingQuestion, null);
    assert.strictEqual(orc.askCount, 0);
    const reply = agentTexts(orc)[0];
    assert.ok(!reply.includes('[ASK]'), '不能受理就不該留下標記');
  });

  await at('提問的成員該回合不算同意,不會直接結束討論', async () => {
    const { orc, idle } = fakeOrc(['甲'], {
      甲: ['我同意。\n' + ASK('但有一件事', 'A', 'B') + '\n[AGREED]', '沒有其他意見\n[AGREED]'],
    }, { maxRounds: 2 });
    const done = idle();
    void orc.userMessage('任務', 'discuss');
    await waitFor(() => orc.pendingQuestion, '提問出現');
    orc.answerQuestion({ id: orc.pendingQuestion.id, optionIds: ['a'], decision: 'answered' });
    await done;
    const agreedAt = orc.messages.filter((m: any) => m.kind === 'system' && /共識/.test(m.text));
    assert.strictEqual(agreedAt.length, 1);
    assert.ok(/第 2 回合/.test(agreedAt[0].text), `提問的那一回合不該達成共識,實際:${agreedAt[0].text}`);
  });

  await at('等待回答時 snapshot 帶著問題,介面重載才補得回卡片', async () => {
    const { orc, idle } = fakeOrc(['甲'], { 甲: [ASK('重載後還問得到嗎?', 'A', 'B')] });
    const done = idle();
    void orc.userMessage('任務', 'discuss');
    await waitFor(() => orc.pendingQuestion, '提問出現');
    const snap = orc.snapshot();
    assert.ok(snap.question, 'snapshot 必須帶待答問題,否則 renderer 重載後流程還在等、使用者卻無法回答');
    assert.strictEqual(snap.question.id, orc.pendingQuestion.id);
    assert.deepStrictEqual(snap.question.options.map((o: any) => o.label), ['A', 'B']);
    orc.answerQuestion({ id: snap.question.id, optionIds: ['a'], decision: 'answered' });
    await done;
    assert.strictEqual(orc.snapshot().question, null, '結算後 snapshot 要回報沒有待答問題');
  });

  await at('不能提問的階段寫出的 [ASK] 不會流進後續階段的提示詞', async () => {
    const plan = '{"summary":"各做一件事","assignments":[{"agent":"A1","task":"做甲的事"},{"agent":"A2","task":"做乙的事"}]}';
    const { orc, calls, idle } = fakeOrc(['甲', '乙'], {
      甲: ['同意\n[AGREED]', plan, '甲做完了\n' + ASK('執行階段的問題', 'A', 'B'), '審查意見\n[NO_ISSUES]'],
      乙: ['同意\n[AGREED]', '乙做完了\n' + ASK('乙的執行問題', 'A'), '審查意見\n[NO_ISSUES]'],
    }, { mode: 'divide' });
    const done = idle();
    void orc.userMessage('分工做事', 'divide');
    await done;
    assert.strictEqual(orc.pendingQuestion, null);
    assert.strictEqual(orc.askCount, 0, '執行階段不得觸發提問');
    const leaked = calls.filter((c: any) => c.prompt.includes('[ASK]') || c.prompt.includes('執行階段的問題'));
    assert.strictEqual(leaked.length, 0, `後續階段的提示詞不該帶入 [ASK] 原文,實際外洩 ${leaked.length} 次`);
    assert.ok(!agentTexts(orc).some((t: string) => t.includes('[ASK]')), '訊息本體也不該留下標記');
  });

  await at('討論階段的系統提示詞會說明提問用法,平行階段不會', async () => {
    const { orc, calls, idle } = fakeOrc(['甲'], {});
    const done = idle();
    void orc.userMessage('任務', 'discuss');
    await done;
    const discuss = calls.find((c: any) => c.systemPrompt.includes('[AGREED]'));
    assert.ok(discuss && discuss.systemPrompt.includes('[ASK]'), '討論階段要告訴成員可以提問');
    const summary = calls.find((c: any) => !c.systemPrompt.includes('[AGREED]'));
    assert.ok(summary && !summary.systemPrompt.includes('[ASK]'), '不能提問的階段不該提到這個機制');
  });

  console.log(`${n} 項 [ASK] 流程測試全部通過`);
})().catch((error: any) => {
  console.error(error);
  process.exitCode = 1;
});
