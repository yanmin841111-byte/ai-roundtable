'use strict';

// 情境:自動驗證在「真的 app 裡」有沒有真的檢查語法。
//
// 這個情境存在的理由是一個實際發生過的 bug:語法檢查用 process.execPath 開子行程,
// 而在 app 裡那是 Electron 不是 node,少了 ELECTRON_RUN_AS_NODE 就變成「執行那個檔案」——
// 有語法錯誤的檔案被判通過,成員寫的測試檔反而被跑起來。單元測試在純 node 底下跑,永遠抓不到。

import fs from 'fs';
import path from 'path';
import { runApp, report } from '../app';
import { scriptedMember } from '../fixtures';

async function main() {
  const r = await runApp({
    members: [
      scriptedMember({ id: 'lead', name: '主持人', plan: { summary: '建立檔案', assignments: [{ agent: '執行者', task: '建立 broken.js、fine.js 與 esm.js' }] } }),
      scriptedMember({
        id: 'exec', name: '執行者', canEdit: true,
        // broken.js 有語法錯誤;side-effect.js 會「執行到就留下痕跡」,用來確認檢查沒有真的執行它
        writes: {
          'broken.js': 'function x( {\n  return 1;\n}\n',
          'fine.js': 'module.exports = { ok: true };\n',
          // ESM 寫法的 .js:Electron 內建的 Node 比開發機舊,預設不會去猜這是 ES module,
          // 一路照 CommonJS 解析就會判成「Unexpected token 'export'」。這個檔沒有壞。
          'esm.js': 'import fs from "fs";\nexport const ok = !!fs;\n',
          'side-effect.js': "require('fs').writeFileSync(__dirname + '/../ran.txt', 'executed');\n",
        },
        report: '已建立檔案',
      }),
    ],
    settings: { workStyle: 'code' },
    timeoutMs: 3 * 60 * 1000,
    scenario: async () => {
      const g: any = globalThis;
      await g.ready();
      const msgs = await g.send('請建立檔案', 'divide');
      const verify = msgs.filter((m: any) => m.kind === 'system' && m.tag === 'verify');
      g.check(verify.length > 0, '有自動驗證的訊息');
      const text = verify.map((m: any) => m.text).join('\n');
      g.check(/自動驗證沒過/.test(text), `語法錯誤的檔案要被抓到(${text.slice(0, 200)})`);
      g.check(/broken\.js/.test(text), 'broken.js 要被指名');
      g.check(!/fine\.js/.test(text), '正常的檔案不能被誤報');
      g.check(!/esm\.js/.test(text), 'ESM 寫法的 .js 不能被誤報成語法錯誤');
      // 訊息會進對話紀錄與匯出,不留這台機器的路徑(macOS 的 /private 半截也不行)
      g.check(/`broken\.js`:broken\.js:\d/.test(text), `錯誤訊息裡的檔名是相對路徑(${text.slice(0, 160)})`);
      const card = msgs.find((m: any) => m.tag === 'task-summary');
      g.check(!!card && card.taskSummary && card.taskSummary.verify === 'none', `回退後沒有留下待驗檔案(${card?.taskSummary?.verify})`);
      g.check(card.taskSummary.rollback?.scope === 'task' && card.taskSummary.rollback?.status === 'complete', '已自動回退整個任務');
      g.check(card.taskSummary.members.every((member: any) => member.outcome === 'unresolved'), '回退不代表任務已完成');
      g.check(card.taskSummary.files.length === 0 && card.taskSummary.moreFiles === 0, '結果卡不再把已撤回的檔案算成交付');
      g.check(msgs.some((message: any) => message.tag === 'revert'), '回退結果保留在紀錄中');
      g.check(!/✓ 審查通過/.test(card.text), `回退後仍不能寫審查通過(${card.text.slice(0, 120)})`);
      // 介面上選得到工作模式,而且切換會存起來
      const style = document.querySelector('#work-style') as HTMLSelectElement;
      g.check(!!style && style.value === 'code', `輸入框旁有工作模式選單(${style && style.value})`);
      g.check(Array.from(style.options).map((o) => o.value).sort().join(',') === 'code,general', '兩種工作模式都在選單裡');
      style.value = 'general';
      style.dispatchEvent(new Event('change'));
      await g.w(300);
      const saved = await (window as any).api.getConfig();
      g.check(saved.settings.workStyle === 'general', `切換後存進設定(${saved.settings.workStyle})`);
      return { text: text.slice(0, 400) };
    },
  });
  report('自動驗證', r);
  const ran = fs.existsSync(path.join(r.tmp, 'ran.txt'));
  const reverted = ['broken.js', 'fine.js', 'esm.js', 'side-effect.js'].every((file) => r.read(file) === null);
  console.log(!ran ? '  ok - 語法檢查沒有執行檔案(回退範圍外也沒有 ran.txt)' : '  失敗:語法檢查把檔案執行了');
  console.log(reverted ? '  ok - 磁碟確認本次新增檔案已撤回' : '  失敗:磁碟仍留下本次新增檔案');
  r.cleanup();
  if (!r.ok || ran || !reverted) process.exitCode = 1;
}

async function solo(caseName: 'clean' | 'repair' | 'test-change') {
  const test = "require('node:assert/strict').equal(require('./answer'), 2);\n";
  const target = 'answer.js';
  const r = await runApp({
    members: [
      scriptedMember({ id: 'readonly', name: 'Lead' }),
      scriptedMember({
        id: 'writer', name: 'Writer', canEdit: true,
        writes: caseName === 'test-change' ? { 'answer.test.cjs': '/* bypassed */\n' }
          : { [target]: caseName === 'repair' ? 'module.exports = 3;\n' : 'module.exports = 2;\n' },
        fixWrites: { [target]: 'module.exports = 2;\n' },
      }),
    ],
    files: { [target]: caseName === 'clean' ? 'module.exports = 1 + 1;\n' : `module.exports = ${caseName === 'repair' ? 1 : 2};\n`, 'answer.test.cjs': test },
    git: true,
    settings: { workStyle: 'code', mode: 'solo', uiLocale: 'en', verifyCommand: 'node answer.test.cjs' },
    constants: { caseName },
    scenario: async (H) => {
      const g: any = globalThis;
      await g.ready();
      g.check(g.$('#mode').value === 'solo' && g.$('#mode option[value=solo]').textContent === 'Quick implementation', 'composer shows localized quick mode');
      const messages = await g.send('Set the answer to 2 without changing the existing test.', g.$('#mode').value);
      const turns = messages.filter((m: any) => m.kind === 'agent');
      const phases = turns.map((m: any) => m.phase?.code).join(',');
      const summary = messages.find((m: any) => m.tag === 'task-summary')?.taskSummary;
      g.check(turns.every((m: any) => m.agentName === 'Writer'), 'read-only lead does not take a turn');
      g.check(phases === (H.caseName === 'repair' ? 'execute,repair' : 'execute'), 'no planning, review or summary model turn');
      g.check(summary?.verify === 'passed' && !summary.guard && !summary.members[0].reviewers.length, 'result reports verification, not AI approval');
      if (H.caseName === 'repair') {
        g.check(messages.some((m: any) => m.tag === 'verify' && m.text.includes('Automatic verification failed')), 'initial gate failure is visible');
      }
      if (H.caseName === 'test-change') {
        g.check(summary.testsTouched && summary.rollback?.scope === 'task' && summary.rollback.status === 'complete', 'modified pre-existing test triggers rollback');
        g.check(summary.members[0].outcome === 'unresolved', 'rollback does not report delivery');
      }
    },
  });
  try {
    const diskOk = r.read(target) === 'module.exports = 2;\n' && r.read('answer.test.cjs') === test
      && r.numstat() === (caseName === 'test-change' ? '' : '1\t1\tanswer.js');
    if (!report(`Solo verification: ${caseName}`, r) || !diskOk) {
      if (!diskOk) console.error('Disk contents or git diff disagree with expected solo result');
      process.exitCode = 1;
    }
  } finally { r.cleanup(); }
}

async function intentWorkflow() {
  const r = await runApp({
    members: [scriptedMember({ id: 'writer', name: 'Writer', canEdit: true, writes: { 'answer.js': 'module.exports = 2;\n' },
      testWrites: { 'answer.test.cjs': 'require("assert").strictEqual(require("./answer"),2);\n' } }),
      scriptedMember({ id: 'reviewer', name: 'Reviewer', review: 'Prefer a different variable name.' })],
    files: { 'answer.js': 'module.exports = 1;\n', 'package.json': '{"scripts":{"test":"node answer.test.cjs"}}' },
    settings: { mode: 'solo', workStyle: 'code', uiLocale: 'en', discussionMode: 'independent-first' },
    scenario: async () => {
      const g: any = globalThis;
      await g.ready();
      const choose = (value: string) => {
        g.$('#mode').value = value;
        g.$('#mode').dispatchEvent(new Event('change'));
      };
      g.check([...g.$('#mode').options].filter(o => !o.hidden).length === 3, 'composer offers three workflow intents');
      await g.waitFor(() => !g.$('#composer-verify-action').hidden && g.$('#composer-verify-action').textContent.includes('npm test'), 5000, 'detected command is offered on composer');
      g.$('#composer-verify-action').click();
      await g.waitFor(() => g.$('#composer-verify-status').textContent.includes('npm test'), 5000, 'chosen project command is visible');
      choose('strict');
      g.$('#strict-tests').click();
      await g.waitFor(async () => (await window.api.getConfig()).settings.mode === 'strict-tests', 5000, 'test-first saved with strict review');
      g.$('#input').value = 'Set the answer to 2.';
      g.$('#send-btn').click();
      await g.waitFor(async () => (await g.snapshot()).messages.some((m: any) => m.tag === 'task-summary'), 60000, 'strict review completed');
      const { messages } = await g.snapshot();
      const phases = messages.filter((m: any) => m.kind === 'agent').map((m: any) => m.phase?.code);
      g.check(phases.join(',') === 'tests,execute,review', `strict path skips planning votes and unsupported repairs: ${phases}`);
      const summary = messages.find((m: any) => m.tag === 'task-summary').taskSummary;
      g.check(messages.some((m: any) => m.tag === 'tests' && m.text.includes('answer.test.cjs')), 'test-first produced an actual locked test file');
      g.check(summary.verify === 'passed' && summary.members[0].outcome === 'observations', 'advisory finding remains distinct from approval or failed verification');
      await g.send('Discuss the next change.', 'discuss');
      await g.waitFor(() => g.$('.implement-conclusion') && !g.$('.implement-conclusion').disabled, 5000, 'discussion offers implementation');
      g.$('.implement-conclusion').click();
      await g.waitFor(async () => (await g.snapshot()).messages.filter((m: any) => m.tag === 'task-summary').length === 2, 30000, 'conclusion starts a verified implementation');
    },
  });
  try { if (!report('Workflow intents and project checks', r)) process.exitCode = 1; }
  finally { r.cleanup(); }
}

(async () => {
  if (!process.argv.includes('--solo-only')) await main();
  for (const caseName of ['clean', 'repair', 'test-change'] as const) await solo(caseName);
  await intentWorkflow();
})().catch((e) => { console.error(e); process.exitCode = 1; });
