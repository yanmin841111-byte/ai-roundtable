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

async function guarded(locale: 'zh-Hant' | 'en', outcome: 'passed' | 'plan' | 'review') {
  const zh = locale === 'zh-Hant';
  const result = await runApp({
    members: [
      scriptedMember({ id: 'lead', name: 'Alice', plan: { summary: 'Write notes', assignments: [{ agent: 'A2', task: 'Write notes.txt' }] } }),
      scriptedMember({ id: 'author', name: 'Bob', canEdit: true, writes: { 'notes.txt': 'Draft' }, fixWrites: { 'notes.txt': 'Revised' }, report: 'Draft ready', fixReport: 'Revised notes' }),
      scriptedMember({ id: 'reviewer', name: 'Carol', planReview: outcome === 'plan' ? 'Acceptance criteria missing' : '[AGREED]', review: 'Please revise the notes', recheck: outcome === 'review' ? 'Still incomplete' : '[NO_ISSUES]' }),
    ],
    settings: { leadAgentId: 'lead', maxRounds: 1, mode: 'guarded', workStyle: 'general', uiLocale: locale, language: zh ? '繁體中文' : 'English' },
    constants: { zh, outcome },
    scenario: async (context: any) => {
      const app: any = globalThis;
      await app.ready();
      const mode = document.querySelector('#mode') as HTMLSelectElement;
      app.check(mode.value === 'guarded', '新模式可從已保存設定載入');
      app.check(mode.selectedOptions[0].textContent === (context.zh ? '多 AI 把關' : 'Multi-AI checks'), '模式名稱跟隨介面語言');
      app.check(!!document.querySelector('#default-mode option[value="guarded"]'), '設定頁也能選擇新模式');
      const messages = await app.send('Write project notes', 'guarded');
      const message = messages.find((item: any) => item.taskSummary);
      app.check(!!message, '每種結束狀態都有結果卡');
      const summary = message.taskSummary;
      app.check(summary.guard.status === (context.outcome === 'passed' ? 'passed' : 'blocked'), '結果卡狀態與實際關卡一致');
      app.check(summary.guard.repairRounds === (context.outcome === 'plan' ? 0 : context.outcome === 'passed' ? 1 : 3), '結果卡保存實際修正輪數');
      const reviews = messages.filter((item: any) => item.review);
      app.check(reviews.length === (context.outcome === 'plan' ? 0 : context.outcome === 'passed' ? 4 : 8), '每輪皆由兩位非作者審查');
      const card = document.querySelector(`#timeline [data-msg-id="${message.id}"]`) as HTMLElement;
      app.check(!!card.querySelector('.task-summary'), '結果卡已渲染');
      const expected = context.outcome === 'plan'
        ? (context.zh ? '計畫未通過' : 'Plan not approved')
        : context.outcome === 'passed' ? (context.zh ? '全員審查通過' : 'All reviewers approved') : (context.zh ? '多 AI 把關未通過' : 'Multi-AI checks not passed');
      app.check(card.textContent?.includes(expected), '通過與阻擋狀態清楚顯示');
      app.check(card.scrollWidth <= card.clientWidth + 1, '結果卡沒有水平溢出');
      card.scrollIntoView({ block: 'center' });
      await app.shot(`guarded-${context.outcome}-${context.zh ? 'zh' : 'en'}`);
      return { guard: summary.guard, files: summary.files };
    },
  });
  report(`多 AI 把關 ${outcome} ${locale}`, result);
  if (result.ok && outcome !== 'plan' && result.read('notes.txt') !== 'Revised') throw new Error('Repaired content missing on disk');
  if (result.ok && outcome === 'plan' && result.read('notes.txt') !== null) throw new Error('Blocked plan changed files');
  result.cleanup();
  return result.ok;
}

async function main() {
  let guardedOk = true;
  for (const locale of ['zh-Hant', 'en'] as const) {
    for (const outcome of ['passed', 'plan', 'review'] as const) guardedOk = await guarded(locale, outcome) && guardedOk;
  }
  if (process.argv.includes('--guarded-only')) {
    if (!guardedOk) process.exitCode = 1;
    return;
  }
  const zh = await once('zh-Hant');
  const en = await once('en');
  if (!zh.ok || !en.ok || !guardedOk) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
