'use strict';

// 情境:設定壞掉時,畫面到底說了什麼。
//
// 不用任何真模型,所以很快、結果固定,適合進 CI。驗的是這個產品最容易騙到人的地方——
// 燈號與徽章說的是不是真話。這幾條以前都是錯的:
//   - 綁在未安裝 CLI 上的成員,卡片看起來完全正常
//   - 連不上的端點顯示 fetch failed,而不是「請先執行 ollama serve」
//   - 設定 API 時,表單還是顯示 CLI 專用的「執行檔」「參數」
//   - 主持人啟動失敗時,系統訊息說「分工格式無法解析」

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { runApp, report, REPO_ROOT } from '../app';
import { missingCliMember, scriptedMember } from '../fixtures';

async function main() {
  const deadAdapter = path.join(REPO_ROOT, 'test', 'harness', 'zz-dead-endpoint.json');
  fs.writeFileSync(deadAdapter, JSON.stringify({
    id: 'dead', label: '測試:連不上的端點', type: 'openai',
    baseUrl: 'http://localhost:9/v1', models: 'auto', unreachableHint: '請先執行 ollama serve',
  }, null, 2));

  const r = await runApp({
    members: [
      missingCliMember({ id: 'g1', name: 'Gemini' }),
      scriptedMember({ id: 's1', name: '對照組' }),
      missingCliMember({ id: 't1', name: '純文字', cli: 'deepseek' }),
    ],
    adapters: [
      path.join(REPO_ROOT, 'adapters', 'templates', 'gemini-cli.json'),
      path.join(REPO_ROOT, 'adapters', 'templates', 'deepseek-api.json'),
      deadAdapter,
    ],
    // 刻意無效的 key。不用 sk- 開頭,免得被 secret scanner 當成真金鑰擋下或誤報。
    env: { DEEPSEEK_API_KEY: 'invalid-key-for-harness-test' },
    timeoutMs: 4 * 60 * 1000,
    scenario: async () => {
      await (globalThis as any).ready();
      const g: any = globalThis;
      for (const [selector, size] of [['.side-title .logo', 40], ['.empty-icon', 84]] as const) {
        const logo = document.querySelector<HTMLImageElement>(selector)!;
        await g.waitFor(() => logo.complete && logo.naturalWidth === 1024, 5000, `${selector} loaded`);
        const logoBounds = logo.getBoundingClientRect();
        g.check(logoBounds.width === size && logoBounds.height === size, `${selector} renders at its fixed size`);
      }

      // --- 成員卡要說出「這位不能用」---
      // 只讀徽章元素,不讀整張卡的文字:persona 裡剛好出現同樣的字會造成假通過。
      const badgesOf = (i: number) => Array.from(
        (document.querySelectorAll('#agent-list > *')[i] || document.createElement('div')).querySelectorAll('.agent-name .badge'),
      ).map((b) => (b.textContent || '').trim());
      // 健康檢查是非同步的:要等 cliStatus 真的回來,側邊欄重畫之後再讀徽章。
      // 等「n/m 個 CLI 可用」這個完成態出現。不能等「不再顯示檢查中」:第一次渲染前
      // 那裡是空字串,條件會立刻成立,徽章就在健康檢查回來之前被讀走(之前靠時序運氣才通過)。
      await g.waitFor(() => /\d+\s*\/\s*\d+/.test(g.text('#cli-summary')), 20000, 'CLI 健康檢查完成');
      await g.w(300);
      const badges = badgesOf(0);
      g.check(badges.some((b: string) => /未安裝|Not installed/.test(b)), `未安裝的 CLI 在成員卡上有警告徽章(${badges.join(' / ')})`);
      await g.shot('01-member-badge');

      // --- 設定畫面的燈號要說真話 ---
      g.$('#settings-btn').click();
      const readRows = () => Array.from(document.querySelectorAll('#ext-list > *')).map((e) => ({
        text: (e.textContent || '').replace(/\s+/g, ' ').trim(),
        dot: (e.querySelector('.status-dot') || { className: '' }).className,
      }));
      // 開設定時才會真的去驗證雲端 key,所以要等探測回來,不能固定 sleep。
      const rows = await g.waitFor(() => {
        const r = readRows();
        const d = r.find((x: any) => /連不上的端點/.test(x.text));
        const k = r.find((x: any) => /DeepSeek/.test(x.text));
        // 啟動時只做設定檢查,DeepSeek 那列會顯示「API https://api.deepseek.com」。
        // 開設定才會真的連線驗證 key,驗完那段 URL 就會被結果取代——以此判斷探測完成。
        const probed = k && !/https:\/\/api\.deepseek\.com/.test(k.text);
        return d && !/檢查|checking/i.test(d.text) && probed ? r : null;
      }, 30000, '擴充清單狀態(含雲端 key 驗證)');
      const dead = rows.find((x: any) => /連不上的端點/.test(x.text));
      g.check(!!dead && /ollama serve/.test(dead.text), `連不上的端點顯示可照做的提示,而不是 fetch 原文(${dead && dead.text.slice(0, 70)})`);
      const bad = rows.find((x: any) => /DeepSeek/.test(x.text));
      g.check(!!bad && !/ok/.test(bad.dot), `無效的 API key 不得亮綠燈(dot=${bad && bad.dot})`);
      await g.shot('02-settings-status');

      // --- 設定 API 時不該看到 CLI 專用欄位 ---
      g.$('#ext-add').click();
      await g.w(700);
      const search = g.$('#ext-search') as HTMLInputElement;
      search.value = 'DeepSeek';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await g.w(700);
      const use = Array.from(document.querySelectorAll('#ext-templates button,#ext-templates a')).find((x) => /使用此範本/.test(x.textContent || ''));
      (use as HTMLElement).click();
      await g.w(1600);
      const tab = g.$('#ext-tab-basic') as HTMLButtonElement;
      if (tab && !tab.disabled) tab.click();
      await g.w(700);
      const cli = g.$('#ext-cli-fields') as HTMLElement;
      g.check(cli.offsetHeight === 0, `連線類型是 API 時,CLI 專用欄位必須收起來(高度 ${cli.offsetHeight})`);
      await g.shot('03-api-editor');

      // --- 每回合逾時上限:以分鐘編輯,對應 JSON 的 timeoutMs;留空就是預設,不寫這個欄位 ---
      const timeout = g.$('#ext-timeout') as HTMLInputElement;
      const specNow = () => JSON.parse((g.$('#ext-content') as HTMLTextAreaElement).value);
      g.check(timeout.offsetHeight > 0 && timeout.value === '', `編輯器有逾時上限欄位,範本沒設定時留空(值「${timeout.value}」)`);
      timeout.value = '45';
      timeout.dispatchEvent(new Event('input', { bubbles: true }));
      g.check(specNow().timeoutMs === 45 * 60000, `填 45 分鐘寫成 timeoutMs ${specNow().timeoutMs}`);
      timeout.value = '';
      timeout.dispatchEvent(new Event('input', { bubbles: true }));
      g.check(!('timeoutMs' in specNow()), '清空就拿掉 timeoutMs,回到預設');
      const content = g.$('#ext-content') as HTMLTextAreaElement;
      content.value = JSON.stringify({ ...specNow(), timeoutMs: 90 * 60000 }, null, 2);
      content.dispatchEvent(new Event('blur'));
      g.check(timeout.value === '90', `JSON 裡的 timeoutMs 以分鐘顯示(${timeout.value})`);
      // 太大的值會超過計時器上限、讓每個回合立刻逾時:限制在 600 分鐘
      timeout.value = '40000';
      timeout.dispatchEvent(new Event('input', { bubbles: true }));
      g.check(specNow().timeoutMs === 600 * 60000, `超過上限的值限制在 600 分鐘(${specNow().timeoutMs})`);
      // 沒動這個欄位時,不能因為顯示四捨五入就改掉原本的設定(45000 ms 顯示成 0.8 分鐘)
      content.value = JSON.stringify({ ...specNow(), timeoutMs: 45000 }, null, 2);
      content.dispatchEvent(new Event('blur'));
      const label = g.$('#ext-label') as HTMLInputElement;
      label.value = `${label.value} `;
      label.dispatchEvent(new Event('input', { bubbles: true }));
      g.check(specNow().timeoutMs === 45000, `改其他欄位時,原本的逾時設定不變(${specNow().timeoutMs})`);

      // --- 圖片送往純文字 API 成員時,編輯區要在送出前提示 ---
      g.$('#ext-editor-close').click();
      g.$('#settings-close').click();
      const input = g.$('#input') as HTMLTextAreaElement;
      input.value = '@純文字 請看圖';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const image = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2])], 'sample.png', { type: 'image/png' });
      const transfer = new DataTransfer();
      transfer.items.add(image);
      g.$('.composer-box').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      await g.waitFor(() => /純文字/.test(g.text('#hint')) && /圖片內容無法提供/.test(g.text('#hint')), 5000, '圖片能力警告');
      g.check(/圖片內容無法提供給 純文字/.test(g.text('#hint')), '圖片附件指向純文字成員時,送出前顯示能力警告');
      await g.shot('04-image-warning');

      // 該隱藏的東西真的隱藏了嗎(例如沒有「尚未審查」時,那個提示框不該留下一個空框)
      const leaks = g.hiddenLeaks();
      g.check(leaks.length === 0, `沒有帶 hidden 卻仍佔版面的元素(${leaks.join(', ') || '無'})`);

      return { badges, rows: rows.map((x: any) => x.text.slice(0, 80)) };
    },
  });

  fs.rmSync(deadAdapter, { force: true });
  const ok = report('UI 狀態誠實度', r);
  assert.ok(ok, r.error || '情境失敗');
  r.cleanup();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
