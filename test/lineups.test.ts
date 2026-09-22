'use strict';

// 陣容:存下誰上場、各自的角色、主持人與流程,之後一鍵換回來。
// 換陣容只改「誰啟用」與角色,不動成員的 CLI 與模型;被刪掉的成員要略過而不是讓整個陣容壞掉。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../src/lineups');
const { Store } = require('../src/store');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

const agent = (id: string, extra: any = {}) => ({ id, name: id.toUpperCase(), cli: 'claude', model: `m-${id}`, effort: '', persona: `${id} 原本的角色`, color: '#000', canEdit: true, enabled: true, customCommand: '', ...extra });
const config = (agents: any[], settings: any = {}) => ({ agents, settings: { workDir: '/w', maxRounds: 3, mode: 'divide', leadAgentId: null, language: 'x', maxTranscriptChars: 1, ...settings } });

test('討論方式隨陣容保存、套用與比對,舊陣容仍是循序', () => {
  const current = config([agent('a')], { discussionMode: 'independent-first' });
  const lineup = L.lineupFromConfig(current, 'independent', 'independent');
  assert.strictEqual(lineup.discussionMode, 'independent-first');
  assert.strictEqual(L.sanitizeLineups([lineup])[0].discussionMode, 'independent-first');
  assert.strictEqual(L.applyLineup(config([agent('a')]), lineup).config.settings.discussionMode, 'independent-first');
  assert.ok(L.lineupMatches(current, lineup));
  assert.ok(!L.lineupMatches(config([agent('a')]), lineup));
  assert.ok(L.lineupMatches(config([agent('a')]), { ...lineup, discussionMode: undefined }));
  assert.strictEqual(L.applyLineup(current, { ...lineup, discussionMode: undefined }).config.settings.discussionMode, 'sequential');
});

test('存下目前啟用的成員、角色、實際的主持人、流程與回合數', () => {
  const c = config([agent('a'), agent('b', { enabled: false }), agent('c', { persona: '審查者' })], { leadAgentId: 'b', mode: 'discuss', maxRounds: 2 });
  const l = L.lineupFromConfig(c, '  審查組  ', 'L1');
  assert.deepStrictEqual(l.members, [{ id: 'a', persona: 'a 原本的角色' }, { id: 'c', persona: '審查者' }]);
  // 指定的主持人沒啟用:實際主持的是第一位啟用的成員,存的也是他
  assert.strictEqual(l.leadAgentId, 'a');
  assert.strictEqual(l.name, '審查組');
  assert.strictEqual(l.mode, 'discuss');
  assert.strictEqual(l.maxRounds, 2);
});

test('套用:陣容裡的成員啟用並換上角色,其他停用;CLI 與模型不變', () => {
  const c = config([agent('a'), agent('b'), agent('c')]);
  const lineup = { id: 'L1', name: 'x', members: [{ id: 'b', persona: '新角色' }, { id: 'c', persona: '' }], leadAgentId: 'c', mode: 'discuss', maxRounds: 5 };
  const r = L.applyLineup(c, lineup);
  assert.deepStrictEqual(r.config.agents.map((a: any) => [a.id, a.enabled, a.persona, a.model]), [['a', false, 'a 原本的角色', 'm-a'], ['b', true, '新角色', 'm-b'], ['c', true, '', 'm-c']]);
  assert.strictEqual(r.config.settings.leadAgentId, 'c');
  assert.strictEqual(r.config.settings.mode, 'discuss');
  assert.strictEqual(r.config.settings.maxRounds, 5);
  assert.strictEqual(r.config.settings.activeLineupId, 'L1');
  assert.strictEqual(r.missing, 0);
  // 原本的設定不被改動(介面要拿新的整份寫回)
  assert.strictEqual(c.agents[0].enabled, true);
  assert.ok(L.lineupMatches(r.config, lineup));
});

test('陣容裡有成員已刪除:略過並回報;全被刪掉時不套用;主持人被刪就換第一位', () => {
  const c = config([agent('a'), agent('b')]);
  const r = L.applyLineup(c, { id: 'L', name: 'x', members: [{ id: 'gone', persona: '' }, { id: 'b', persona: 'p' }], leadAgentId: 'gone', mode: 'divide', maxRounds: 3 });
  assert.strictEqual(r.missing, 1);
  assert.strictEqual(r.config.settings.leadAgentId, 'b');
  assert.deepStrictEqual(r.config.agents.map((a: any) => a.enabled), [false, true]);
  assert.strictEqual(L.applyLineup(c, { id: 'L', name: 'x', members: [{ id: 'gone', persona: '' }], leadAgentId: null, mode: 'divide', maxRounds: 3 }), null);
});

test('工作模式也是陣容的一部分:存下來、套用時換過去、改了就不相符', () => {
  const c = config([agent('a')], { workStyle: 'general' });
  const l = L.lineupFromConfig(c, '文件組', 'L');
  assert.strictEqual(l.workStyle, 'general');
  const applied = L.applyLineup(config([agent('a')], { workStyle: 'code' }), l);
  assert.strictEqual(applied.config.settings.workStyle, 'general');
  assert.ok(L.lineupMatches(c, l));
  assert.strictEqual(L.lineupMatches(config([agent('a')], { workStyle: 'code' }), l), false);
  // 舊的陣容沒有這個欄位:視為寫程式(改這個功能之前的預設行為)
  assert.ok(L.lineupMatches(config([agent('a')]), { ...l, workStyle: undefined }));
});

test('套用後又改了誰上場、角色、主持人、流程或回合數:不再相符', () => {
  const base = config([agent('a'), agent('b'), agent('c', { enabled: false })], { leadAgentId: 'a' });
  const lineup = L.lineupFromConfig(base, 'x', 'L');
  assert.ok(L.lineupMatches(base, lineup));
  const variants: Array<[string, any]> = [
    ['多一位成員上場', config([agent('a'), agent('b'), agent('c')], { leadAgentId: 'a' })],
    ['少一位成員', config([agent('a'), agent('b', { enabled: false }), agent('c', { enabled: false })], { leadAgentId: 'a' })],
    ['角色改了', config([agent('a', { persona: '換了' }), agent('b'), agent('c', { enabled: false })], { leadAgentId: 'a' })],
    ['換主持人', config([agent('a'), agent('b'), agent('c', { enabled: false })], { leadAgentId: 'b' })],
    ['換流程', config([agent('a'), agent('b'), agent('c', { enabled: false })], { leadAgentId: 'a', mode: 'discuss' })],
    ['換回合數', config([agent('a'), agent('b'), agent('c', { enabled: false })], { leadAgentId: 'a', maxRounds: 4 })],
  ];
  for (const [what, c] of variants) assert.strictEqual(L.lineupMatches(c, lineup), false, what);
  // 停用成員的角色改了不影響:它不在陣容裡
  assert.ok(L.lineupMatches(config([agent('a'), agent('b'), agent('c', { enabled: false, persona: '隨便' })], { leadAgentId: 'a' }), lineup));
  // 陣容裡的成員被刪掉之後,剩下的照舊就算相符,不會永遠顯示「已修改」
  assert.ok(L.lineupMatches(config([agent('a'), agent('c', { enabled: false })], { leadAgentId: 'a' }), lineup));
});

test('設定檔裡的陣容:形狀不對整筆丟掉,欄位不對補預設值,重複 id 只留第一個', () => {
  const out = L.sanitizeLineups([
    { id: 'ok', name: ' 好的 ', members: [{ id: 'a', persona: 'p' }, { id: 'a', persona: 'dup' }, { id: 'b' }, 'x'], leadAgentId: 'zzz', mode: 'weird', maxRounds: 99 },
    { id: 'ok', name: '重複', members: [{ id: 'a' }] },
    { id: 'noname', name: '  ', members: [{ id: 'a' }] },
    { id: 'nomembers', name: 'n', members: [] },
    null, 'x', { name: 'no id', members: [{ id: 'a' }] },
  ]);
  assert.deepStrictEqual(out, [{ id: 'ok', name: '好的', members: [{ id: 'a', persona: 'p' }, { id: 'b', persona: '' }], leadAgentId: null, mode: 'divide', maxRounds: 10, discussionMode: 'sequential', workStyle: 'code' }]);
  assert.deepStrictEqual(L.sanitizeLineups('nope'), []);
  assert.strictEqual(L.sanitizeLineups(Array.from({ length: 50 }, (_, i) => ({ id: `l${i}`, name: `n${i}`, members: [{ id: 'a' }] }))).length, L.LINEUPS_MAX);
});

test('存檔後重新載入:陣容保留;舊版設定沒有陣容也能載入', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-lineups-'));
  try {
    const store = new Store(dir);
    const c = store.get();
    const lineup = L.lineupFromConfig(c, '預設兩位', 'L1');
    store.save({ ...c, lineups: [lineup], settings: { ...c.settings, activeLineupId: 'L1' } });
    const again = new Store(dir).get();
    assert.deepStrictEqual(again.lineups, [lineup]);
    assert.strictEqual(again.settings.activeLineupId, 'L1');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ agents: c.agents, settings: c.settings }));
    assert.deepStrictEqual(new Store(dir).get().lineups, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} lineup tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
