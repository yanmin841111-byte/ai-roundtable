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
      g.check(Array.from(style.options).map((o) => o.value).join(',') === 'code,general', '兩種工作模式都在選單裡');
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

main().catch((e) => { console.error(e); process.exitCode = 1; });
