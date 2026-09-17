const assert = require('assert');
const O = require('../src/orchestrator');

let n = 0; const t = (name: any, fn: any) => { fn(); n++; console.log('ok -', name); };

const OMIT = '已省略中間';
const CLIP = '此則訊息過長';
const entry = (text: any, pinned: any = false) => ({ text, pinned: !!pinned });
const big = (tag: any, len: any) => tag + 'x'.repeat(Math.max(0, len - tag.length));

// ---------- truncateTranscript ----------

t('在上限內時完全不截斷,輸出等於直接 join', () => {
  const es = [entry('[使用者]:\n任務', true), entry('[A]:\n甲'), entry('[B]:\n乙')];
  const out = O.truncateTranscript(es, 60000);
  assert.strictEqual(out, es.map((e: any) => e.text).join('\n\n'));
  assert.ok(!out.includes(OMIT));
});

t('上限 <= 0 視為不限制', () => {
  const es = [entry(big('A', 5000)), entry(big('B', 5000))];
  assert.strictEqual(O.truncateTranscript(es, 0).length, 10002);
  assert.strictEqual(O.truncateTranscript(es, -1).length, 10002);
});

t('超過上限時保留任務起點與最新一則,中段被省略', () => {
  const es = [
    entry(big('[使用者]:任務', 500), true),
    entry(big('[A]:一', 3000)),
    entry(big('[B]:二', 3000)),
    entry(big('[C]:三', 3000)),
    entry(big('[D]:最新', 500)),
  ];
  const out = O.truncateTranscript(es, 2000);
  assert.ok(out.startsWith('[使用者]:任務'), '任務起點必須保留');
  assert.ok(out.includes('[D]:最新'), '最新一則必須保留');
  assert.ok(!out.includes('[A]:一'), '中段應被裁掉');
  assert.ok(out.includes(OMIT), '截斷提示必須出現,不可靜默裁切');
});

t('截斷提示帶出正確的省略則數', () => {
  const es = [
    entry(big('[使用者]:任務', 200), true),
    entry(big('[A]:一', 3000)),
    entry(big('[B]:二', 3000)),
    entry(big('[C]:最新', 200)),
  ];
  const out = O.truncateTranscript(es, 1500);
  assert.ok(out.includes('…(已省略中間 2 則訊息)…'), out.slice(0, 300));
});

t('截斷後的長度一定不超過上限', () => {
  for (const limit of [50, 200, 1000, 5000]) {
    const es = [entry(big('[使用者]:任務', 4000), true), entry(big('[A]:一', 4000)), entry(big('[B]:二', 4000))];
    const out = O.truncateTranscript(es, limit);
    assert.ok(out.length <= limit, `limit=${limit} 實際=${out.length}`);
  }
});

t('分工結果是釘選的,即使在中段也會保留', () => {
  const es = [
    entry(big('[使用者]:任務', 200), true),
    entry(big('[A]:一', 4000)),
    entry('[系統]:\n**分工結果**:A 做甲、B 做乙', true),
    entry(big('[B]:二', 4000)),
    entry(big('[C]:最新', 200)),
  ];
  const out = O.truncateTranscript(es, 2000);
  assert.ok(out.includes('**分工結果**'), '分工結果必須保留');
  assert.ok(out.includes('[使用者]:任務'));
  assert.ok(out.includes('[C]:最新'));
});

t('多個超長釘選項目會共用預算,最新一則不會被整體裁切擠掉(回歸)', () => {
  const es = [
    entry(big('[使用者]:任務', 40000), true),
    entry(big('[系統]:**分工結果**', 40000), true),
    entry(big('[D]:最新', 40000)),
  ];
  const out = O.truncateTranscript(es, 60000);
  assert.ok(out.length <= 60000, `實際 ${out.length}`);
  assert.ok(out.includes('[使用者]:任務'), '任務起點必須保留');
  assert.ok(out.includes('**分工結果**'), '分工結果必須保留');
  assert.ok(out.includes('[D]:最新'), '最新一則不能被整體裁切擠掉');
});

t('公平分配:短的釘選項目完整保留,長的才被裁', () => {
  const es = [
    entry('[使用者]:\n短任務', true),
    entry(big('[A]:長', 8000), true),
    entry(big('[B]:也很長', 8000)),
  ];
  const out = O.truncateTranscript(es, 4000);
  assert.ok(out.length <= 4000);
  assert.ok(out.includes('[使用者]:\n短任務'), '短項目應完整保留,不該被平均砍');
  assert.ok(out.includes('[A]:長') && out.includes('[B]:也很長'));
});

t('單則訊息本身超過預算時就地裁尾並標示', () => {
  const es = [entry(big('[使用者]:任務', 20), true), entry(big('[A]:一', 9000))];
  const out = O.truncateTranscript(es, 1000);
  assert.ok(out.includes(CLIP), '過長的單則必須標示已截斷');
  assert.ok(out.length <= 1000);
});

// ---------- pickReviewPairs ----------

const ag = (id: any, name: any = id) => ({ id, name });
const rep = (agent: any) => ({ agent, task: 't', report: 'r' });

t('沒有任何成果時不配對', () => {
  assert.deepStrictEqual(O.pickReviewPairs([ag('1'), ag('2')], []), []);
});

t('兩份以上成果沿用執行者環狀輪替', () => {
  const a = ag('1'), b = ag('2'), c = ag('3');
  const pairs = O.pickReviewPairs([a, b, c], [rep(a), rep(b), rep(c)]);
  assert.deepStrictEqual(pairs.map((p: any) => [p.reviewer.id, p.target.agent.id]), [['1', '2'], ['2', '3'], ['3', '1']]);
});

t('只有一份成果時由未執行的其他成員審查,且絕不是本人', () => {
  const a = ag('1', 'A'), b = ag('2', 'B');
  const pairs = O.pickReviewPairs([a, b], [rep(a)]);
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].reviewer.id, '2');
  assert.strictEqual(pairs[0].target.agent.id, '1');
  assert.notStrictEqual(pairs[0].reviewer.id, pairs[0].target.agent.id);
});

t('整場只剩一名啟用成員時安全略過審查', () => {
  const a = ag('1', 'A');
  assert.deepStrictEqual(O.pickReviewPairs([a], [rep(a)]), []);
  assert.deepStrictEqual(O.pickReviewPairs([], [rep(a)]), []);
});

// ---------- unseenTranscript(整合) ----------

function makeOrc(cli: any, maxTranscriptChars: any) {
  const agents = [
    { id: 'me', name: '我', cli, enabled: true },
    { id: 'other', name: '別人', cli, enabled: true },
  ];
  const store = { get: () => ({ agents, settings: { maxTranscriptChars, language: '繁體中文', workDir: '/tmp' } }) };
  const orc = new O.Orchestrator(store);
  orc.messages = [
    { kind: 'user', text: big('任務內容', 300), status: 'done' },
    { kind: 'agent', agentId: 'other', agentName: '別人', text: big('很長的發言', 9000), status: 'done' },
    { kind: 'agent', agentId: 'other', agentName: '別人', text: '最後一句', status: 'done' },
  ];
  orc.taskStartIndex = 0;
  return { orc, me: agents[0] };
}

t('不支援 resume 的成員會套用上限並保留首尾', () => {
  const { orc, me } = makeOrc('custom', 1500);
  const out = orc.unseenTranscript(me, null);
  assert.ok(out.length <= 1500, `實際 ${out.length}`);
  assert.ok(out.includes('任務內容'));
  assert.ok(out.includes('最後一句'));
  assert.ok(out.includes(OMIT) || out.includes(CLIP));
});

t('支援 resume 且發言過的成員不套用截斷(只送新訊息,量本來就小)', () => {
  const { orc, me } = makeOrc('claude', 1500);
  orc.lastSeen.me = 0;
  const out = orc.unseenTranscript(me, null);
  assert.ok(out.length > 1500, `實際 ${out.length}`);
  assert.ok(!out.includes(OMIT));
});

t('支援 resume 但第一次發言的成員(例如剛載入歷史對話)從頭看起並套用上限', () => {
  const { orc, me } = makeOrc('claude', 1500);
  orc.taskStartIndex = 2; // 新任務在後面,前面是歷史紀錄
  const out = orc.unseenTranscript(me, null);
  assert.ok(out.length <= 1500, `實際 ${out.length}`);
  assert.ok(out.includes('任務內容'), '歷史紀錄的開頭要帶到');
  assert.ok(out.includes('最後一句'));
});

t('@ 指定的使用者訊息在紀錄裡標出對象', () => {
  const { orc, me } = makeOrc('custom', 0);
  orc.messages = [{ kind: 'user', text: '幫我看', status: 'done', mentions: [{ id: 'other', name: '別人' }] }];
  assert.ok(orc.unseenTranscript(me, null).startsWith('[使用者 → @別人]:'));
});

t('沒有未讀訊息時回傳空字串', () => {
  const { orc, me } = makeOrc('custom', 1500);
  orc.messages = [];
  assert.strictEqual(orc.unseenTranscript(me, null), '');
});

// ---------- git 變更 ----------

t('porcelain 解析:狀態、路徑與 rename 取新路徑', () => {
  const m = O.parsePorcelain(' M src/a.js\n?? new.txt\nR  old.js -> new.js\n"D  quoted.js"\n\n');
  assert.strictEqual(m.get('src/a.js'), 'M');
  assert.strictEqual(m.get('new.txt'), '??');
  assert.strictEqual(m.get('new.js'), 'R');
  assert.strictEqual(m.size, 4);
});

t('porcelain 解析:-uall 展開後的巢狀未追蹤檔案各自成列', () => {
  const m = O.parsePorcelain('?? sub/a/f1.txt\n?? sub/a/f2.txt\n M src/b.js');
  assert.deepStrictEqual([...m.keys()], ['sub/a/f1.txt', 'sub/a/f2.txt', 'src/b.js']);
  assert.strictEqual(m.get('sub/a/f2.txt'), '??');
});

t('變更檔案過多時只列前 200 筆並標示其餘數量', () => {
  const lines = Array.from({ length: 250 }, (_: any, i: any) => `?? f${i}.txt`).join('\n');
  const out = O.describeGitChanges(null, O.parsePorcelain(lines));
  const rows = out.split('\n');
  assert.strictEqual(rows.length, 201);
  assert.ok(rows[200].includes('另有 50 個'), rows[200]);
});

t('沒有變更或非 git repo 時不產生總結段落', () => {
  assert.strictEqual(O.describeGitChanges(null, null), null);
  assert.strictEqual(O.describeGitChanges(new Map(), new Map()), null);
});

t('執行前就已變更的檔案會被標示,不會全部宣稱為本次產生', () => {
  const before = O.parsePorcelain(' M old.js');
  const after = O.parsePorcelain(' M old.js\n?? fresh.js');
  const out = O.describeGitChanges(before, after);
  assert.ok(/old\.js\(執行前就已是變更狀態\)/.test(out), out);
  assert.ok(/fresh\.js$/m.test(out.split('\n').find((l: any) => l.includes('fresh.js'))), out);
});

// ---------- 既有純函式 ----------

t('extractJson 能從說明文字中取出分工 JSON', () => {
  const o = O.extractJson('好的,這是分工:\n```json\n{"summary":"s","assignments":[{"agent":"A1","task":"做甲"}]}\n```\n以上。');
  assert.strictEqual(o.assignments[0].agent, 'A1');
});

t('resolveAgent 先比代號再比名稱', () => {
  const a = ag('1', 'Claude'), b = ag('2', 'Codex');
  const codes = new Map([['A1', a], ['A2', b]]);
  assert.strictEqual(O.resolveAgent('A2', codes, [a, b]).id, '2');
  assert.strictEqual(O.resolveAgent('「Claude」', codes, [a, b]).id, '1');
  assert.strictEqual(O.resolveAgent('不存在的人', codes, [a, b]), null);
});

// ---------- @ 指定 ----------

const { findMentions } = require('../src/shared');

t('findMentions:長名稱優先、全形＠、英數字邊界、中文名稱可直接接內容', () => {
  const list = [ag('1', 'Claude'), ag('2', 'Codex'), ag('3', 'Code'), ag('4', '克勞德')];
  const names = (text: any) => findMentions(text, list).map((a: any) => a.name);
  assert.deepStrictEqual(names('@Codex 幫我'), ['Codex']);
  assert.deepStrictEqual(names('＠claude 和 @Code 一起看'), ['Claude', 'Code']);
  assert.deepStrictEqual(names('@克勞德幫我看 @Codex2'), ['克勞德']);
  assert.deepStrictEqual(names('寄信到 a@b.com'), []);
  assert.deepStrictEqual(names('@Code 先,@Claude 後,@Code 重複'), ['Code', 'Claude']);
});

// ---------- 載入歷史對話 ----------

t('loadConversation:還原訊息、未完成的標成中斷、清掉 session 記憶', () => {
  const { orc } = makeOrc('custom', 0);
  orc.sessions = { me: 's1' };
  orc.lastSeen = { me: 3 };
  const snap = orc.loadConversation({
    conversationId: 'conv-1',
    messages: [
      { kind: 'user', text: '舊任務' },
      { kind: 'agent', agentId: 'other', text: '寫到一半', status: 'running' },
      null,
      { kind: 'weird', text: 42 },
    ],
  });
  assert.strictEqual(snap.conversationId, 'conv-1');
  assert.strictEqual(snap.messages.length, 3);
  assert.ok(snap.messages.every((m: any) => typeof m.id === 'string' && Array.isArray(m.activities)));
  assert.strictEqual(snap.messages[1].status, 'error');
  assert.ok(snap.messages[1].error);
  assert.strictEqual(snap.messages[2].kind, 'system');
  assert.strictEqual(snap.messages[2].text, '42');
  assert.deepStrictEqual(orc.sessions, {});
  assert.deepStrictEqual(orc.lastSeen, {});

  assert.notStrictEqual(orc.loadConversation({ conversationId: '../x', messages: [] }).conversationId, '../x');
  orc.running = true;
  assert.throws(() => orc.loadConversation({ messages: [] }), /進行中/);
});

console.log(`\n${n} 項測試全部通過`);

// ---------- 需要跑回合的整合測試(假轉接器) ----------

const adapters = require('../src/adapters');

function fakeOrc(names: any) {
  const agents = names.map((name: any, i: any) => ({ id: `a${i}`, name, cli: 'fake', enabled: true, canEdit: false }));
  const calls: any[] = [];
  adapters.setRegistry({
    get: () => ({
      id: 'fake', supportsResume: false, supportsEdit: false,
      run: async (agent: any, ctx: any) => {
        calls.push({ name: agent.name, prompt: ctx.prompt, cwd: ctx.cwd });
        await new Promise((r: any) => setTimeout(r, 5));
        return { text: `${agent.name} 回覆` };
      },
    }),
  });
  const settings = { maxTranscriptChars: 0, language: '繁體中文', workDir: require('os').tmpdir(), maxRounds: 1, mode: 'discuss' };
  const orc = new O.Orchestrator({ get: () => ({ agents, settings }), userDataDir: require('os').tmpdir() });
  const idle = () => new Promise((resolve: any) => {
    const check = (s: any) => { if (!s.running && s.phase && s.phase.code === 'idle') { orc.off('state', check); resolve(); } };
    orc.on('state', check);
  });
  return { orc, agents, calls, settings, idle };
}

(async () => {
  let m = 0;
  const at = async (name: any, fn: any) => { await fn(); m++; console.log('ok -', name); };

  await at('@ 指定一位成員時只有他回覆,不跑討論流程', async () => {
    const { orc, calls, idle } = fakeOrc(['甲', '乙', '丙']);
    const done = idle();
    await orc.userMessage('@乙 幫我寫測試', 'divide');
    await done;
    assert.deepStrictEqual(calls.map((c: any) => c.name), ['乙']);
    assert.ok(calls[0].prompt.includes('[使用者 → @乙]:'));
    assert.ok(calls[0].prompt.includes('【指定回覆】'));
    const user = orc.messages[0];
    assert.deepStrictEqual(user.mentions, [{ id: 'a1', name: '乙' }]);
    assert.strictEqual(user.directed, true);
    const replies = orc.messages.filter((x: any) => x.kind === 'agent');
    assert.strictEqual(replies.length, 1);
    assert.deepStrictEqual(replies[0].phase, { code: 'direct' });
    assert.strictEqual(replies[0].group, undefined, '單人回覆不需要並排');
  });

  await at('@ 指定多位成員時平行回覆,訊息屬於同一個並排群組', async () => {
    const { orc, calls, idle } = fakeOrc(['甲', '乙', '丙']);
    const phases: any[] = [];
    orc.on('state', (s: any) => { if (s.phase) phases.push(s.phase); });
    const done = idle();
    await orc.userMessage('@甲 @丙 各自檢查一次', 'divide');
    await done;
    assert.deepStrictEqual(calls.map((c: any) => c.name).sort(), ['丙', '甲']);
    const replies = orc.messages.filter((x: any) => x.kind === 'agent');
    assert.strictEqual(replies.length, 2);
    assert.ok(replies[0].group && replies[0].group === replies[1].group);
    // PhaseInfo.names 必須是陣列:renderer 會對它呼叫 .join(),
    // 送字串進來會在指定回覆時丟 TypeError,而 orchestrator 的 any 型別擋不住。
    const direct = phases.find((p: any) => p.code === 'direct');
    assert.ok(direct, 'setPhase 應送出 direct 階段');
    assert.ok(Array.isArray(direct.names), 'PhaseInfo.names 必須是 string[],不可是 join 後的字串');
    assert.deepStrictEqual(direct.names.slice().sort(), ['丙', '甲']);
  });

  await at('進行中 @ 指定的成員若任務結束前都沒發言,會補一次指定回覆', async () => {
    const { orc, calls, idle } = fakeOrc(['甲', '乙']);
    orc.running = true;
    orc.taskCwd = '/tmp';
    await orc.userMessage('@乙 等等順便看這個', 'discuss');
    assert.strictEqual(orc.directedQueue.length, 1);
    orc.running = false;
    orc.messages.push({ kind: 'agent', agentId: 'a0', agentName: '甲', text: '甲 回覆', status: 'done' });
    await orc.answerDirectedQueue();
    assert.deepStrictEqual(calls.map((c: any) => c.name), ['乙']);

    // 對方之後已經發言過就不再補
    calls.length = 0;
    await orc.userMessage('@甲 還有這個', 'discuss').catch(() => {});
    await idle();
    calls.length = 0;
    orc.directedQueue.push({ msg: orc.messages[0], agentIds: ['a1'] });
    await orc.answerDirectedQueue();
    assert.deepStrictEqual(calls, []);
  });

  await at('執行中途改工作目錄時,追加附件與回合仍使用任務開始時的目錄', async () => {
    const { orc, settings, calls } = fakeOrc(['甲']);
    const staged: any[] = [];
    orc.stageAttachments = (_agents: any, cwd: any) => staged.push(cwd);
    orc.running = true;
    orc.taskCwd = '/task-start-dir';
    settings.workDir = '/changed-later';
    await orc.userMessage('補一張圖', 'discuss', [{ id: 'x', name: 'a.png', kind: 'image' }]);
    assert.deepStrictEqual(staged, ['/task-start-dir']);
    await orc.turn(orc.agents[0], '說話');
    assert.strictEqual(calls[0].cwd, '/task-start-dir');
  });

  console.log(`${m} 項整合測試全部通過`);
})().catch((error: any) => {
  console.error(error);
  process.exitCode = 1;
});
