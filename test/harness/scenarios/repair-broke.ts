'use strict';

// 情境:修復回合反而把東西改壞時,介面說得出來,而且給得出下一步。
//
// 這個情境來自實驗 7 的實測:32 次裡有好幾次是修復回合把檔案改到載不起來,
// 而執行階段其實已經做對了一部分。app 那時只印一行「自動驗證沒過」——它明明知道
// 「執行後是通過的、修復後變成不通過」,卻沒有把這件事說成人話,也沒有給退路。
// 整個任務還原會把執行階段做對的東西一起丟掉,所以要能「只收回修復回合」。

import assert from 'assert';
import { runApp, report } from '../app';
import { scriptedMember } from '../fixtures';

async function main() {
  const r = await runApp({
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

      const undo = await g.waitFor(() => document.querySelector('.ts-revert.warn'), 8000, '結果卡上的「只收回修復回合」按鈕');
      g.check(/只收回修復/.test(undo.textContent || ''), `按鈕說得清楚要做什麼(${undo.textContent})`);
      await g.shot('01-repair-broke');

      // 按下去(confirm 要先擋掉),然後從 app 外面獨立確認檔案內容
      (window as any).confirm = () => true;
      (window as any).alert = () => {};
      undo.click();
      await g.waitFor(async () => {
        const snap = await (window as any).api.snapshot();
        return snap.messages.some((m: any) => m.tag === 'revert');
      }, 15000, '還原完成的系統訊息');
      return { text: card.text.slice(0, 200) };
    },
  });

  const ok = report('修復把事情改壞時的退路', r);
  // 從 app 外面看磁碟:修復的改動收回來了,執行階段的成果留著
  const a = r.read('a.js');
  const b = r.read('b.js');
  const kept = a === 'module.exports = { ok: true };\n';
  const keptNew = b === '// 執行階段新增的\n';
  console.log(kept ? '  ok - a.js 回到修復前的樣子' : `  失敗:a.js 是 ${JSON.stringify(a)}`);
  console.log(keptNew ? '  ok - 執行階段新增的 b.js 留著' : `  失敗:b.js 是 ${JSON.stringify(b)}`);
  r.cleanup();
  assert.ok(ok && kept && keptNew, r.error || '情境失敗');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
