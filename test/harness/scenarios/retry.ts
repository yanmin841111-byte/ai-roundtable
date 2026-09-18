'use strict';

// 情境:失敗的 @ 指定回覆可以一鍵重試;分工流程裡失敗的回合則不行。
//
// 重試只開放給指定回覆,是因為分工流程失敗之後已經往下走了(不進審查、總結會提到),
// 事後單獨重跑會繞過審查閘門。這裡兩邊都驗:該有的有,不該有的沒有。
//
// Flaky 第一次失敗、第二次成功(用工作目錄裡的標記檔判斷),並把每次收到的提示詞記下來,
// 才驗得到「重試時成員看得到原本的問題」——看不到的話,重試只是換一個方式失敗。

import assert from 'assert';
import { runApp, report } from '../app';

const FLAKY = 'cat >> .prompts; echo "=====" >> .prompts; if [ -f .tried ]; then echo 重試成功; else touch .tried; exit 1; fi';

async function main() {
  const r = await runApp({
    members: [
      { id: 'f1', name: 'Flaky', cli: 'custom', customCommand: FLAKY, canEdit: false },
      { id: 'b1', name: 'Broken', cli: 'custom', customCommand: 'exit 1', canEdit: false },
    ],
    settings: { leadAgentId: 'f1' },
    timeoutMs: 3 * 60 * 1000,
    scenario: async () => {
      const g: any = globalThis;
      await g.ready();
      const bubbleOf = (id: string) => document.querySelector(`#timeline [data-msg-id="${id}"]`) as HTMLElement | null;
      const retryBtn = (el: HTMLElement | null) => (el ? el.querySelector('.retry-btn') as HTMLButtonElement | null : null);

      // --- 指定回覆失敗:要出現重試鍵 ---
      const first = await g.send('@Flaky 請記住暗號是「藍色鯨魚」', 'divide');
      const failed = first.find((m: any) => m.kind === 'agent' && m.agentName === 'Flaky');
      g.check(!!failed && failed.status === 'error' && failed.retryable === true, '失敗的指定回覆被標成可重試');
      await g.w(300);
      const failedEl = bubbleOf(failed.id);
      g.check(!!retryBtn(failedEl) && retryBtn(failedEl)!.offsetHeight > 0, '畫面上出現重試鍵');
      await g.shot('01-failed');

      // --- 按下重試 ---
      const before = (await g.snapshot()).messages.length;
      retryBtn(failedEl)!.click();
      await g.w(400);
      await g.waitIdle(60000);
      await g.w(600);
      const after = (await g.snapshot()).messages.slice(before);
      const retried = after.find((m: any) => m.kind === 'agent' && m.agentName === 'Flaky');
      g.check(!!retried && retried.status === 'done' && /重試成功/.test(retried.text), `重試產生新的回覆(${retried && retried.text})`);
      g.check(retryBtn(bubbleOf(failed.id))!.offsetHeight === 0, '重試之後,原本那則的重試鍵收起來');
      await g.shot('02-retried');

      // --- 分工流程裡失敗的回合:不能出現重試鍵 ---
      const flow = await g.send('大家討論一下', 'divide');
      const brokenTurn = flow.find((m: any) => m.kind === 'agent' && m.agentName === 'Broken' && m.status === 'error');
      g.check(!!brokenTurn, '分工流程裡有失敗的回合');
      g.check(!brokenTurn.retryable, '分工流程裡失敗的回合不標成可重試');
      g.check(retryBtn(bubbleOf(brokenTurn.id))!.offsetHeight === 0, '畫面上也沒有重試鍵');

      const leaks = g.hiddenLeaks();
      g.check(leaks.length === 0, `沒有帶 hidden 卻仍佔版面的元素(${leaks.join(', ') || '無'})`);
      return { retried: retried.text };
    },
  });

  // 不經過 app 的獨立驗證:Flaky 第二次(重試)收到的提示詞裡,必須還有原本的問題
  const prompts = (r.read('.prompts') || '').split('=====').filter((p) => p.trim());
  const ok = report('重試', r);
  console.log(`  Flaky 收到的提示詞:${prompts.length} 次`);
  const retryPrompt = prompts[1] || '';
  console.log('  重試時的提示詞含原本的問題:', /藍色鯨魚/.test(retryPrompt) ? '是' : '否');
  assert.ok(ok, r.error || '情境失敗');
  assert.ok(/藍色鯨魚/.test(retryPrompt), '重試時成員必須看得到原本的問題');
  r.cleanup();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
