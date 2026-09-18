'use strict';

// 情境:分工任務結束時出現結果卡,一次看完誰做完了、審查結論、改了哪些檔案、花了多少時間。
// 工作目錄不是 git repo(跟預設工作區一樣)。中英文各跑一次。

import { runApp, report } from '../app';
import { scriptedMember } from '../fixtures';

async function once(locale: 'zh-Hant' | 'en') {
  const zh = locale === 'zh-Hant';
  const r = await runApp({
    members: [
      scriptedMember({
        id: 'a', name: 'Alice', canEdit: true,
        plan: { summary: zh ? '各寫一個檔案' : 'One file each', assignments: [{ agent: 'A1', task: zh ? '建立 a.js' : 'Create a.js' }, { agent: 'A2', task: zh ? '建立 b.js' : 'Create b.js' }] },
        writes: { 'a.js': 'module.exports = 1;\nmodule.exports.x = 2;\n' }, report: zh ? '已建立 a.js' : 'Created a.js',
        review: zh ? 'b.js 少了分號,請補上' : 'b.js is missing a semicolon',
      }),
      scriptedMember({
        id: 'b', name: 'Bob', canEdit: true,
        writes: { 'b.js': 'module.exports = 2\n' }, report: zh ? '已建立 b.js' : 'Created b.js',
        review: zh ? '看過了,沒問題\n[NO_ISSUES]' : 'Looks good\n[NO_ISSUES]',
      }),
    ],
    settings: { leadAgentId: 'a', uiLocale: locale, language: zh ? '繁體中文' : 'English' },
    constants: { zh },
    timeoutMs: 3 * 60 * 1000,
    scenario: async (H: any) => {
      const g: any = globalThis;
      await g.ready();
      await g.send(H.zh ? '請各自建立檔案' : 'Please create the files', 'divide');
      await g.w(500);
      const card = document.querySelector('#timeline .task-summary') as HTMLElement | null;
      g.check(!!card && card.offsetHeight > 0, '任務結束出現結果卡');
      const head = (card!.querySelector('.ts-head') as HTMLElement).textContent || '';
      g.check(new RegExp(H.zh ? '任務結果.*已依審查意見修復.*秒' : 'Task result.*Fixed after review.*s').test(head), `標題、整體狀態與用時(${head})`);
      g.check(card!.classList.contains('tone-info'), '有成員是修復後完成:整體狀態是「已修復」,不是「全部通過」');
      const rows = Array.from(card!.querySelectorAll('.ts-member')).map((r) => (r.textContent || '').replace(/\s+/g, ' '));
      g.check(rows.some((r) => new RegExp(H.zh ? 'Alice.*✓ 審查通過.*Bob 審查' : 'Alice.*✓ Approved.*reviewed by Bob').test(r)), `Alice:審查通過(${rows.join(' / ')})`);
      g.check(rows.some((r) => new RegExp(H.zh ? 'Bob.*已修復\\(未再審查\\).*Alice 審查' : 'Bob.*Fixed \\(not re-reviewed\\).*reviewed by Alice').test(r)), `Bob:已修復、未再審查(${rows.join(' / ')})`);
      const files = Array.from(card!.querySelectorAll('.ts-file')).map((f) => (f.textContent || '').replace(/\s+/g, ' ').trim());
      g.check(files.some((f) => /a\.js\s*\+2\s*−0/.test(f)) && files.some((f) => /b\.js\s*\+1\s*−0/.test(f)), `列出改動的檔案與行數(${files.join(' / ')})`);
      await g.shot(`card-${H.zh ? 'zh' : 'en'}`);

      // 點檔名跳到「檔案改動」的那個檔案
      (Array.from(card!.querySelectorAll('.ts-file')).find((f) => /a\.js/.test(f.textContent || '')) as HTMLButtonElement).click();
      await g.waitFor(() => document.querySelector('#diff-body .diff-file.focused'), 10000, '跳到檔案');
      const focused = document.querySelector('#diff-body .diff-file.focused') as HTMLElement;
      g.check(focused.dataset.path === 'a.js', `點檔名跳到 a.js(${focused.dataset.path})`);
      (document.querySelector('#diff-close') as HTMLButtonElement).click();

      const leaks = g.hiddenLeaks();
      g.check(leaks.length === 0, `沒有帶 hidden 卻仍佔版面的元素(${leaks.join(', ') || '無'})`);
      return { head, rows, files };
    },
  });
  report(`任務結果卡 · ${locale}`, r);
  r.cleanup();
  return r;
}

async function main() {
  const zh = await once('zh-Hant');
  const en = await once('en');
  if (!zh.ok || !en.ok) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
