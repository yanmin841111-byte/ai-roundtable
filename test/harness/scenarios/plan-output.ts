'use strict';

// 情境:主持人的分工原文(JSON)收起來,只留下方的「分工結果」卡片。
// 以前原文整串攤在時間線上,和下面的卡片講同一件事,而且難讀。中英文介面各跑一次。

import { runApp, report } from '../app';
import { scriptedMember } from '../fixtures';

async function once(locale: 'zh-Hant' | 'en') {
  const zh = locale === 'zh-Hant';
  const r = await runApp({
    members: [
      scriptedMember({
        id: 'a', name: 'Alice', canEdit: false,
        plan: { summary: zh ? '整理需求' : 'Gather requirements', assignments: [{ agent: 'A1', task: zh ? '列出需求' : 'List the requirements' }] },
        report: zh ? '需求如下' : 'Here are the requirements',
      }),
      scriptedMember({ id: 'b', name: 'Bob', canEdit: false }),
    ],
    settings: { leadAgentId: 'a', uiLocale: locale, language: zh ? '繁體中文' : 'English' },
    constants: { zh },
    timeoutMs: 3 * 60 * 1000,
    scenario: async (H: any) => {
      const g: any = globalThis;
      await g.ready();
      const msgs = await g.send(H.zh ? '請整理需求' : 'Please gather the requirements', 'divide');
      await g.w(500);
      const divide = msgs.find((m: any) => m.kind === 'agent' && m.phase && m.phase.code === 'divide');
      g.check(!!divide && divide.rawPlan === true, '分工原文標成已整理');
      const el = document.querySelector(`#timeline [data-msg-id="${divide.id}"]`) as HTMLElement;
      const details = el.querySelector('details.raw-plan') as HTMLDetailsElement | null;
      const raw = el.querySelector('.raw-plan-body') as HTMLElement | null;
      g.check(!!details && !details.open, '原文收在預設關閉的區塊裡');
      // 收起的 <details> 內容在 Chromium 是 content-visibility: hidden,offsetHeight 照樣有值,
      // 要用 checkVisibility 才問得到「畫面上看不看得到」
      g.check(!!raw && !raw.checkVisibility(), '畫面上看不到 JSON');
      const note = el.querySelector('.raw-plan-note') as HTMLElement;
      g.check(note && note.offsetHeight > 0 && new RegExp(H.zh ? '分工結果' : 'Work plan').test(note.textContent || ''), `說明指向下方的分工結果(${note && note.textContent})`);
      const card = Array.from(document.querySelectorAll('#timeline [data-msg-id]')).some((m) => new RegExp(H.zh ? '分工結果' : 'Work plan').test(m.textContent || '') && m !== el);
      g.check(card, '下方的分工結果卡片還在');
      await g.shot(`plan-collapsed-${H.zh ? 'zh' : 'en'}`);
      (details!.querySelector('summary') as HTMLElement).click();
      await g.w(300);
      g.check(details!.open && raw!.checkVisibility() && /assignments/.test(raw!.textContent || ''), '點開看得到原文');
      await g.shot(`plan-expanded-${H.zh ? 'zh' : 'en'}`);
      const leaks = g.hiddenLeaks();
      g.check(leaks.length === 0, `沒有帶 hidden 卻仍佔版面的元素(${leaks.join(', ') || '無'})`);
      return { note: note.textContent };
    },
  });
  report(`分工原文 · ${locale}`, r);
  r.cleanup();
  return r;
}

async function main() {
  const zh = await once('zh-Hant');
  const en = await once('en');
  if (!zh.ok || !en.ok) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
