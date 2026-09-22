'use strict';

// 棘輪與反例語料庫(見 src/ratchet.ts、src/corpus.ts)。
//
// 這裡要守的是兩件事:
//   1. 不可以憑空造出退步。把「不知道」當成「沒過」會回退掉其實沒問題的成果,
//      而使用者看到的是一次成功的任務被整個收回去,還找不到原因。
//   2. 本來就沒過的關卡不是這次任務的責任。實驗 7 的改錯題起點就有 8 成以上的測試會過、
//      其餘是壞的;如果把「沒有全過」當成退步,每一次任務都會被回退。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compareGates, decideRatchet, gateState, gatesFromCounterexamples, blocking, describeChanges } = require('../src/ratchet');
const { loadCorpus, saveCorpus, additions, corpusCounterexamples, corpusPath, CORPUS_MAX_ENTRIES } = require('../src/corpus');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

const gate = (command: string, ok: boolean) => ({ kind: 'gate' as const, key: command, label: command, weight: 'owned' as const, ok });
const ceGate = (id: string, ok: boolean, weight: 'confirmed' | 'inherited' = 'confirmed') =>
  ({ kind: 'counterexample' as const, key: id, label: id, weight, ok });
const state = (...entries: unknown[]) => ({ entries });

const run = (id: string, passed: boolean, extra: Record<string, unknown> = {}) => ({
  id, reviewerId: 'r', reviewerName: '審查者', targetId: 't', title: id, source: `// ${id}`,
  passed, code: passed ? 0 : 1, output: '', timedOut: false, ...extra,
});

// ---------- compareGates ----------

test('比較:通過變不通過是退步,反過來是改善', () => {
  const r = compareGates(state(gate('npm test', true), gate('lint', false)), state(gate('npm test', false), gate('lint', true)));
  assert.deepStrictEqual(r.regressed.map((c: any) => c.key), ['npm test']);
  assert.deepStrictEqual(r.improved.map((c: any) => c.key), ['lint']);
  assert.strictEqual(r.verdict, 'regressed', '有退步就是退步,不因為同時有改善而抵銷');
});

test('比較:本來就沒過的關卡不算這次任務的責任', () => {
  const r = compareGates(state(gate('npm test', false)), state(gate('npm test', false)));
  assert.deepStrictEqual(r.regressed, []);
  assert.strictEqual(r.verdict, 'same');
});

test('比較:只有一邊量得到的關卡是「不知道」,不是「沒過」', () => {
  // 第一道沒過就停,後面幾道根本沒跑;把它們當成沒過會憑空造出退步
  const r = compareGates(state(gate('lint', true), gate('npm test', true)), state(gate('lint', false)));
  assert.deepStrictEqual(r.regressed.map((c: any) => c.key), ['lint']);
  assert.deepStrictEqual(r.incomparable.map((c: any) => c.key), ['npm test']);
});

test('比較:語料庫來的反例照樣列出來,但不會讓整體判定變成退步', () => {
  const r = compareGates(state(ceGate('corpus-1', true, 'inherited')), state(ceGate('corpus-1', false, 'inherited')));
  assert.deepStrictEqual(r.regressed.map((c: any) => c.key), ['corpus-1'], '使用者要看得到');
  assert.strictEqual(r.verdict, 'same', '一條舊主張不可以單獨收回一次正確的改動');
  assert.deepStrictEqual(blocking(r.regressed), []);

  // 但如果同時有使用者自己的關卡退步,那就是真的退步
  const both = compareGates(
    state(ceGate('corpus-1', true, 'inherited'), gate('npm test', true)),
    state(ceGate('corpus-1', false, 'inherited'), gate('npm test', false)),
  );
  assert.strictEqual(both.verdict, 'regressed');
  assert.deepStrictEqual(blocking(both.regressed).map((c: any) => c.key), ['npm test']);
});

test('關卡來源:跑不成的反例不進關卡;語料庫的權重是 inherited', () => {
  const entries = gatesFromCounterexamples([
    run('a', false),
    run('corpus-b', true),
    run('c', false, { unusable: true }),
  ]);
  assert.deepStrictEqual(entries.map((e: any) => [e.key, e.weight]), [['a', 'confirmed'], ['corpus-b', 'inherited']]);
});

test('關卡來源:沒跑過的自動驗證不產生任何關卡', () => {
  assert.deepStrictEqual(gateState({ ran: false, syntax: [], ok: true, checked: 0 }).entries, []);
  // 只看真的檢查過的檔案:沒檢查的(副檔名不支援、超過上限)狀態是不知道
  const s = gateState({ ran: true, checked: 2, ok: false, syntax: [{ file: 'b.js', error: 'x' }], checkedFiles: ['a.js', 'b.js'], gates: [] });
  assert.deepStrictEqual(s.entries.map((e: any) => [e.key, e.ok]), [['a.js', true], ['b.js', false]]);
});

// ---------- decideRatchet ----------

test('決定:什麼都沒退步就不回退', () => {
  const d = decideRatchet({
    baseline: state(gate('npm test', true)),
    execute: state(gate('npm test', true)),
    afterFix: state(gate('npm test', true)),
  });
  assert.strictEqual(d.scope, 'none');
  assert.strictEqual(d.reason, 'clean');
});

test('決定:修復把執行階段做對的東西弄壞 → 只收回修復', () => {
  const d = decideRatchet({
    baseline: state(gate('npm test', false)),
    execute: state(gate('npm test', true), ceGate('a', true)),
    afterFix: state(gate('npm test', true), ceGate('a', false)),
  });
  assert.strictEqual(d.scope, 'repair');
  assert.strictEqual(d.reason, 'repair-regressed');
});

test('決定:沒有修復前的快照就不能只收回修復,只能整段回退', () => {
  const d = decideRatchet({
    execute: state(ceGate('a', true)),
    afterFix: state(ceGate('a', false)),
    canRevertRepair: false,
  });
  assert.strictEqual(d.scope, 'task');
});

test('決定:執行階段本身就比任務開始前糟 → 整段回退,修復有沒有更糟都一樣', () => {
  // 實驗 7 的 poker-fix 單人組:起點 35/39 被執行階段打成 1/39,修復沒讓它更糟。
  // 舊的判斷只比「執行後 vs 修復後」,於是說不用回退——但相對使用者按下送出之前,那是純粹的破壞。
  const d = decideRatchet({
    baseline: state(gate('npm test', true)),
    execute: state(gate('npm test', false)),
    afterFix: state(gate('npm test', false)),
  });
  assert.strictEqual(d.scope, 'task');
  assert.strictEqual(d.reason, 'execute-regressed');
});

test('決定:修復退步、而執行階段相對基準線也是退步的 → 收回修復不夠,整段回退', () => {
  const d = decideRatchet({
    baseline: state(gate('lint', true), ceGate('a', true)),
    execute: state(gate('lint', false), ceGate('a', true)),
    afterFix: state(gate('lint', false), ceGate('a', false)),
  });
  assert.strictEqual(d.scope, 'task');
  assert.strictEqual(d.reason, 'execute-regressed');
});

test('決定:沒有基準線也能運作,只是看不見執行階段的破壞', () => {
  const d = decideRatchet({ execute: state(gate('npm test', false)), afterFix: state(gate('npm test', false)) });
  assert.strictEqual(d.scope, 'none');
});

test('決定:反例從失敗變成通過是改善,不會觸發回退', () => {
  const d = decideRatchet({
    baseline: state(gate('npm test', true)),
    execute: state(gate('npm test', true), ceGate('a', false)),
    afterFix: state(gate('npm test', true), ceGate('a', true)),
  });
  assert.strictEqual(d.scope, 'none');
  assert.deepStrictEqual(d.fromExecute.improved.map((c: any) => c.key), ['a']);
});

test('訊息:退步的關卡分種類說明', () => {
  const text = describeChanges([
    { kind: 'gate', key: 'npm test', label: 'npm test', weight: 'owned' },
    { kind: 'counterexample', key: 'a', label: '負數會溢位', weight: 'confirmed' },
    { kind: 'syntax', key: 'a.js', label: 'a.js', weight: 'owned' },
  ]);
  assert.match(text, /npm test/);
  assert.match(text, /負數會溢位/);
  assert.match(text, /a\.js/);
});

// ---------- 語料庫 ----------

function emptyDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'rt-corpus-')); }

test('語料庫:只收確認過的反例,不收不成立與跑不成的', () => {
  const incoming = additions([run('a', false), run('b', true), run('c', false, { unusable: true })], '任務', []);
  assert.deepStrictEqual(incoming.map((e: any) => e.title), ['a']);
});

test('語料庫:同一段腳本不會被收兩次,不管是誰提出的', () => {
  const same = [run('a', false), { ...run('b', false), source: '// a' }];
  assert.strictEqual(additions(same, '任務', []).length, 1);
  const existing = additions([run('a', false)], '任務', []);
  assert.deepStrictEqual(additions([run('a2', false, { source: '// a' })], '任務', existing), []);
});

test('語料庫:存得進去、讀得回來,而且變成 corpus- 開頭的反例', () => {
  const dir = emptyDir();
  const incoming = additions([run('a', false)], '把 sum 修好', []);
  const outcome = saveCorpus(dir, [], incoming);
  assert.strictEqual(outcome.added, 1);
  assert.strictEqual(outcome.total, 1);
  assert.ok(fs.existsSync(corpusPath(dir)));

  const loaded = loadCorpus(dir);
  assert.strictEqual(loaded.length, 1);
  assert.strictEqual(loaded[0].task, '把 sum 修好');
  assert.strictEqual(loaded[0].reviewer, '審查者');

  const list = corpusCounterexamples(loaded);
  assert.ok(list[0].id.startsWith('corpus-'), '語料庫的關卡要和這次新舉出來的分得開');
  assert.strictEqual(list[0].source, '// a');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('語料庫:檔案壞掉、被手改過、根本不存在,一律當成空的而不是讓任務停下來', () => {
  const dir = emptyDir();
  assert.deepStrictEqual(loadCorpus(dir), [], '沒有檔案');
  fs.mkdirSync(path.dirname(corpusPath(dir)), { recursive: true });
  fs.writeFileSync(corpusPath(dir), '{ 壞掉的 json');
  assert.deepStrictEqual(loadCorpus(dir), [], '壞掉的 JSON');
  fs.writeFileSync(corpusPath(dir), '"不是陣列"');
  assert.deepStrictEqual(loadCorpus(dir), [], '型別不對');
  // 沒有 source 的項目直接略過,不會變成一個跑不起來的關卡
  fs.writeFileSync(corpusPath(dir), JSON.stringify([{ id: 'x', title: '空的' }, { source: '// ok' }]));
  assert.deepStrictEqual(loadCorpus(dir).map((e: any) => e.source), ['// ok']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('語料庫:滿了就照實說沒收,不靜默丟掉最舊的', () => {
  const dir = emptyDir();
  const existing = Array.from({ length: CORPUS_MAX_ENTRIES }, (_, i) => ({
    id: `e${i}`, title: `${i}`, source: `// ${i}`, addedAt: 1, reviewer: 'r', task: 't',
  }));
  const outcome = saveCorpus(dir, existing, additions([run('new', false)], '任務', []));
  assert.strictEqual(outcome.added, 0);
  assert.strictEqual(outcome.rejected, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} ratchet tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
