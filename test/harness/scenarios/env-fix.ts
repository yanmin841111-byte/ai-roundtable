'use strict';

// 情境:環境問題的統一修復流程。
//
// 這個 app 依賴一堆「在你這台機器上才知道」的東西:CLI 裝了沒、登入了沒、本機模型有沒有跑起來、
// git 能不能用。驗的是這些狀況被發現之後,使用者看到的是不是同一套東西:
//   - 照實說發生什麼事(不是 fetch 原文,也不是叫人去做沒有用的事)
//   - 同一顆「在終端執行」:指令送進內建終端,填好但不按 Enter
//   - 選模型的地方就講清楚,不是等送出任務才失敗
// 不需要任何模型,結果固定。

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { runApp, report, REPO_ROOT } from '../app';
import { scriptedMember, missingCliMember } from '../fixtures';

async function main() {
  // 連不上的端點,而且自己宣告了修復指令(範本作者可以宣告,app 不為某個服務寫死特例)
  const adapter = path.join(REPO_ROOT, 'test', 'harness', 'zz-fixable-endpoint.json');
  fs.writeFileSync(adapter, JSON.stringify({
    id: 'fixable', label: '測試:連不上的本機模型', type: 'openai',
    baseUrl: 'http://localhost:9/v1', models: 'auto',
    unreachableHint: '請先執行 ollama serve',
    fixCommand: 'ollama serve',
  }, null, 2));

  const r = await runApp({
    members: [
      scriptedMember({
        id: 's1', name: '對照組',
        // 有分工才會走到執行與驗證階段(驗證指令的那一條要靠它)
        plan: { summary: '整理需求', assignments: [{ agent: '對照組', task: '列出需求' }] },
        report: '整理好了',
      }),
      { id: 'd1', name: '本機模型', cli: 'fixable', model: '', persona: '', canEdit: false },
      missingCliMember({ id: 'g1', name: '沒裝的 CLI' }),
    ],
    adapters: [adapter, path.join(REPO_ROOT, 'adapters', 'templates', 'gemini-cli.json')],
    // 故意設一個不存在的驗證指令:使用者最常見的情況是打錯字或換了專案
    settings: { verifyCommand: 'definitely-not-a-real-command-xyz' },
    timeoutMs: 3 * 60 * 1000,
    scenario: async () => {
      const g: any = globalThis;
      const api = (window as any).api;
      await g.ready();

      // --- 設定頁:狀態一句話 + 修復卡片 ---
      g.$('#settings-btn').click();
      document.querySelector<HTMLElement>('.settings-tab[data-tab="clis"]')!.click();
      // 每次健康檢查回來都會重畫 #ext-list,抓到的節點會被換掉——所以每次都重新查
      const row = await g.waitFor(() => {
        const items = Array.from(document.querySelectorAll('#ext-list .ext-item'));
        const hit = items.find((el) => (el.textContent || '').includes('連不上的本機模型'));
        return hit && (hit.textContent || '').includes('請先執行 ollama serve') ? hit : null;
      }, 25000, '設定頁列出這個端點,並照實說那一句');
      const runButton = row.querySelector('[data-env-run]') as HTMLButtonElement;
      g.check(!!runButton, '設定頁有「在終端執行」');
      g.check(runButton.dataset.envRun === 'ollama serve', '按鈕帶的是範本宣告的修復指令');
      g.check(!!row.querySelector('[data-env-copy]'), '也保留「複製」給想自己貼的人');
      g.$('#settings-close').click();

      // --- 模型設定:選模型的地方就說清楚 ---
      const cards = Array.from(document.querySelectorAll('#agent-list > *'));
      const card = cards.find((el) => (el.textContent || '').includes('本機模型')) as HTMLElement;
      card.click();
      const statusBox = await g.waitFor(() => {
        const el = g.$('#f-cli-status') as HTMLElement;
        return el && !el.hidden && (el.textContent || '').includes('ollama serve') ? el : null;
      }, 20000, '成員的模型設定顯示狀態');
      g.check((statusBox.textContent || '').includes('請先執行 ollama serve'), '模型設定裡也是同一句話');
      g.check(!!statusBox.querySelector('[data-env-run]'), '模型設定裡也有「在終端執行」');
      await g.shot('01-model-settings');

      // --- 按下去:終端打開、指令填好但沒有執行 ---
      (statusBox.querySelector('[data-env-run]') as HTMLButtonElement).click();
      await g.waitFor(async () => (await api.terminal.list()).length > 0, 20000, '終端打開');
      g.check(!(g.$('#terminal-panel') as HTMLElement).hidden, '修復按鈕會把終端叫出來');
      const screen = () => ((g.$('#term-body .term-pane.on') || { textContent: '' }).textContent || '');
      await g.waitFor(() => /ollama serve/.test(screen()), 20000, '指令出現在終端裡');
      // 不自動執行:sudo、安裝、啟動服務這種事要由使用者自己按 Enter
      await g.w(1200);
      g.check(!/command not found|No such file/.test(screen()), '指令只是填好,沒有被自動執行');
      await g.shot('02-terminal-prefilled');

      // --- 沒安裝的 CLI:沒有單一指令可跑,就給官方安裝說明 ---
      (g.$('#modal-close') as HTMLElement).click();
      const missingCard = cards.find((el) => (el.textContent || '').includes('沒裝的 CLI')) as HTMLElement;
      missingCard.click();
      const missingBox = await g.waitFor(() => {
        const el = g.$('#f-cli-status') as HTMLElement;
        return el && !el.hidden && el.querySelector('[data-env-url]') ? el : null;
      }, 20000, '沒安裝的 CLI 也有下一步');
      g.check(/gemini/.test(missingBox.textContent || ''), '說的是找不到哪一個指令');
      const docs = missingBox.querySelector('[data-env-url]') as HTMLButtonElement;
      g.check(/^https:\/\//.test(docs.dataset.envUrl || ''), `安裝說明指向官方頁面(${docs.dataset.envUrl})`);
      g.check(!missingBox.querySelector('[data-env-run]'), '沒有可照做的指令時就不假裝有');

      // --- 真的送出之後失敗:錯誤訊息底下就有下一步 ---
      (g.$('#modal-close') as HTMLElement).click(); // 先關掉成員視窗,畫面要看得到對話
      // 這是使用者最常遇到問題的地方——不是在設定畫面,是在對話裡看到一段紅字。
      const msgs = await g.send('@沒裝的 CLI 你好');
      const failed = msgs.find((m: any) => m.kind === 'agent' && m.error);
      g.check(!!failed, '沒裝的 CLI 會讓這一回合失敗');
      g.check(!!(failed.fix && failed.fix.url), `失敗的回合帶著下一步(${JSON.stringify(failed.fix)})`);
      const bubbleFix = await g.waitFor(() => {
        const cards = Array.from(document.querySelectorAll('.msg-fix')).filter((el: any) => !el.hidden && el.querySelector('[data-env-url]'));
        return cards.length ? cards[0] : null;
      }, 10000, '對話裡的修復卡片');
      g.check(!!bubbleFix, '對話裡的錯誤下面看得到同一張卡片');
      await g.shot('04-turn-error');

      // --- 檔案改動:git 不能用時不能叫人去 git init ---
      // 要在跑任務之前看:跑過之後有了任務基準,這裡會改用「任務前後比對」(那是另一條路)
      const diff = await api.getDiff();
      let gitCase = 'git-ok';
      if (!diff.ok && diff.reason === 'git-unavailable') {
        gitCase = diff.issue;
        g.$('#diff-btn').click();
        await g.waitFor(() => /git/.test(g.text('#diff-body')), 10000, '檔案改動說明 git 的狀況');
        const body = g.text('#diff-body');
        g.check(!/git init/.test(body), 'git 不能用時不會叫使用者去 git init');
        const fix = document.querySelector('#diff-body [data-env-run]') as HTMLButtonElement;
        g.check(!!fix && fix.dataset.envRun === diff.fix.command, '檔案改動也給同一顆「在終端執行」');
        await g.shot('03-diff-git');
        (g.$('#diff-close') as HTMLElement).click();
      }

      // --- 驗證指令根本不存在:要改的是設定,不是去讀程式碼 ---
      await g.send('請整理需求', 'divide');
      const verifyMsg = (await api.snapshot()).messages.find((m: any) => m.kind === 'system' && m.tag === 'verify' && m.fix);
      g.check(!!verifyMsg, '驗證指令找不到時,系統訊息帶著下一步');
      g.check(verifyMsg.fix.settingsTab === 'general', `下一步是打開設定(${JSON.stringify(verifyMsg.fix)})`);
      g.check(/找不到/.test(verifyMsg.text || ''), '說的是「找不到指令」,不是「結束代碼 127」');
      const settingsButton = await g.waitFor(() => document.querySelector('#timeline .msg.system [data-env-settings]'), 8000, '系統訊息上的按鈕');
      // 先拍訊息本身(截圖是主程序非同步拍的,按下去之後畫面會變,拍到的就不是這一幕)
      settingsButton.scrollIntoView({ block: 'center' });
      await g.shot('05-verify-command');
      settingsButton.click();
      await g.waitFor(() => !g.$('#settings').classList.contains('hidden'), 5000, '設定打開');
      g.check(!!document.querySelector('.settings-tab.active[data-tab="general"]'), '打開的是「一般」分頁(驗證指令就在那裡)');
      g.$('#settings-close').click();

      const leaks = g.hiddenLeaks();
      g.check(leaks.length === 0, `沒有帶 hidden 卻仍佔版面的元素(${leaks.join(', ') || '無'})`);
      return { gitCase, fix: diff.ok ? null : (diff as any).fix || null, turnFix: failed.fix };
    },
  });

  fs.rmSync(adapter, { force: true });
  const ok = report('環境問題的統一修復流程', r);
  assert.ok(ok, r.error || '情境失敗');
  r.cleanup();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
