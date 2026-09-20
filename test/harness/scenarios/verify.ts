'use strict';

// 情境:自動驗證在「真的 app 裡」有沒有真的檢查語法。
//
// 這個情境存在的理由是一個實際發生過的 bug:語法檢查用 process.execPath 開子行程,
// 而在 app 裡那是 Electron 不是 node,少了 ELECTRON_RUN_AS_NODE 就變成「執行那個檔案」——
// 有語法錯誤的檔案被判通過,成員寫的測試檔反而被跑起來。單元測試在純 node 底下跑,永遠抓不到。

import { runApp, report } from '../app';
import { scriptedMember } from '../fixtures';

async function main() {
  const r = await runApp({
    members: [
      scriptedMember({ id: 'lead', name: '主持人', plan: { summary: '建立檔案', assignments: [{ agent: '執行者', task: '建立 broken.js 與 fine.js' }] } }),
      scriptedMember({
        id: 'exec', name: '執行者', canEdit: true,
        // broken.js 有語法錯誤;side-effect.js 會「執行到就留下痕跡」,用來確認檢查沒有真的執行它
        writes: {
          'broken.js': 'function x( {\n  return 1;\n}\n',
          'fine.js': 'module.exports = { ok: true };\n',
          // 寫到自己旁邊,不是相對 cwd:檢查子行程的 cwd 是 app 的,真的被執行時
          // 相對路徑會落在 repo 根目錄,這條檢查就永遠不會響(實測過)
          'side-effect.js': "require('fs').writeFileSync(__dirname + '/ran.txt', 'executed');\n",
        },
        report: '已建立檔案',
      }),
    ],
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
      const card = msgs.find((m: any) => m.tag === 'task-summary');
      g.check(!!card && card.taskSummary && card.taskSummary.verify === 'failed', `結果卡標出驗證沒過(${card && card.taskSummary && card.taskSummary.verify})`);
      g.check(!/✓ 審查通過/.test(card.text), `驗證沒過就不能寫審查通過(${card.text.slice(0, 120)})`);
      return { text: text.slice(0, 400) };
    },
  });
  report('自動驗證', r);
  // 檢查語法不能真的執行檔案:side-effect.js 跑過的話會留下 ran.txt
  const ran = r.read('ran.txt');
  console.log(ran === null ? '  ok - 語法檢查沒有執行檔案(沒有留下 ran.txt)' : '  失敗:語法檢查把檔案執行了');
  r.cleanup();
  if (!r.ok || ran !== null) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
