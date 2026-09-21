'use strict';

// 修復弄壞語法時自動收回修復,不需要使用者按還原。

import assert from 'assert';
import { runApp, report } from '../app';
import { scriptedMember } from '../fixtures';

async function main() {
  const r = await runApp({
    git: true,
    files: { 'a.js': 'module.exports = { ok: false };\n', 'mine.txt': 'committed\n' },
    beforeLaunch: ({ workDir }) => {
      require('fs').writeFileSync(require('path').join(workDir, 'mine.txt'), 'user edit\n');
    },
    members: [
      scriptedMember({ id: 'lead', name: '主持人', plan: { summary: '修好 a.js', assignments: [{ agent: '執行者', task: '修好 a.js' }] },
        // 審查說有問題,才會進修復回合
        review: '這裡還有一個邊界情況沒處理', recheck: '還是沒處理好' }),
      scriptedMember({
        id: 'exec', name: '執行者', canEdit: true,
        writes: { 'a.js': 'module.exports = { ok: true };\n', 'b.js': '// 執行階段新增的\n' },
        report: '改好了',
        // 修復回合把檔案改成語法錯誤:自動驗證在執行後是過的,修復後就不過
        fixWrites: { 'a.js': 'module.exports = { ok: true;\n' },
        fixReport: '我又調了一下',
      }),
    ],
    settings: { workStyle: 'code' },
    timeoutMs: 3 * 60 * 1000,
    scenario: async () => {
      const g: any = globalThis;
      await g.ready();
      const msgs = await g.send('請修好 a.js', 'divide');
      const card = msgs.find((m: any) => m.tag === 'task-summary');
      g.check(!!card && card.taskSummary, '有結果卡');
      g.check(card.taskSummary.repairBroke === true, `結果卡知道是修復把事情弄糟的(${JSON.stringify(card.taskSummary.verify)})`);
      g.check(/修復回合反而把東西改壞/.test(card.text), `說成人話,不是只說「驗證沒過」(${card.text.slice(0, 160)})`);
      g.check(card.taskSummary.rollback?.scope === 'repair' && card.taskSummary.rollback?.status === 'complete', '已自動收回修復回合');
      g.check(card.taskSummary.verify === 'passed', '回退後重新驗證通過');
      g.check(card.taskSummary.members[0].outcome === 'unresolved', '回退不是完成任務');
      g.check(msgs.some((m: any) => m.tag === 'revert'), '自動回退寫入紀錄');
      const notice = await g.waitFor(() => document.querySelector('.ts-rollback'), 8000, '結果卡的自動回退狀態');
      g.check(/已自動收回修復/.test(notice.textContent || ''), '介面顯示已完成自動回退');
      g.check(!document.querySelector('.ts-revert.warn'), '不再要求使用者重做修復回退');
      await g.shot('01-repair-broke');
      return { text: card.text.slice(0, 200) };
    },
  });

  const ok = report('修復把事情改壞時的退路', r);
  // 從 app 外面看磁碟:修復的改動收回來了,執行階段的成果留著
  const a = r.read('a.js');
  const b = r.read('b.js');
  const kept = a === 'module.exports = { ok: true };\n';
  const keptNew = b === '// 執行階段新增的\n';
  const keptUser = r.read('mine.txt') === 'user edit\n';
  console.log(kept ? '  ok - a.js 回到修復前的樣子' : `  失敗:a.js 是 ${JSON.stringify(a)}`);
  console.log(keptNew ? '  ok - 執行階段新增的 b.js 留著' : `  失敗:b.js 是 ${JSON.stringify(b)}`);
  r.cleanup();
  assert.ok(ok && kept && keptNew && keptUser, r.error || '情境失敗');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
