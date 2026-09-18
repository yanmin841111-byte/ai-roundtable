'use strict';

// 情境:介面設成英文時,主程序產生的錯誤也要是英文。
//
// 單元測試證明每條路徑「會」產生英文;這裡證明整疊接起來之後,語言真的從設定一路傳到
// 畫面上——任何一段忘了傳 locale,使用者就會在英文介面裡看到一句中文。
// 驗三條不同的路:健康檢查(沒有 RunContext)、擴充載入、以及執行中的成員回合。

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { runApp, report, REPO_ROOT } from '../app';
import { missingCliMember, scriptedMember } from '../fixtures';

const CJK = /[一-鿿]/;

async function main() {
  const broken = path.join(REPO_ROOT, 'test', 'harness', 'zz-broken-extension.json');
  fs.writeFileSync(broken, '{ this is not json');

  const r = await runApp({
    members: [
      missingCliMember({ id: 'g1', name: 'Gemini' }),
      scriptedMember({ id: 's1', name: 'Scripted' }),
    ],
    adapters: [path.join(REPO_ROOT, 'adapters', 'templates', 'gemini-cli.json'), broken],
    settings: { uiLocale: 'en', language: 'English', leadAgentId: 's1' },
    timeoutMs: 4 * 60 * 1000,
    scenario: async () => {
      const g: any = globalThis;
      await g.ready();
      await g.waitFor(() => /\d+\s*\/\s*\d+/.test(g.text('#cli-summary')), 20000, 'CLI 健康檢查完成');

      // --- 健康檢查:沒有 RunContext,語言由 registry 帶進 check() ---
      g.$('#settings-btn').click();
      const rows = await g.waitFor(() => {
        const list = Array.from(document.querySelectorAll('#ext-list > *')).map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim());
        return list.some((t: string) => /Gemini/.test(t)) && list.some((t: string) => /zz-broken/.test(t)) ? list : null;
      }, 30000, '擴充清單');
      const gemini = rows.find((t: string) => /Gemini/.test(t));
      g.check(/Command not found: gemini/.test(gemini), `健康檢查錯誤是英文(${gemini.slice(0, 70)})`);

      // --- 擴充載入失敗 ---
      const brokenRow = rows.find((t: string) => /zz-broken/.test(t));
      g.check(/Invalid JSON/.test(brokenRow), `擴充載入失敗原因是英文(${brokenRow.slice(0, 70)})`);
      await g.shot('01-settings-en');
      g.$('#settings-close').click();

      // --- 執行中的成員回合:語言經 orchestrator → runTurn → ctx.locale 傳到 adapter ---
      const msgs = await g.send('@Gemini hello', 'divide');
      const turn = msgs.find((m: any) => m.kind === 'agent' && m.agentName === 'Gemini');
      g.check(!!turn && !!turn.error, '指定的成員回合有錯誤');
      g.check(/Could not start gemini/.test(turn.error), `執行期錯誤是英文(${String(turn.error).slice(0, 70)})`);
      await g.shot('02-turn-error-en');

      // 該隱藏的東西真的隱藏了嗎(例如沒有「尚未審查」時,那個提示框不該留下一個空框)
      const leaks = g.hiddenLeaks();
      g.check(leaks.length === 0, `沒有帶 hidden 卻仍佔版面的元素(${leaks.join(', ') || '無'})`);

      return { gemini: gemini.slice(0, 90), broken: brokenRow.slice(0, 90), turnError: String(turn.error).slice(0, 90) };
    },
  });

  fs.rmSync(broken, { force: true });
  const ok = report('English UI', r);
  assert.ok(ok, r.error || '情境失敗');
  // 回傳的三段文字都不該混進中文(錯誤原文 stderr 是 Node 的英文,本來就沒有中文)
  for (const [k, v] of Object.entries(r.value || {})) assert.ok(!CJK.test(String(v)), `${k} 混進了中文:${v}`);
  r.cleanup();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
