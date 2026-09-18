'use strict';

// 情境:工作目錄不是 git repo,「檔案改動」照樣看得到成員改了什麼。
//
// 預設工作區就不是 git repo。以前這裡只會說「不是 Git 版本庫,無法比對」,
// 審查訊息裡的檔名點下去也一樣。現在比對的是最近一次任務開始前記下的內容。中英文各跑一次。

import { runApp, report } from '../app';
import { scriptedMember } from '../fixtures';

async function once(locale: 'zh-Hant' | 'en') {
  const zh = locale === 'zh-Hant';
  const r = await runApp({
    members: [
      scriptedMember({
        id: 'a', name: 'Alice', canEdit: true,
        plan: { summary: zh ? '修正加法' : 'Fix add', assignments: [{ agent: 'A1', task: zh ? '修正 calc.js 的 add' : 'Fix add in calc.js' }] },
        writes: { 'calc.js': 'function add(a, b) {\n  return a + b;\n}\n', 'notes.md': '# 筆記\n' },
        report: zh ? '已修正 calc.js' : 'Fixed calc.js',
      }),
      scriptedMember({ id: 'b', name: 'Bob', canEdit: false }),
    ],
    files: { 'calc.js': 'function add(a, b) {\n  return a - b;\n}\n', 'untouched.txt': '不會被改\n' },
    settings: { leadAgentId: 'a', uiLocale: locale, language: zh ? '繁體中文' : 'English' },
    constants: { zh },
    timeoutMs: 3 * 60 * 1000,
    scenario: async (H: any) => {
      const g: any = globalThis;
      await g.ready();
      const msgs = await g.send(H.zh ? '請修正 calc.js' : 'Please fix calc.js', 'divide');
      await g.w(500);

      (document.querySelector('#diff-btn') as HTMLButtonElement).click();
      await g.waitFor(() => document.querySelectorAll('#diff-body .diff-file').length > 0, 10000, '檔案改動清單');
      const summary = (document.querySelector('#diff-summary') as HTMLElement).textContent || '';
      g.check(new RegExp(H.zh ? '不是 Git 版本庫:列出 .* 開始的最近一次任務以來的改動' : 'Not a Git repository: changes since the latest task started').test(summary), `摘要列講明比對的基準(${summary})`);
      const files = Array.from(document.querySelectorAll('#diff-body .diff-file')) as HTMLElement[];
      const paths = files.map((f) => f.dataset.path);
      g.check(paths.includes('calc.js') && paths.includes('notes.md') && !paths.includes('untouched.txt'), `只列出改過的檔案(${paths.join(', ')})`);
      const calc = files.find((f) => f.dataset.path === 'calc.js')!;
      (calc.querySelector('.diff-file-head') as HTMLButtonElement).click();
      await g.w(200);
      const rows = Array.from(calc.querySelectorAll('.diff-line')).map((l) => `${l.className.replace('diff-line ', '')}:${(l.querySelector('.diff-text') as HTMLElement).textContent}`);
      g.check(rows.includes('del:  return a - b;') && rows.includes('add:  return a + b;'), `calc.js 顯示紅綠逐行對照(${rows.join(' | ')})`);
      await g.shot(`diff-${H.zh ? 'zh' : 'en'}`);
      (document.querySelector('#diff-close') as HTMLButtonElement).click();

      // 審查訊息裡的檔名點下去,也要跳到那個檔案
      const review = msgs.find((m: any) => m.review && m.review.target === 'Alice');
      const chip = Array.from(document.querySelectorAll(`#timeline [data-msg-id="${review.id}"] .review-file`)).find((c) => c.textContent === 'calc.js') as HTMLButtonElement;
      g.check(!!chip, '審查訊息列出 calc.js');
      chip.click();
      await g.waitFor(() => document.querySelector('#diff-body .diff-file.focused'), 10000, '跳到檔案');
      const focused = document.querySelector('#diff-body .diff-file.focused') as HTMLElement;
      g.check(focused.dataset.path === 'calc.js' && !(focused.querySelector('.diff-lines') as HTMLElement).hidden, '點檔名展開並標示 calc.js');
      g.check(!document.querySelector('#diff-body .diff-focus-missing'), '不顯示「不在清單裡」');
      (document.querySelector('#diff-close') as HTMLButtonElement).click();

      const leaks = g.hiddenLeaks();
      g.check(leaks.length === 0, `沒有帶 hidden 卻仍佔版面的元素(${leaks.join(', ') || '無'})`);
      return { summary, paths };
    },
  });
  report(`不是 git repo 的檔案改動 · ${locale}`, r);
  r.cleanup();
  return r;
}

async function main() {
  const zh = await once('zh-Hant');
  const en = await once('en');
  if (!zh.ok || !en.ok) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
