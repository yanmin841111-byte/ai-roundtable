'use strict';

// 情境:長回合時,畫面有沒有說清楚「現在在做什麼、過了多久、是不是卡住了」。
//
// 本機模型一回合要 1~3 分鐘。以前只有一個轉圈加「正在輸出…」,使用者分不出它是在
// 載入模型、在思考,還是已經卡住——而只有最後一種需要他去按停止。
// 用一個先沉默幾秒才輸出的自訂指令成員,在它跑的過程中讀畫面。

import assert from 'assert';
import { runApp, report } from '../app';

async function main() {
  const r = await runApp({
    members: [
      { id: 'slow', name: 'Slow', cli: 'custom', customCommand: 'sleep 12; echo 完成', canEdit: false },
    ],
    timeoutMs: 3 * 60 * 1000,
    scenario: async () => {
      const g: any = globalThis;
      await g.ready();
      await (window as any).api.send('@Slow 你好', 'divide');

      const line = () => document.querySelector('#timeline .msg.streaming .bubble-status') as HTMLElement | null;
      await g.waitFor(() => line() && /\d:\d\d/.test(line()!.textContent || ''), 10000, '進行中的狀態列');
      const first = line()!.textContent || '';
      g.check(/^等待回應 · 0:0\d$/.test(first), `還沒有任何輸出時顯示「等待回應」與經過時間(${first})`);
      await g.shot('01-waiting');

      await g.w(2100);
      const later = line()!.textContent || '';
      const secs = (s: string) => Number((/(\d+):(\d\d)/.exec(s) || [])[2] || 0);
      g.check(secs(later) >= secs(first) + 2, `經過時間會往上跳(${first} → ${later})`);

      // 把「上次有進度」撥回 70 秒前,看計時器下一跳是否標示停滯。
      // 走的是真實渲染路徑,只是不必真的等 60 秒。
      const el = line()!.closest('.msg') as HTMLElement;
      el.dataset.progressAt = String(Date.now() - 70000);
      await g.w(1300);
      const staleLine = line()!;
      const staleText = staleLine.textContent || '';
      g.check(/秒沒有新進度/.test(staleText) && staleLine.classList.contains('stale'),
        `太久沒有新進度時,換成警示並提示可以停止(${staleText})`);
      await g.shot('02-stale');

      await g.waitIdle(60000);
      await g.w(500);
      const done = document.querySelector('#timeline .msg.agent .bubble-status') as HTMLElement | null;
      g.check(!done || done.offsetHeight === 0, '回合結束後狀態列收起來');
      const leaks = g.hiddenLeaks();
      g.check(leaks.length === 0, `沒有帶 hidden 卻仍佔版面的元素(${leaks.join(', ') || '無'})`);
      return { first, later, stale: staleText };
    },
  });

  const ok = report('等待狀態', r);
  assert.ok(ok, r.error || '情境失敗');
  r.cleanup();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
