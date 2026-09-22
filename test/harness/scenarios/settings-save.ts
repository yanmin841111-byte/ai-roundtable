'use strict';

// 情境:設定存不進去的時候,介面說的是實話。
//
// 這個情境存在的理由:config:save 以前是送出去就不管了,寫入失敗(磁碟滿了、檔案沒有權限、
// 設定目錄被同步軟體鎖住)照樣閃一個「✓ 已儲存」。使用者相信自己存好了,下次開 app 才發現
// 設定回到舊的——而且不會有任何線索說剛才那一下沒成功。這種「介面騙人」比功能壞掉更難查。
// 單元測試看不到:這是 renderer 的承諾處理,只有真的按下去才會發生。

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { runApp, report } from '../app';
import { scriptedMember } from '../fixtures';

// 對照組:一樣的操作,設定檔可以寫。沒有這一半,上面那些檢查只要介面永遠說失敗就全過了。
async function writable() {
  const r = await runApp({
    members: [scriptedMember({ id: 's1', name: '成員一' }), scriptedMember({ id: 's2', name: '成員二' })],
    timeoutMs: 2 * 60 * 1000,
    scenario: async () => {
      const g: any = globalThis;
      await g.ready();
      g.$('#settings-btn').click();
      await g.waitFor(() => !g.$('#settings').classList.contains('hidden'), 5000, '設定打開');
      const rounds = g.$('#max-rounds') as HTMLInputElement;
      rounds.value = '2';
      rounds.dispatchEvent(new Event('change'));
      const discussion = g.$('#discussion-mode') as HTMLSelectElement;
      discussion.value = 'independent-first';
      discussion.dispatchEvent(new Event('change'));
      const hint = await g.waitFor(() => {
        const el = g.$('#settings-saved') as HTMLElement;
        return el && !el.hidden ? el : null;
      }, 8000, '改完設定之後有回應');
      g.check(/已儲存/.test(hint.textContent || ''), `存得進去就說已儲存(顯示:${hint.textContent})`);
      g.check(!hint.classList.contains('failed'), '成功時不帶失敗樣式');
      await g.shot('discussion-mode');
      g.$('#settings-close').click();
      const messages = await g.send('Discuss the task independently first.', 'discuss');
      const discussionTurns = messages.filter((message: any) => message.kind === 'agent' && message.phase?.code === 'discuss');
      g.check(discussionTurns.length === 4, '首輪即使全員同意也必須進入第二輪互評');
      g.check(discussionTurns.every((message: any) => message.phase.maxRounds === 2), '兩輪設定帶到真實討論流程');
      return { text: hint.textContent };
    },
  });
  const ok = report('設定存得進去時說已儲存', r);
  const saved = JSON.parse(fs.readFileSync(path.join(r.userData, 'config.json'), 'utf8'));
  const written = saved.settings.maxRounds === 2 && saved.settings.discussionMode === 'independent-first';
  console.log(written ? '  ok - 設定檔確實被寫進去了' : '  失敗:說存好了,檔案卻沒有改');
  r.cleanup();
  assert.ok(ok && written, r.error || '對照組失敗');
}

async function main() {
  // root 對唯讀檔照樣寫得進去,這個情境就測不到東西了——照實說跳過,不要假裝通過
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.log('(以 root 執行,唯讀檔擋不住寫入,跳過這個情境)');
    return;
  }
  await writable();
  const r = await runApp({
    members: [scriptedMember({ id: 's1', name: '成員一' })],
    // 啟動之後才鎖不行:app 開起來要先讀得到設定。唯讀檔可以讀、不能寫,正好。
    beforeLaunch: ({ userData }) => fs.chmodSync(path.join(userData, 'config.json'), 0o444),
    timeoutMs: 2 * 60 * 1000,
    scenario: async () => {
      const g: any = globalThis;
      await g.ready();
      g.$('#settings-btn').click();
      await g.waitFor(() => !g.$('#settings').classList.contains('hidden'), 5000, '設定打開');

      // 改一個設定:設定頁是改完就存(change 事件),寫入一定會失敗
      const rounds = g.$('#max-rounds') as HTMLInputElement;
      rounds.value = '2';
      rounds.dispatchEvent(new Event('change'));

      const hint = await g.waitFor(() => {
        const el = g.$('#settings-saved') as HTMLElement;
        return el && !el.hidden ? el : null;
      }, 8000, '改完設定之後有回應');
      const text = hint.textContent || '';
      g.check(!/已儲存|Saved/.test(text), `存不進去時不能說「已儲存」(顯示:${text})`);
      g.check(/沒有存到/.test(text), `要照實說沒有存到(顯示:${text})`);
      g.check(hint.classList.contains('failed'), '失敗的樣式跟成功的不一樣');
      await g.shot('01-save-failed');

      // 而且要說得出原因,不是只有一句「失敗」
      g.check(/EACCES|permission|denied|唯讀|read-only/i.test(text), `訊息帶著原因(顯示:${text})`);
      return { text };
    },
  });

  const ok = report('設定存不進去時照實說', r);
  // 從 app 外面獨立確認:檔案真的沒有被改動過
  const saved = JSON.parse(fs.readFileSync(path.join(r.userData, 'config.json'), 'utf8'));
  const untouched = saved.settings.maxRounds === 1;
  console.log(untouched ? '  ok - 設定檔確實沒有被寫入' : '  失敗:設定檔居然被改了');
  r.cleanup();
  assert.ok(ok && untouched, r.error || '情境失敗');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
