'use strict';

// 「尚未審查」標記的測試。
//
// 為什麼重要:只有一位成員、或審查者自己也失敗時,交叉審查會靜默地不發生,
// 而畫面看起來跟順利跑完一模一樣。使用者會把「跑完了」讀成「有人檢查過了」,
// 然後帶著沒人看過的改動繼續往下做。這組測試鎖住那個標記確實會出現、
// 也確實不會在有人審查過時亂出現。

const assert = require('assert');
const O = require('../src/orchestrator');
const adapters = require('../src/adapters');

// effectiveCanEdit 會查 registry 的 supportsEdit,所以要有一個支援改檔的假轉接器,
// 否則每個成員都會被算成唯讀、測不到真正的判定。
adapters.setRegistry({ get: () => ({ id: 'fake', supportsEdit: true, supportsResume: false, run: async () => ({ text: '' }) }) });

let passed = 0;
const cases: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void) => { cases.push([name, fn]); };

// markUnreviewed 只讀 this.messages 並呼叫 updateMessage,所以可以用最小的替身驗證,
// 不必跑完整個 divide 流程(那需要真的 CLI)。
function harness(messages: any[]) {
  const orc = Object.create(O.Orchestrator.prototype);
  orc.messages = messages;
  orc.updateMessage = (msg: any, patch: any) => Object.assign(msg, patch);
  return orc;
}

type TestMsg = { id: string; kind: string; agentId: string; phase: { code: string }; unreviewed?: boolean };
const execMsg = (agentId: string): TestMsg => ({ id: `m-${agentId}`, kind: 'agent', agentId, phase: { code: 'execute' } });
const agent = (id: string, canEdit = true) => ({ id, name: id, cli: 'fake', canEdit, enabled: true });

test('只有一位成員、沒有任何審查時要標記', () => {
  const msg = execMsg('a0');
  const orc = harness([msg]);
  orc.markUnreviewed([{ agent: agent('a0'), task: 't', report: 'r' }], []);
  assert.strictEqual(msg.unreviewed, true);
});

test('有成功的他人審查時不標記', () => {
  const msg = execMsg('a0');
  const orc = harness([msg]);
  const target = { agent: agent('a0'), task: 't', report: 'r' };
  orc.markUnreviewed([target], [{ reviewer: agent('a1'), target, text: '看過了,沒問題' }]);
  assert.strictEqual(msg.unreviewed, undefined);
});

test('審查者失敗或沒有輸出時仍要標記', () => {
  // 這是最容易被誤判成「審查過了」的情況:審查流程跑了,但 CLI 逾時或崩潰。
  // 判定必須與 fixPhase 一致——沒有輸出就不算審查過。
  for (const review of [{ error: 'CLI 逾時' }, { text: '' }, { text: '   ' }]) {
    const msg = execMsg('a0');
    const orc = harness([msg]);
    const target = { agent: agent('a0'), task: 't', report: 'r' };
    orc.markUnreviewed([target], [{ reviewer: agent('a1'), target, ...review }]);
    assert.strictEqual(msg.unreviewed, true, `審查為 ${JSON.stringify(review)} 時應該標記`);
  }
});

test('自己審查自己不算審查過', () => {
  const msg = execMsg('a0');
  const orc = harness([msg]);
  const target = { agent: agent('a0'), task: 't', report: 'r' };
  orc.markUnreviewed([target], [{ reviewer: agent('a0'), target, text: '我覺得沒問題' }]);
  assert.strictEqual(msg.unreviewed, true);
});

test('唯讀成員不標記', () => {
  // 唯讀成員沒有改動,沒被審查也不構成風險;標了只會變成到處都是的雜訊徽章
  const msg = execMsg('a0');
  const orc = harness([msg]);
  orc.markUnreviewed([{ agent: agent('a0', false), task: 't', report: 'r' }], []);
  assert.strictEqual(msg.unreviewed, undefined);
});

test('多位成員時只標記沒被審查到的那一位', () => {
  const m0 = execMsg('a0');
  const m1 = execMsg('a1');
  const orc = harness([m0, m1]);
  const t0 = { agent: agent('a0'), task: 't0', report: 'r0' };
  const t1 = { agent: agent('a1'), task: 't1', report: 'r1' };
  orc.markUnreviewed([t0, t1], [{ reviewer: agent('a1'), target: t0, text: '沒問題' }]);
  assert.strictEqual(m0.unreviewed, undefined);
  assert.strictEqual(m1.unreviewed, true);
});

test('只標記執行階段的訊息,不碰討論階段的發言', () => {
  const discuss: TestMsg = { id: 'd', kind: 'agent', agentId: 'a0', phase: { code: 'discuss' } };
  const exec = execMsg('a0');
  const orc = harness([discuss, exec]);
  orc.markUnreviewed([{ agent: agent('a0'), task: 't', report: 'r' }], []);
  assert.strictEqual(discuss.unreviewed, undefined);
  assert.strictEqual(exec.unreviewed, true);
});

for (const [name, fn] of cases) { fn(); passed++; console.log('ok -', name); }
console.log(`\n${passed} 項通過`);
