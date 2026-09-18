'use strict';

// 情境:審查訊息看得出結論與依據。
//
// 以前審查訊息只有一段文字,結尾掛著給程式看的 [NO_ISSUES];使用者看不出這份審查過了沒有,
// 也看不出審查者到底看了哪些檔案。兩位成員各改一個檔案、互相審查:一位放行、一位提出問題。
// 中文與英文介面各跑一次。
//
// 檔案刻意這樣安排:README.md 與 docs/README.md 同名(以前點前者會跳到排在前面的後者);
// debug.log 被 .gitignore 忽略,審查清單看得到(看工作目錄)、檔案改動看不到(看 git),點它要有說明。

import { runApp, report } from '../app';
import { scriptedMember } from '../fixtures';

async function once(locale: 'zh-Hant' | 'en') {
  const zh = locale === 'zh-Hant';
  const r = await runApp({
    members: [
      scriptedMember({
        id: 'a', name: 'Alice', canEdit: true,
        plan: { summary: '各寫一個檔案', assignments: [{ agent: 'A1', task: '建立 a.js' }, { agent: 'A2', task: '建立 b.js' }] },
        writes: { 'a.js': 'module.exports = 1;\n', 'README.md': '# 說明\n', 'docs/README.md': '# 文件\n' }, report: '已建立 a.js 與 README.md',
        review: 'b.js 少了分號,請補上',
      }),
      scriptedMember({
        id: 'b', name: 'Bob', canEdit: true,
        writes: { 'b.js': 'module.exports = 2\n', '.gitignore': '*.log\n', 'debug.log': 'debug\n' }, report: '已建立 b.js',
        review: '看過了,沒問題\n[NO_ISSUES]',
      }),
    ],
    settings: { leadAgentId: 'a', uiLocale: locale, language: zh ? '繁體中文' : 'English' },
    git: true,
    constants: { zh },
    timeoutMs: 3 * 60 * 1000,
    scenario: async (H: any) => {
      const g: any = globalThis;
      await g.ready();
      const msgs = await g.send(H.zh ? '請各自建立檔案' : 'Please create the files', 'divide');
      await g.w(500);
      const reviewEl = (target: string) => {
        const m = msgs.find((x: any) => x.review && x.review.target === target);
        return m ? document.querySelector(`#timeline [data-msg-id="${m.id}"]`) as HTMLElement | null : null;
      };
      const ofAlice = reviewEl('Alice');  // Bob 審 Alice:放行
      const ofBob = reviewEl('Bob');      // Alice 審 Bob:提出問題
      g.check(!!ofAlice && !!ofBob, '兩則審查訊息都在');

      const pass = ofAlice!.querySelector('.badge.verdict.pass') as HTMLElement | null;
      const issues = ofBob!.querySelector('.badge.verdict.issues') as HTMLElement | null;
      g.check(!!pass && pass.offsetHeight > 0 && /✓/.test(pass.textContent || ''), `放行的審查顯示通過徽章(${pass && pass.textContent})`);
      g.check(!!issues && issues.offsetHeight > 0, `提出問題的審查顯示警示徽章(${issues && issues.textContent})`);
      g.check(!/\[NO_ISSUES\]/.test(ofAlice!.querySelector('.body')!.textContent || ''), '內文不顯示 [NO_ISSUES] 標記');

      const scope = ofAlice!.querySelector('.review-scope') as HTMLElement;
      g.check(scope && scope.offsetHeight > 0, '顯示審查依據列');
      g.check(new RegExp(H.zh ? '審查「Alice」' : 'Reviewing “Alice”').test(scope.textContent || ''), `依據列說明審查對象(${scope.textContent})`);
      const chips = Array.from(scope.querySelectorAll('.review-file')) as HTMLButtonElement[];
      const names = chips.map((c) => c.textContent);
      const chip = (name: string) => chips.find((c) => c.textContent === name)!;
      g.check(names.indexOf('a.js') >= 0 && names.indexOf('a.js') < names.indexOf('b.js'), `列出檔案,Alice 回報提到的排在前面(${names.join(', ')})`);
      await g.shot(`review-${H.zh ? 'zh' : 'en'}`);

      // 點檔名 → 檔案改動視窗打開,並展開、標示那個檔案。README.md 不能跳到 docs/README.md
      chip('README.md').click();
      await g.w(1500);
      const modal = document.querySelector('#diff-modal') as HTMLElement;
      const focused = document.querySelector('#diff-body .diff-file.focused') as HTMLElement | null;
      g.check(!modal.classList.contains('hidden'), '點檔名打開檔案改動視窗');
      g.check(!!focused && focused.dataset.path === 'README.md', `展開並標示的是 README.md,不是 docs/README.md(${focused && focused.dataset.path})`);
      g.check(!!focused && !(focused.querySelector('.diff-lines') as HTMLElement).hidden, '那個檔案的內容是展開的');
      g.check(!document.querySelector('#diff-body .diff-focus-missing'), '找得到的檔案不顯示「不在清單裡」');
      await g.shot(`diff-focus-${H.zh ? 'zh' : 'en'}`);
      (document.querySelector('#diff-close') as HTMLButtonElement).click();

      // 被 .gitignore 忽略的 debug.log:審查清單有,檔案改動沒有 → 要說明,不能打開了什麼都沒標
      chip('debug.log').click();
      await g.w(1500);
      const missing = document.querySelector('#diff-body .diff-focus-missing') as HTMLElement | null;
      g.check(!!missing && missing.offsetHeight > 0 && /debug\.log/.test(missing.textContent || ''), `點不在清單裡的檔案要有說明(${missing && missing.textContent})`);
      g.check(!document.querySelector('#diff-body .diff-file.focused'), '沒有標示其他檔案');
      await g.shot(`diff-missing-${H.zh ? 'zh' : 'en'}`);
      (document.querySelector('#diff-close') as HTMLButtonElement).click();

      const leaks = g.hiddenLeaks();
      g.check(leaks.length === 0, `沒有帶 hidden 卻仍佔版面的元素(${leaks.join(', ') || '無'})`);
      return { pass: pass && pass.textContent, issues: issues && issues.textContent, scope: scope.textContent };
    },
  });
  report(`審查結論與依據 · ${locale}`, r);
  r.cleanup();
  return r;
}

async function main() {
  const zh = await once('zh-Hant');
  const en = await once('en');
  if (!zh.ok || !en.ok) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
