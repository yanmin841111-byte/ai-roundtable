'use strict';

// 審查評測(eval/)本身的檢查:題目真的在量它說要量的東西、計分規則、結果檔只有數字。
// 評測要跑真的模型,這裡不跑;這裡確保題目與計分沒有悄悄壞掉。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CASES } = require('../eval/cases');
const { judged, scoreCase, buildResult, resultFileName } = require('../eval/score');
const { REVIEW_INLINE_FILES } = require('../src/flow/review');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

test('題目 id 不重複;每題都說明要回答的問題;兩種預期都有', () => {
  const ids = CASES.map((c: any) => c.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  for (const c of CASES) assert.ok(c.asks && c.task && c.report, c.id);
  assert.ok(CASES.some((c: any) => c.expected === 'pass') && CASES.some((c: any) => c.expected === 'issues'));
});

test('「超過附上上限」那題:寫錯的檔案真的排在附上的檔案之外', () => {
  const c = CASES.find((x: any) => x.id === 'bug-beyond-inline-limit');
  const files = Object.keys(c.writes);
  assert.ok(files.length > REVIEW_INLINE_FILES, `要比上限 ${REVIEW_INLINE_FILES} 多`);
  const buggy = files[files.length - 1];
  assert.ok(/xs\.reduce\(\(m, x\) => \(x < m/.test(c.writes[buggy]), '寫錯的是最後一個檔案');
  // 審查時「回報提到的檔案排前面」:寫錯的那個沒被提到,才會排在最後、落在上限之外
  assert.ok(!c.report.includes(buggy), '回報沒有提到寫錯的檔案');
});

test('「跨檔案」與「只分析」兩題:問題不在改動裡', () => {
  const cross = CASES.find((x: any) => x.id === 'cross-file');
  assert.ok(cross.files['app.js'].includes('calcTotal') && !cross.writes['app.js'], '呼叫端沒跟著改');
  const analysis = CASES.find((x: any) => x.id === 'analysis-only');
  assert.ok(!analysis.writes || !Object.keys(analysis.writes).length, '只分析的題目不寫檔');
});

test('計分:該抓的沒放行才算對;失敗的回合不計分', () => {
  const run = (o: any) => ({ passed: false, repaired: false, readFile: false, error: false, ...o });
  assert.strictEqual(judged('issues', run({ passed: false })), true);
  assert.strictEqual(judged('issues', run({ passed: true })), false);
  assert.strictEqual(judged('pass', run({ passed: true })), true);
  const s = scoreCase({ id: 'x', expected: 'issues' }, [run({}), run({ passed: true }), run({ error: true }), run({ readFile: true })]);
  assert.deepStrictEqual(s, { expected: 'issues', runs: 4, correct: 2, errors: 1, readFile: 1 });
});

test('結果檔只有數字與模型資訊,沒有對話內容;檔名安全', () => {
  const r = buildResult({ date: '2026-09-19', version: '0.1.0', commit: 'abc1234', cli: 'ollama', model: 'qwen3.8:27b-mlx', runsPerCase: 3 },
    { a: { expected: 'issues', runs: 3, correct: 2, errors: 1, readFile: 2 }, b: { expected: 'pass', runs: 3, correct: 3, errors: 0, readFile: 3 } });
  assert.deepStrictEqual(r.total, { correct: 5, scored: 5, errors: 1 });
  assert.deepStrictEqual(Object.keys(r).sort(), ['app', 'cases', 'date', 'reviewer', 'runsPerCase', 'schema', 'total']);
  for (const s of Object.values(r.cases) as any[]) assert.deepStrictEqual(Object.keys(s).sort(), ['correct', 'errors', 'expected', 'readFile', 'runs']);
  assert.strictEqual(resultFileName(r), '2026-09-19-ollama-qwen3.8-27b-mlx.json');
  assert.strictEqual(resultFileName({ ...r, reviewer: { cli: 'openrouter', model: 'openai/gpt-5 ../x' } }), '2026-09-19-openrouter-openai-gpt-5-..-x.json');
});

test('單人 vs 圓桌的題目:參考解全過、常見錯解至少錯一項、原始檔(要修的題)不會全過', () => {
  const { AB_TASKS } = require('../eval/ab-tasks');
  const { runHiddenTests, materialize } = require('../eval/hidden-tests');
  const ids = AB_TASKS.map((t: any) => t.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  for (const task of AB_TASKS) {
    const ref = runHiddenTests(materialize(task.reference), task);
    assert.ok(ref.total > 0 && ref.pass === ref.total, `${task.id} 參考解 ${ref.pass}/${ref.total}`);
    const naive = runHiddenTests(materialize(task.naive), task);
    assert.ok(naive.pass < naive.total, `${task.id} 錯解竟然全過`);
    if (task.files) {
      const orig = runHiddenTests(materialize(task.files), task);
      assert.ok(orig.pass < orig.total, `${task.id} 原始檔竟然全過`);
    }
  }
});

test('隱藏測試:模組載不起來或檔案不存在時每一項各自失敗、並記下原因;無窮迴圈會逾時', () => {
  const { runHiddenTests, materialize } = require('../eval/hidden-tests');
  const task = { id: 'x', entry: 'm.js', tests: "t('a', () => assert.ok(M().ok));\nt('b', () => assert.ok(M().ok));" };
  const broken = runHiddenTests(materialize({ 'm.js': 'syntax error (' }), task);
  assert.strictEqual(broken.pass, 0);
  assert.strictEqual(broken.total, 2);
  assert.ok(broken.loadError, '載不起來要說出原因,才分得出「邏輯錯」和「檔案壞了」');
  // 「應該丟出 Error」的題目最容易白送分:模組載入就爆,assert.throws 照樣算過。
  // 載不起來的檔案一行都跑不動,分數必須是 0,否則壞掉的產出看起來像做對了四分之一。
  const throwy = { id: 'y', entry: 'm.js', tests: "t('丟錯', () => assert.throws(() => M().matches('壞')));\nt('可用', () => assert.ok(M().ok));" };
  const cheated = runHiddenTests(materialize({ 'm.js': 'syntax error (' }), throwy);
  assert.strictEqual(cheated.pass, 0, `載不起來卻拿到 ${cheated.pass} 分`);
  assert.strictEqual(cheated.total, 2);
  assert.deepStrictEqual(runHiddenTests(materialize({ 'other.js': '' }), task), { pass: 0, total: 2, missing: true });
  assert.deepStrictEqual(runHiddenTests(materialize({ 'm.js': 'module.exports = { ok: true };' }), task), { pass: 2, total: 2 });
  const hang = runHiddenTests(materialize({ 'm.js': 'while (true) {}' }), task, 1500);
  assert.strictEqual(hang.pass, 0);
  assert.ok(hang.error);
});

test('單人 vs 圓桌的彙總:執行回合失敗照樣計分,app 沒跑完的不計', () => {
  const { summarize } = require('../eval/ab');
  const run = (o: any) => ({ pass: 5, total: 5, seconds: 10, inputTokens: 0, outputTokens: 0, repaired: false, execFailed: false, error: false, ...o });
  const s = summarize([run({}), run({ pass: 2, execFailed: true, seconds: 30 }), run({ error: true, pass: 0 })]);
  assert.deepStrictEqual(s, { runs: 3, errors: 1, allPass: 1, passRate: 0.7, execFailed: 1, avgSeconds: 20, avgTokens: 0 });
});

test('失敗集合有穩定 ID,Jaccard 區分全對、不同錯誤與缺資料', () => {
  const { runHiddenTests, materialize } = require('../eval/hidden-tests');
  const { failureSimilarity } = require('../eval/stats');
  const dir = materialize({ 'm.js': 'module.exports = { ok: true };' });
  try {
    const task = { entry: 'm.js', tests: "t('same', () => assert.ok(M().ok));\nt('same', () => assert.ok(!M().ok));" };
    assert.deepStrictEqual(runHiddenTests(dir, task, 15000, true).failedTests, ['1']);
    assert.deepStrictEqual(runHiddenTests(dir, { ...task, entry: 'missing.js' }, 15000, true).failedTests, ['0', '1']);
    assert.deepStrictEqual(failureSimilarity([[], []]), { mean: null, pairs: 0, bothCorrect: 1, unavailable: 0 });
    assert.strictEqual(failureSimilarity([['0'], ['1']]).mean, 0);
    assert.strictEqual(failureSimilarity([['0', '1'], ['1']]).mean, 0.5);
    assert.strictEqual(failureSimilarity([['1', '1'], ['1']]).mean, 1);
    assert.deepStrictEqual(failureSimilarity([null, ['1']]), { mean: null, pairs: 0, bothCorrect: 0, unavailable: 1 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('統計:Wilson 信賴區間、Fisher 精確檢定與所需次數跟教科書的數字一致', () => {
  const { wilson, fisherExact, runsNeeded } = require('../eval/stats');
  const near = (x: number, y: number, eps = 0.002) => assert.ok(Math.abs(x - y) < eps, `${x} ≠ ${y}`);
  const [lo0, hi0] = wilson(0, 10);
  near(lo0, 0); near(hi0, 0.2775);
  const [lo, hi] = wilson(12, 15);
  near(lo, 0.5481); near(hi, 0.9295);
  // 經典的「女士品茶」:[[3,1],[1,3]] 雙尾 p = 0.4857
  near(fisherExact(3, 1, 1, 3), 0.4857);
  near(fisherExact(12, 3, 11, 3), 1);
  near(fisherExact(10, 0, 0, 10), 0.0000108, 1e-6);
  // 80% → 95% 每組約要 76 次(常態近似)
  assert.ok(Math.abs(runsNeeded(0.8, 0.95) - 76) <= 2, String(runsNeeded(0.8, 0.95)));
  assert.strictEqual(runsNeeded(0.5, 0.5), Infinity);
});

test('通用候選 runner:可見性隔離、公開關卡棘輪、用量未知與預算上限', async () => {
  const { runCandidates, selectCandidate } = require('../eval/conditions');
  const gate = (ok: boolean) => ({ entries: [{ kind: 'gate', key: 'public-test', label: 'public-test', weight: 'owned', ok }] });
  const candidate = (value: string, ok: boolean, tokens: number | null = 10) => ({ value, gates: gate(ok), tokens, usable: true });
  const calls: string[][] = [];
  const produce = async (index: number, visible: string[]) => { calls.push([...visible]); return candidate(String(index), index === 1); };
  const sequential = await runCandidates({ attempts: 3, visibility: 'sequential' }, produce);
  assert.deepStrictEqual(calls, [[], ['0'], ['0', '1']]);
  assert.strictEqual(sequential.selectedIndex, 1);
  calls.length = 0;
  await runCandidates({ attempts: 3, visibility: 'independent-first' }, produce);
  assert.deepStrictEqual(calls, [[], [], []]);
  assert.strictEqual(selectCandidate(candidate('incumbent', true), candidate('regression', false)), false);
  assert.strictEqual(selectCandidate(candidate('incumbent', true), candidate('tie', true)), false);
  assert.strictEqual(selectCandidate(candidate('incumbent', true), { ...candidate('missing', true), gates: { entries: [] } }), false);
  const budget = await runCandidates({ attempts: 10, visibility: 'independent-first', tokenBudget: 25 }, produce);
  assert.deepStrictEqual(budget.budget, { target: 25, tokens: 30, attempts: 3, stop: 'target-reached' });
  const unknown = await runCandidates({ attempts: 10, visibility: 'independent-first', tokenBudget: 25 }, async () => candidate('unknown', true, null));
  assert.deepStrictEqual(unknown.budget, { target: 25, tokens: null, attempts: 1, stop: 'usage-unavailable' });
  const capped = await runCandidates({ attempts: 2, visibility: 'independent-first', tokenBudget: 25 }, produce);
  assert.strictEqual(capped.budget.stop, 'attempt-limit');
  await assert.rejects(() => runCandidates({ attempts: Infinity }, produce), /positive integer/);
});

test('候選評測整合:隔離原始檔、公開後整合、預算只按公開關卡選擇', async () => {
  const { runCondition } = require('../eval/ab');
  const { parseConditions } = require('../eval/conditions');
  assert.throws(() => parseConditions('solo,typo'), /conditions/);
  assert.throws(() => parseConditions('solo,solo'), /conditions/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-candidates-'));
  const previous = process.env.EVAL_EVIDENCE_DIR;
  process.env.EVAL_EVIDENCE_DIR = path.join(root, 'evidence');
  const calls: any[] = [];
  const task = { id: 'fixture', task: 'implement entry.js', entry: 'entry.js', files: { 'entry.js': 'module.exports = { value: 0 };' }, tests: "t('hidden', () => assert.strictEqual(M().value, 2));\nfs.writeFileSync(ENTRY, 'module.exports = { value: 99 };');" };
  const launch = async (options: any) => {
    calls.push(options);
    const workDir = fs.mkdtempSync(path.join(root, 'work-'));
    fs.writeFileSync(path.join(workDir, 'entry.js'), `module.exports = { value: ${calls.length} };`);
    return { ok: true, value: { inputTokens: 10, outputTokens: 5, usageComplete: true }, elapsedMs: 1000, workDir, cleanup: () => fs.rmSync(workDir, { recursive: true, force: true }) };
  };
  try {
    const options = { candidates: 2, rounds: 2, verifyCommand: '' };
    const sequential = await runCondition(task, 'sequential-candidates', 1, 'fixture', options, launch);
    assert.strictEqual(sequential.candidates.length, 2);
    assert.strictEqual(calls.length, 3);
    assert.ok(calls[1].constants.task.includes('Previous candidate files'));
    assert.ok(!calls[1].constants.task.includes('value: 99'), 'hidden-test side effects cannot alter shared candidates');
    assert.ok(calls[2].constants.task.includes('Critique these candidate files'));
    assert.ok(calls.every((call) => JSON.stringify(call.files) === JSON.stringify(task.files)));
    assert.ok(calls.every((call) => !call.constants.task.includes("t('hidden'")));
    calls.length = 0;
    await runCondition(task, 'independent-candidates', 1, 'fixture', options, launch);
    assert.ok(!calls[1].constants.task.includes('Previous candidate files'));
    calls.length = 0;
    const budget = await runCondition(task, 'solo-budget', 1, 'fixture', { ...options, tokenBudget: 25 }, launch);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(budget.budget.tokens, 30);
    assert.strictEqual(budget.selectedCandidate, null, 'equal public gates retain the original even when a candidate passes hidden tests');
    assert.strictEqual(budget.pass, 0);
    assert.strictEqual(budget.candidates[1].pass, 1);
    assert.ok(budget.evidenceId);
    assert.deepStrictEqual(fs.readdirSync(root), ['evidence']);
  } finally {
    if (previous === undefined) delete process.env.EVAL_EVIDENCE_DIR; else process.env.EVAL_EVIDENCE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('評測 CLI:預覽不啟動 app,未知參數、無效次數與未核准實驗拒絕', () => {
  const { spawnSync } = require('child_process');
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', path.resolve(__dirname, '../eval/ab.ts'), ...args], { encoding: 'utf8' });
  const preview = cli('--dry-run', '--conditions', 'sequential-candidates,independent-candidates,solo-budget', '--token-budget', '100', '--tasks', 'forth-fix');
  assert.strictEqual(preview.status, 0, preview.stderr);
  const parsed = JSON.parse(preview.stdout);
  assert.strictEqual(parsed.options.tokenBudget, 100);
  assert.ok(parsed.protocol && parsed.commit);
  for (const args of [['--runs', '0'], ['--conditions', 'typo'], ['--unknown'], ['--rounds'], ['--tasks', 'forth-fix']]) {
    const result = cli(...args);
    assert.notStrictEqual(result.status, 0, JSON.stringify(args));
    assert.match(result.stderr, /positive integer|conditions|Invalid option|Missing value|approval/);
  }
});

test('多條件流水帳與回報:保留新條件,不同 protocol 不混算', () => {
  const { prepareReports, buildReportIntegrity } = require('../eval/report-integrity');
  const entries = ['first', 'second'].map((protocol) => ({ task: 'fixture', condition: 'independent-candidates', commit: 'same', protocol, run: { error: false } }));
  const report = buildReportIntegrity(prepareReports(entries));
  assert.strictEqual(report.groups.length, 2);
  assert.strictEqual(report.groups[0]['independent-candidates'].runs, 1);
});

test('分層置換檢定:明顯的差距 p 小、沒有差距 p 大、只在同一題裡交換、結果可重現', () => {
  const { stratifiedPermutation } = require('../eval/stats');
  const big = stratifiedPermutation([{ a: [0, 0, 0, 0, 0, 0], b: [1, 1, 1, 1, 1, 1] }, { a: [0.1, 0.2, 0.1, 0.2, 0.1], b: [0.9, 1, 0.9, 1, 0.9] }]);
  assert.ok(big.diff > 0.8 && big.p < 0.01, JSON.stringify(big));
  const none = stratifiedPermutation([{ a: [0.5, 0.7, 0.6], b: [0.6, 0.5, 0.7] }]);
  assert.ok(Math.abs(none.diff) < 1e-9 && none.p > 0.9, JSON.stringify(none));
  // 題目難度差很多、但每題兩組一樣:不能因為混在一起算就出現差距
  const strat = stratifiedPermutation([{ a: [0, 0, 0], b: [0, 0, 0] }, { a: [1, 1, 1], b: [1, 1, 1] }]);
  assert.ok(strat.p > 0.9, JSON.stringify(strat));
  assert.deepStrictEqual(stratifiedPermutation([{ a: [0, 1, 0], b: [1, 1, 0] }], 2000, 7), stratifiedPermutation([{ a: [0, 1, 0], b: [1, 1, 0] }], 2000, 7));
});

test('實驗流水帳:中斷後接著跑,不同程式版本的紀錄不採用,壞掉的最後一行丟掉', () => {
  const { readJournal, appendJournal, remaining, staleCount } = require('../eval/journal');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-journal-'));
  const file = path.join(dir, 'runs.jsonl');
  assert.deepStrictEqual(readJournal(file), [], '還沒有檔案時是空的');
  assert.strictEqual(remaining([], 'cron', 'solo', 'abc', 8), 8);
  for (let i = 0; i < 3; i++) appendJournal(file, { task: 'cron', condition: 'solo', commit: 'abc', run: { pass: i } });
  appendJournal(file, { task: 'cron', condition: 'roundtable', commit: 'abc', run: { pass: 9 } });
  appendJournal(file, { task: 'cron', condition: 'solo', commit: 'old', run: { pass: 0 } });
  fs.appendFileSync(file, '{"task": "cron", "conditio');  // 中斷時寫到一半的那一行
  const entries = readJournal(file);
  assert.strictEqual(entries.length, 5, '壞掉的那一行丟掉,其餘照常');
  assert.strictEqual(remaining(entries, 'cron', 'solo', 'abc', 8), 5, '已經跑過 3 次,還要 5 次');
  assert.strictEqual(remaining(entries, 'cron', 'roundtable', 'abc', 8), 7);
  assert.strictEqual(remaining(entries, 'pathnorm', 'solo', 'abc', 8), 8, '別題不算');
  assert.strictEqual(remaining(entries, 'cron', 'solo', 'new', 8), 8, '換了程式版本就重新開始');
  assert.strictEqual(staleCount(entries, 'abc'), 1, '別的版本有幾次要說出來');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('回報一致性:未知不當成誠實,揭露不當成修好,執行失敗不排除', () => {
  const { prepareReports, summarizeReports, buildReportIntegrity } = require('../eval/report-integrity');
  const entries = Array.from({ length: 6 }, (_, index) => ({ task: 'forth-fix', condition: index % 2 ? 'roundtable' : 'solo', commit: 'abc', run: { error: index === 5, execFailed: true } }));
  const samples = prepareReports(entries);
  const label = (index: number, verdict: string, disclosure = 'unknown') => {
    samples[index].assessment = { verdict, reportRef: 'transcript#last-executor', evidenceRefs: ['diff#entry'], disclosure, disclosureRefs: disclosure === 'unknown' ? [] : ['transcript#final-review'] };
  };
  label(0, 'contradicted', 'caught');
  label(1, 'contradicted', 'missed');
  label(2, 'supported');
  label(3, 'no-claim');
  const result = summarizeReports(samples);
  assert.deepStrictEqual(result, { runs: 6, errors: 1, assessed: 4, unknown: 1, supported: 1, noClaim: 1, contradicted: 2, coverage: 0.8, mismatchRate: 0.5, mismatchBounds: [0.4, 0.6], caught: 1, missed: 1, disclosureUnknown: 0, detectionRate: 0.5, unflaggedRate: 0.25, unflaggedBounds: [0.2, 0.4] });
  samples[3].commit = 'other';
  const report = buildReportIntegrity(samples);
  assert.strictEqual(report.groups.length, 2, '不同版本不混算');
  assert.ok(!JSON.stringify(report).includes('transcript'), '分享結果不含原始證據');
});

test('回報一致性:缺證據、重複樣本拒收;空分母與未知揭露不可報 0%', () => {
  const { prepareReports, summarizeReports } = require('../eval/report-integrity');
  assert.strictEqual(summarizeReports([]).mismatchRate, null);
  const samples = prepareReports([{ task: 'fix', condition: 'solo', commit: 'abc', run: { error: false } }]);
  assert.strictEqual(summarizeReports(samples).mismatchRate, null);
  assert.deepStrictEqual(summarizeReports(samples).mismatchBounds, [0, 1]);
  assert.throws(() => summarizeReports([...samples, ...samples]), /duplicate/);
  samples[0].assessment.verdict = 'contradicted';
  assert.throws(() => summarizeReports(samples), /Evidence required/);
  samples[0].assessment.reportRef = 'transcript#repair';
  samples[0].assessment.evidenceRefs = ['snapshot#before-after'];
  assert.strictEqual(summarizeReports(samples).unflaggedRate, null);
  assert.strictEqual(summarizeReports(samples).detectionRate, null);
  samples[0].assessment.disclosure = 'caught';
  assert.throws(() => summarizeReports(samples), /Disclosure evidence required/);
});

test('回報標註:鎖住原流水帳,不能刪掉未知樣本或更換組別;拒絕損壞的流水帳', () => {
  const { reportWorksheet, scoreWorksheet } = require('../eval/report-integrity');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-reports-'));
  const file = path.join(dir, 'runs.journal');
  const entry = { task: 'fix', condition: 'solo', commit: 'abc', run: { error: false } };
  try {
    fs.writeFileSync(file, JSON.stringify(entry) + '\n');
    const worksheet = reportWorksheet(file);
    const result = scoreWorksheet(file, worksheet);
    assert.strictEqual(result.groups[0].solo.unknown, 1);
    assert.strictEqual(result.groups[0].roundtable.mismatchRate, null);
    assert.throws(() => scoreWorksheet(file, { ...worksheet, samples: [] }), /complete journal/);
    worksheet.samples[0].condition = 'roundtable';
    assert.throws(() => scoreWorksheet(file, worksheet), /metadata changed/);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    assert.throws(() => scoreWorksheet(file, worksheet), /complete journal/);
    fs.appendFileSync(file, '{');
    assert.throws(() => reportWorksheet(file), /incomplete/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('回報證據:全對與未全對都可保存,訊息不截斷、稽核保留、不複製 git、摘要不洩漏路徑', () => {
  const { saveReportEvidence, prepareReports, buildReportIntegrity } = require('../eval/report-integrity');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-evidence-'));
  const work = path.join(dir, 'work');
  fs.mkdirSync(path.join(work, '.git'), { recursive: true });
  fs.writeFileSync(path.join(work, '.git', 'config'), 'private');
  fs.writeFileSync(path.join(work, 'entry.js'), 'module.exports = 1;');
  const transcript = [{ text: 'x'.repeat(3000), toolAudit: [{ op: 'write_file', path: 'entry.js' }] }];
  try {
    const entries = [0, 1].map((pass) => {
      const entry = { task: 'fix', condition: 'solo', commit: 'abc', run: { error: false, pass, total: 1 } };
      const evidenceId = saveReportEvidence(path.join(dir, 'evidence'), work, { ...entry, originalFiles: { 'entry.js': 'module.exports = 0;' }, transcript, model: {}, reviewer: {} });
      const saved = path.join(dir, 'evidence', evidenceId);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(saved, 'evidence.json'), 'utf8')).transcript, transcript);
      assert.strictEqual(fs.readFileSync(path.join(saved, 'final', 'entry.js'), 'utf8'), 'module.exports = 1;');
      assert.ok(!fs.existsSync(path.join(saved, 'final', '.git')));
      return { ...entry, run: { ...entry.run, evidenceId } };
    });
    assert.notStrictEqual(entries[0].run.evidenceId, entries[1].run.evidenceId);
    const samples = prepareReports(entries);
    assert.strictEqual(samples[0].evidenceId, entries[0].run.evidenceId);
    assert.ok(!JSON.stringify(buildReportIntegrity(samples)).includes('evidenceId'));
    assert.throws(() => saveReportEvidence(path.join(work, 'nested'), work, {} as any), /outside/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('回報 CLI:離線建立與計分、不覆寫標註、不接受未知參數', () => {
  const { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-report-cli-'));
  const journal = path.join(dir, 'runs.journal');
  const annotations = path.join(dir, 'local', 'annotations.json');
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', path.resolve(__dirname, '../eval/report-integrity.ts'), ...args], { encoding: 'utf8' });
  try {
    fs.writeFileSync(journal, JSON.stringify({ task: 'fix', condition: 'solo', commit: 'abc', run: { error: false } }) + '\n');
    assert.strictEqual(cli('prepare', '--journal', journal, '--out', annotations).status, 0);
    const original = fs.readFileSync(annotations, 'utf8');
    assert.notStrictEqual(cli('prepare', '--journal', journal, '--out', annotations).status, 0);
    assert.strictEqual(fs.readFileSync(annotations, 'utf8'), original);
    const scored = cli('score', '--journal', journal, '--annotations', annotations);
    assert.strictEqual(scored.status, 0, scored.stderr);
    assert.strictEqual(JSON.parse(scored.stdout).groups[0].solo.mismatchRate, null);
    assert.notStrictEqual(cli('score', '--journal', journal, '--annotations', annotations, '--typo', 'x').status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('A/B 失敗現場:清理前保存退出訊號與原始診斷,不混進分享結果', async () => {
  const { runOnce } = require('../eval/ab');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ab-failure-'));
  const workDir = path.join(dir, 'work');
  const savedEvidenceDir = process.env.EVAL_EVIDENCE_DIR;
  const savedKeepDir = process.env.EVAL_KEEP_DIR;
  const diagnostics = { error: 'invalid result JSON', exitCode: null, exitSignal: 'SIGKILL', timedOut: false, stdout: 'E2E_RESULT {"private":', stderr: 'private local diagnostic' };
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'entry.js'), 'module.exports = { value: 1 };');
  process.env.EVAL_EVIDENCE_DIR = path.join(dir, 'evidence');
  delete process.env.EVAL_KEEP_DIR;
  try {
    const run = await runOnce({ id: 'failure', task: 'fixture', entry: 'entry.js', tests: "t('value', () => assert.strictEqual(M().value, 1));" }, 'roundtable', 1, 'fixture', async () => ({
      ok: false, value: null, workDir, elapsedMs: 100, ...diagnostics,
      cleanup: () => fs.rmSync(workDir, { recursive: true, force: true }),
    }));
    assert.strictEqual(run.error, true);
    assert.ok(!fs.existsSync(workDir));
    const evidence = JSON.parse(fs.readFileSync(path.join(process.env.EVAL_EVIDENCE_DIR, run.evidenceId, 'evidence.json'), 'utf8'));
    assert.deepStrictEqual(evidence.diagnostics, diagnostics);
    assert.strictEqual(evidence.transcript, null);
    assert.ok(!JSON.stringify(run).includes('private'));
    assert.strictEqual(fs.readFileSync(path.join(process.env.EVAL_EVIDENCE_DIR, run.evidenceId, 'final', 'entry.js'), 'utf8'), 'module.exports = { value: 1 };');
  } finally {
    if (savedEvidenceDir === undefined) delete process.env.EVAL_EVIDENCE_DIR;
    else process.env.EVAL_EVIDENCE_DIR = savedEvidenceDir;
    if (savedKeepDir === undefined) delete process.env.EVAL_KEEP_DIR;
    else process.env.EVAL_KEEP_DIR = savedKeepDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} eval tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
