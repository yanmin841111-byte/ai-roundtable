'use strict';

// 情境:反例在「真的 app 裡」跑不跑得起來,判定方向對不對(見 src/counterexample.ts)。
//
// 這個情境存在的理由和 verify.ts 是同一個,而且是同一個坑:反例用 process.execPath 開子行程,
// 在 app 裡那是 Electron 不是 node。少了 ELECTRON_RUN_AS_NODE,腳本不會被當成 node 腳本執行,
// 而在這裡「非零結束碼」的意思是**問題確認了**——所以那個 bug 的後果是每一條反例都被誣賴成真的,
// 然後派人去修一個不存在的問題。單元測試在純 node 底下跑,永遠抓不到這件事。
// 實驗 5 的第一次 48 跑就是被這一類誤判作廢的(見 eval/EXPERIMENTS.md)。
//
// 一併驗:確認過的反例有沒有真的存進專案的語料庫(src/corpus.ts)。

import fs from 'fs';
import path from 'path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { runApp, report } from '../app';
import { scriptedMember } from '../fixtures';
import { saveLiveEvidence } from './copilot-live';
import { createHash } from 'node:crypto';

// 審查者的回覆:一段文字意見,加上兩個反例——一個真的會失敗、一個不會。
// 兩個都放是刻意的:只放會失敗的那個,測不出「判定方向有沒有反」。
const REVIEW = [
  'sum 的加法寫反了,兩個正數會得到負的結果。',
  '',
  '```counterexample 1 + 1 應該是 2',
  "const assert = require('assert');",
  "assert.strictEqual(require('./sum.js')(1, 1), 2);",
  '```',
  '',
  '```counterexample 0 + 0 應該是 0',
  "const assert = require('assert');",
  "assert.strictEqual(require('./sum.js')(0, 0), 0);",
  '```',
  '',
  '```counterexample invalid JavaScript probe',
  '檢查 completedDeps 未使用',
  '```',
].join('\n');

async function main() {
  if (process.argv.includes('--live-partition')) return partitionCases(true);
  if (process.argv.includes('--partition-only')) return partitionCases();
  const r = await runApp({
    members: [
      // 審查者由 pickReviewPairs 從其他啟用成員裡挑,這裡兩位都給同一份回覆,
      // 情境才不會依賴「挑中的是哪一位」這個實作細節
      scriptedMember({
        id: 'lead', name: '主持人', review: REVIEW, recheck: '這次對了\n[NO_ISSUES]',
        plan: { summary: '寫一個加法', assignments: [{ agent: '執行者', task: '建立 sum.js,匯出 (a, b) => a + b' }] },
      }),
      scriptedMember({
        id: 'exec', name: '執行者', canEdit: true,
        // 減號:1 + 1 會得到 0,所以第一個反例失敗、第二個(0 + 0)照樣通過
        writes: { 'sum.js': 'module.exports = (a, b) => a - b;\n' },
        report: '已建立 sum.js',
        // 修復回合把它改對:反例應該從失敗變成通過,而且由 app 自己跑出來確認
        fixWrites: { 'sum.js': 'module.exports = (a, b) => a + b;\n' },
        fixReport: '已把減號改成加號',
      }),
      scriptedMember({ id: 'rev', name: '審查者', review: REVIEW, recheck: '這次對了\n[NO_ISSUES]' }),
    ],
    settings: { workStyle: 'code' },
    timeoutMs: 3 * 60 * 1000,
    scenario: async () => {
      const g: any = globalThis;
      await g.ready();
      const msgs = await g.send('請寫一個加法', 'divide');
      const ce = msgs.filter((m: any) => m.kind === 'system' && m.tag === 'counterexample');
      g.check(ce.length > 0, '有反例的系統訊息');
      const text = ce.map((m: any) => m.text).join('\n');

      // 判定方向:會失敗的那個才算確認,不會失敗的那個要被標成「不成立」。
      // 這兩條一起過,才證明反例真的被當成 node 腳本跑了。
      g.check(/1 \+ 1 應該是 2/.test(text), `會失敗的反例要被指名(${text.slice(0, 300)})`);
      const confirmed = ce.find((m: any) => /個反例失敗且仍保留為修復門檻/.test(m.text));
      g.check(!!confirmed && /1 \+ 1 應該是 2/.test(confirmed.text), '1+1 那個要列在「確認」裡');
      g.check(!!confirmed && !/0 \+ 0 應該是 0/.test(confirmed.text), '0+0 那個不可以被算成確認');
      const unsub = ce.find((m: any) => /沒有重現問題/.test(m.text));
      g.check(!!unsub && /0 \+ 0 應該是 0/.test(unsub.text), '0+0 那個要被標成不成立');
      const unusable = ce.find((m: any) => /反例本身跑不起來/.test(m.text));
      g.check(!!unusable && /invalid JavaScript probe/.test(unusable.text), 'invalid probe is reported as unusable');
      g.check(!/1 \+ 1 應該是 2|0 \+ 0 應該是 0/.test(unusable.text), 'valid probes still execute under Electron');
      g.check(!/invalid JavaScript probe/.test(confirmed.text), 'invalid probe is not confirmed');

      // 修復之後 app 自己重跑,確認它從失敗變成通過
      const improved = msgs.find((m: any) => m.kind === 'system' && /從不通過變成通過/.test(m.text || ''));
      g.check(!!improved && /1 \+ 1 應該是 2/.test(improved.text), `修好之後要量到改善(${improved?.text?.slice(0, 200)})`);

      const card = msgs.find((m: any) => m.tag === 'task-summary');
      g.check(!!card, '有結果卡');
      g.check(!card.taskSummary.rollback, `沒有退步就不該回退(${JSON.stringify(card.taskSummary.rollback)})`);
      const evidence = card.taskSummary.counterexamples || [];
      const confirmedEvidence = evidence.find((item: any) => item.title === '1 + 1 應該是 2');
      const unsubstantiatedEvidence = evidence.find((item: any) => item.title === '0 + 0 應該是 0');
      const invalidEvidence = evidence.find((item: any) => item.title === 'invalid JavaScript probe');
      g.check(invalidEvidence?.confirmation === 'unusable' && /SyntaxError/.test(invalidEvidence.output), 'result card retains invalid probe evidence without confirming it');
      g.check(confirmedEvidence?.confirmation === 'confirmed' && confirmedEvidence?.afterRepair === 'passed', `結果卡保存確認與修復後狀態(${JSON.stringify(evidence)})`);
      g.check(unsubstantiatedEvidence?.confirmation === 'unsubstantiated', `結果卡保存不成立的反例(${JSON.stringify(evidence)})`);
      await g.w(300);
      const resultCard = document.querySelector('#timeline .task-summary') as HTMLElement | null;
      const resultText = resultCard?.querySelector('.ts-evidence')?.textContent || '';
      g.check(/反例證據/.test(resultText) && /1 \+ 1 應該是 2/.test(resultText) && /已確認/.test(resultText) && /修復後通過/.test(resultText), `結果卡畫面顯示已修復的反例(${resultText.slice(-500)})`);
      g.check(/0 \+ 0 應該是 0/.test(resultText) && /不成立/.test(resultText), `結果卡畫面顯示不成立的反例(${resultText.slice(-500)})`);
      g.check(!msgs.some((m: any) => m.kind === 'system' && /有關卡從通過變成不通過/.test(m.text || '')), '不可以報告不存在的退步');
      // 語料庫與反例腳本都不可以被算成成員的改動
      const files = (card.taskSummary.files || []).map((f: any) => f.path);
      g.check(!files.some((f: string) => f.startsWith('.roundtable')), `檔案改動不該有 app 自己的檔案(${files.join(', ')})`);
      return { text: text.slice(0, 400), files };
    },
  });
  if (!report('反例與語料庫', r)) process.exitCode = 1;

  // 磁碟上的事實:修好了,而且確認過的反例留進了專案的語料庫
  const sum = r.read('sum.js');
  console.log(/a \+ b/.test(sum || '') ? '  ok - 磁碟上的 sum.js 已修好' : `  失敗:sum.js 仍是 ${JSON.stringify(sum)}`);
  const corpusFile = path.join(r.workDir, '.roundtable', 'counterexamples.json');
  const corpus = fs.existsSync(corpusFile) ? JSON.parse(fs.readFileSync(corpusFile, 'utf8')) : [];
  const titles = corpus.map((e: any) => e.title);
  console.log(titles.includes('1 + 1 應該是 2') ? '  ok - 確認過的反例已存進語料庫' : `  失敗:語料庫裡是 ${JSON.stringify(titles)}`);
  console.log(!titles.includes('0 + 0 應該是 0') ? '  ok - 不成立的反例沒有被收進語料庫' : '  失敗:不成立的反例被收進語料庫了');
  console.log(!titles.includes('invalid JavaScript probe') ? '  ok - invalid probe is excluded from the corpus' : '  failure: invalid probe entered the corpus');
  // 反例腳本是一次性的,不可以留在工作目錄裡被當成成員的改動
  const leftovers = fs.readdirSync(r.workDir).filter((f: string) => f.startsWith('.roundtable-ce-'));
  console.log(leftovers.length === 0 ? '  ok - 反例腳本沒有留在工作目錄' : `  失敗:留下 ${leftovers.join(', ')}`);
  if (!/a \+ b/.test(sum || '') || !titles.includes('1 + 1 應該是 2') || titles.includes('0 + 0 應該是 0') || titles.includes('invalid JavaScript probe') || leftovers.length) process.exitCode = 1;
  await partitionCases();
}

const PARTITION_CASES = [
  {
    name: 'sum', file: 'subject.js',
    task: 'Export sum(values) from subject.js. Return the sum of every finite number, including negative numbers; an empty array returns 0. Do not mutate inputs.',
    before: 'exports.sum = values => values.slice(1).reduce((total, value) => total + value, 0);\n',
    after: 'exports.sum = values => values.reduce((total, value) => total + value, 0);\n',
    probe: 'require("assert/strict").equal(require("./subject").sum([1, 2]), 3);',
    check: 'const {sum} = require("./subject"); for (const [values, expected] of [[[],0], [[9],9], [[-2,5,-1],2], [[0.5,1.25],1.75]]) assert.equal(sum(Object.freeze(values)), expected);',
  },
  {
    name: 'stable-unique', file: 'subject.js',
    task: 'Export unique(values) from subject.js. Return each string once in first-appearance order, with case-sensitive equality. Do not mutate inputs.',
    before: 'exports.unique = values => [...new Set(values)].sort();\n',
    after: 'exports.unique = values => [...new Set(values)];\n',
    probe: 'require("assert/strict").deepEqual(require("./subject").unique(["b", "a", "b"]), ["b", "a"]);',
    check: 'const {unique} = require("./subject"); for (const [values, expected] of [[[],[]], [["Z","a","Z","A"],["Z","a","A"]], [["constructor","__proto__","constructor"],["constructor","__proto__"]]]) assert.deepEqual(unique(Object.freeze(values)), expected);',
  },
  {
    name: 'json-cli', file: 'cli.js',
    task: 'cli.js reads one JSON array of finite numbers from stdin and prints its sum plus a newline. Invalid JSON, wrong input types and non-finite values must produce nonzero exit, no stdout, and a useful error without an uncaught stack trace.',
    before: 'const values = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(values.reduce((total, value) => total + value, 0));\n',
    after: 'try { const values = JSON.parse(require("fs").readFileSync(0, "utf8")); if (!Array.isArray(values) || !values.every(value => typeof value === "number" && Number.isFinite(value))) throw new Error("Expected finite numbers"); console.log(values.reduce((total, value) => total + value, 0)); } catch { console.error("Invalid numeric array"); process.exitCode = 1; }\n',
    probe: 'const result = require("child_process").spawnSync(process.execPath, ["cli.js"], {input:"[1,\\"2\\"]", encoding:"utf8", timeout:5000}); require("assert/strict").notEqual(result.status, 0);',
    check: 'const {spawnSync} = require("child_process"); for (const [input, output] of [["[]","0\\n"],["[-2,5,0.5]","3.5\\n"]]) { const result = spawnSync(process.execPath, ["cli.js"], {input, encoding:"utf8", timeout:5000}); assert.equal(result.status,0); assert.equal(result.stdout,output); assert.equal(result.stderr,""); } for (const input of ["", "{", "{}", "null", "[true]", "[1,\\"2\\"]", "[1e999]"]) { const result = spawnSync(process.execPath, ["cli.js"], {input, encoding:"utf8", timeout:5000}); assert.equal(result.error,undefined); assert.notEqual(result.status,0); assert.equal(result.stdout,""); assert.ok(result.stderr.trim()); assert.doesNotMatch(result.stderr,/\\n\\s+at /); }',
  },
];

async function partitionCases(live = false) {
  const models = ['gpt-5-mini', 'claude-haiku-4.5', 'gpt-5.4-mini'];
  const hash = createHash('sha256');
  for (const file of ['dist/src/orchestrator.js', 'dist/src/counterexample.js', 'dist/src/text.js', __filename]) hash.update(fs.readFileSync(file));
  const stages = 'This is a staged inspection-and-repair task. Stage 1 (execute): Author reads the existing implementation and reports its behavior without editing. Stage 2: Lead and Reviewer run and assess counterexamples. Stage 3 (repair): the app assigns Author confirmed defects, authorizing changes to the implementation then. Stage 4: the app runs verification and reviewers recheck. Existing implementation defects are expected; evaluate whether this staged plan is feasible, not whether the current implementation already satisfies final acceptance.';
  const policy = { sourceHash: hash.digest('hex'), models, stages, tasks: PARTITION_CASES.map(({ name, task, check }) => ({ name, task, check })), scope: 'Scripted assessments with a real repair author; not an end-to-end model quality estimate.' };
  if (live && process.argv.includes('--dry-run')) { console.log(JSON.stringify(policy, null, 2)); return; }
  const destination = process.env.COPILOT_EVIDENCE_DIR;
  if (live) {
    if (process.env.COPILOT_LIVE !== '1' || !destination) throw new Error('COPILOT_LIVE=1 and a new COPILOT_EVIDENCE_DIR are required');
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(policy, null, 2), { flag: 'wx' });
  }
  const records: Array<{ name: string; model: string; passed: boolean; error?: string }> = [];
  for (const locale of live ? ['en'] as const : ['zh-Hant', 'en'] as const) {
    for (const sample of PARTITION_CASES) {
      const model = models[PARTITION_CASES.indexOf(sample)];
      let headBefore = '';
      const task = `${sample.task} Keep policy.json unchanged; its display convention is outside this task.${live ? ` ${stages}` : ''}`;
      const retained = JSON.stringify({ decision: 'retain_counterexample', expectationContradictsRequirement: false, requirement: sample.task, reason: 'The probe demonstrates a violation of the requested behavior.' });
      const uncertain = JSON.stringify({ decision: 'uncertain_counterexample', expectationContradictsRequirement: false, requirement: '', reason: 'The display convention is not specified.' });
      const pending = 'require("assert/strict").equal(require("./policy.json").style, "disputed");';
      const review = `Unverified suggestion: change policy.json.\n\`\`\`counterexample confirmed behavior\n${sample.probe}\n\`\`\`\n\`\`\`counterexample unspecified policy\n${pending}\n\`\`\``;
      const result = await runApp({
        members: [
          scriptedMember({ id: 'lead', name: 'Lead', canEdit: false, plan: { summary: sample.name, assignments: [{ agent: 'A2', task }], acceptance: [sample.task] }, counterexampleReviews: [retained, uncertain] }),
          live ? { id: 'author', name: 'Author', cli: 'copilot', model, canEdit: true } : scriptedMember({ id: 'author', name: 'Author', canEdit: true, writes: { [sample.file]: sample.before }, report: 'Initial implementation ready', fixWrites: { [sample.file]: sample.after }, fixReport: 'Corrected only the confirmed behavior.' }),
          scriptedMember({ id: 'reviewer', name: 'Reviewer', canEdit: false, review, recheck: '[NO_ISSUES]', counterexampleReviews: [retained, retained] }),
        ],
        files: { [sample.file]: sample.before, 'policy.json': '{"style":"existing"}\n' },
        git: true,
        beforeLaunch: ({ workDir }) => { headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workDir, encoding: 'utf8' }); },
        settings: { leadAgentId: 'lead', workStyle: 'code', mode: 'guarded', maxRounds: live ? 2 : 1, uiLocale: locale, language: locale === 'en' ? 'English' : '繁體中文', verifyCommand: `node --check ${sample.file}` },
        constants: { task, locale, name: sample.name, live },
        scenario: async (context: any) => {
          const app: any = globalThis;
          await app.ready();
          const messages = await app.send(context.task, 'guarded');
          const summaryMessage = [...messages].reverse().find((message: any) => message.taskSummary);
          const summary = summaryMessage?.taskSummary;
          if (context.live) {
            await app.shot(`partition-live-${context.name}`);
            return { guard: summary?.guard, summary, messages };
          }
          app.check(summary?.guard.status === 'blocked' && summary.guard.repairRounds === 1, 'Confirmed repair proceeds once, while pending evidence blocks approval');
          app.check(summary.counterexamples.some((item: any) => item.title === 'confirmed behavior' && item.confirmation === 'confirmed' && item.afterRepair === 'passed'), 'The app re-executes and passes the confirmed probe');
          app.check(summary.counterexamples.some((item: any) => item.title === 'unspecified policy' && item.confirmation === 'pending' && !item.afterRepair), 'Pending evidence is not promoted by successful repair');
          app.check(messages.filter((message: any) => message.kind === 'agent' && message.phase?.code === 'repair').length === 1, 'No repeated repair for unresolved policy');
          const card = document.querySelector(`#timeline [data-msg-id="${summaryMessage.id}"] .task-summary`) as HTMLElement;
          app.check(card.textContent?.includes(context.locale === 'en' ? 'Requirement assessment unresolved' : '需求判定待釐清'), 'Result card shows the unresolved evidence');
          app.check(card.scrollWidth <= card.clientWidth + 1, 'Evidence card does not overflow');
          card.scrollIntoView({ block: 'center' });
          await app.shot(`partition-${context.name}-${context.locale}`);
          return { guard: summary.guard, summary, messages };
        },
      });
      let failure: string | undefined;
      const checks: Array<{ name: string; passed: boolean; error?: string }> = [];
      const check = (name: string, verify: () => void) => {
        try { verify(); checks.push({ name, passed: true }); }
        catch (error) { checks.push({ name, passed: false, error: String(error) }); }
      };
      try {
        check('harness', () => assert.ok(report(`Mixed evidence ${sample.name} ${locale}${live ? ` ${model}` : ''}`, { ...result, value: { guard: result.value?.guard } })));
        check('approval blocked', () => assert.equal(result.value?.guard?.status, 'blocked'));
        check('one repair round', () => assert.equal(result.value?.guard?.repairRounds, 1));
        check('confirmed probe repaired', () => assert.ok(result.value?.summary?.counterexamples?.some((item: any) => item.title === 'confirmed behavior' && item.confirmation === 'confirmed' && item.afterRepair === 'passed')));
        check('pending probe preserved', () => assert.ok(result.value?.summary?.counterexamples?.some((item: any) => item.title === 'unspecified policy' && item.confirmation === 'pending' && !item.afterRepair)));
        check('one repair turn', () => assert.equal(result.value?.messages?.filter((message: any) => message.kind === 'agent' && message.phase?.code === 'repair').length, 1));
        check('no turn errors', () => assert.ok(!result.value?.messages?.some((message: any) => message.error)));
        if (!live) check('scripted output', () => assert.equal(result.read(sample.file), sample.after));
        check('policy unchanged', () => assert.equal(result.read('policy.json'), '{"style":"existing"}\n'));
        check('independent acceptance', () => { execFileSync(process.execPath, ['-e', `const assert = require('assert/strict'); ${sample.check}`], { cwd: result.workDir, timeout: 15000, stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' } }); });
        check('confirmed-only corpus', () => assert.deepEqual(JSON.parse(result.read('.roundtable/counterexamples.json')!).map((item: any) => item.title), ['confirmed behavior']));
        check('owned diff', () => assert.deepEqual(execFileSync('git', ['diff', '--name-only'], { cwd: result.workDir, encoding: 'utf8' }).trim().split('\n'), [sample.file]));
        check('HEAD unchanged', () => assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: result.workDir, encoding: 'utf8' }), headBefore));
        check('no extra artifacts', () => {
          const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: result.workDir, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
          assert.deepEqual(untracked.filter(file => file !== '.roundtable/counterexamples.json'), []);
        });
        assert.ok(checks.every(item => item.passed), checks.filter(item => !item.passed).map(item => `${item.name}: ${item.error}`).join('\n'));
        console.log(`  ok - independent ${sample.name} acceptance, unchanged policy, owned diff and corpus`);
      } catch (error) {
        failure = String(error);
        if (!live) throw error;
        process.exitCode = 1;
        console.error(`  FAIL ${sample.name}: ${failure}`);
      } finally {
        if (live) {
          records.push({ name: sample.name, model, passed: !failure, ...(failure ? { error: failure } : {}) });
          saveLiveEvidence(result, 'partition-evidence.json', { ...policy, passed: !failure, error: failure, checks, elapsedMs: result.elapsedMs, result: result.value, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut, harnessError: result.error }, path.join(destination!, sample.name));
          fs.writeFileSync(path.join(destination!, 'summary.json'), JSON.stringify({ planned: PARTITION_CASES.length, completed: records.length, passed: records.filter(record => record.passed).length, records }, null, 2));
        }
        result.cleanup();
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
