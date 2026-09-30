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
      const planBubble = Array.from(document.querySelectorAll('#timeline .msg.system .bubble')).find((b) => /<li/i.test(b.innerHTML) && new RegExp(H.zh ? '分工結果' : 'Work plan').test(b.textContent || '')) as HTMLElement | undefined;
      const radius = planBubble ? parseFloat(getComputedStyle(planBubble).borderTopLeftRadius) : NaN;
      g.check(!!planBubble && radius <= 20, `多行分工卡片不被畫成橢圓(圓角 ${radius}px)`);
      planBubble?.scrollIntoView({ block: 'center' });
      await g.shot(`plan-card-${H.zh ? 'zh' : 'en'}`);
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

async function guarded(locale: 'zh-Hant' | 'en', outcome: 'passed' | 'plan' | 'review' | 'retry' | 'retry-blocked' | 'continue' | 'format' | 'counterexample' | 'counterexample-kept' | 'counterexample-retry' | 'counterexample-pending') {
  const zh = locale === 'zh-Hant';
  const passes = ['passed', 'retry', 'continue', 'format', 'counterexample', 'counterexample-retry'].includes(outcome);
  const counterexample = outcome.startsWith('counterexample');
  const rejection = JSON.stringify({ decision: 'withdraw_counterexample', expectationContradictsRequirement: true, requirement: 'Write project notes', reason: 'The assertion compares unrelated constants, not the requested notes.' });
  const expectedRounds = { passed: 1, plan: 0, review: 3, retry: 1, 'retry-blocked': 0, continue: 1, format: 0, counterexample: 0, 'counterexample-kept': 0, 'counterexample-retry': 0, 'counterexample-pending': 0 }[outcome];
  const expectedReviews = { passed: 4, plan: 0, review: 8, retry: 5, 'retry-blocked': 3, continue: 4, format: 3, counterexample: 3, 'counterexample-kept': 2, 'counterexample-retry': 3, 'counterexample-pending': 2 }[outcome];
  const malformed = outcome === 'counterexample-retry' || outcome === 'counterexample-pending';
  const retain = JSON.stringify({ decision: 'retain_counterexample', expectationContradictsRequirement: false, requirement: 'Write project notes', reason: 'This expectation is required.' });
  const result = await runApp({
    members: [
      scriptedMember({ id: 'lead', name: 'Alice', plan: { summary: 'Write notes', assignments: [{ agent: 'A2', task: 'Write notes.txt' }], acceptance: ['notes.txt exists'] }, counterexampleReview: malformed ? 'not JSON' : outcome === 'counterexample-kept' ? retain : `\`\`\`json\n${rejection}\n\`\`\``, counterexampleClarification: outcome === 'counterexample-retry' ? rejection : 'still not JSON' }),
      scriptedMember({ id: 'author', name: 'Bob', canEdit: true, writes: { 'notes.txt': 'Draft' }, fixWrites: { 'notes.txt': 'Revised' }, report: 'Draft ready', fixReport: 'Revised notes' }),
      scriptedMember({ id: 'reviewer', name: 'Carol', planReview: outcome === 'plan' ? 'Acceptance criteria missing' : '[AGREED]', planReviews: outcome === 'continue' ? ['Acceptance criteria missing', '[AGREED]'] : undefined, review: outcome === 'format' ? '`[NO_ISSUES]`' : counterexample ? '```counterexample Invalid expectation\nrequire("node:assert/strict").equal(1, 2);\n```' : 'Please revise the notes', recheck: outcome === 'review' ? 'Still incomplete' : '[NO_ISSUES]', reviewFailures: outcome === 'retry' ? 1 : outcome === 'retry-blocked' ? 2 : 0, reviewClarification: '[NO_ISSUES]', counterexampleReview: rejection }),
    ],
    settings: { leadAgentId: 'lead', maxRounds: 1, mode: 'guarded', workStyle: counterexample ? 'code' : 'general', verifyCommand: counterexample ? 'node -e "require(\'node:fs\').accessSync(\'notes.txt\')"' : '', uiLocale: locale, language: zh ? '繁體中文' : 'English' },
    constants: { zh, outcome, passes, expectedRounds, expectedReviews, counterexample },
    scenario: async (context: any) => {
      const app: any = globalThis;
      await app.ready();
      const mode = document.querySelector('#mode') as HTMLSelectElement;
      app.check(mode.value === 'guarded', '新模式可從已保存設定載入');
      app.check(mode.selectedOptions[0].textContent === (context.zh ? '多 AI 把關' : 'Multi-AI checks'), '模式名稱跟隨介面語言');
      app.check(!!document.querySelector('#default-mode option[value="guarded"]'), '設定頁也能選擇新模式');
      let messages = await app.send('Write project notes', 'guarded');
      if (context.outcome === 'continue') {
        const blocked = messages.find((item: any) => item.planResumable);
        app.check(!!blocked && blocked.taskSummary.guard.status === 'blocked', '計畫阻擋後提供續訂入口');
        const button = document.querySelector(`#timeline [data-msg-id="${blocked.id}"] .ts-plan-resume`) as HTMLButtonElement;
        app.check(!!button && button.textContent?.includes(context.zh ? '繼續修訂計畫' : 'Continue plan revision'), '續訂按鈕使用目前語言');
        button.scrollIntoView({ block: 'center' });
        await app.shot(`guarded-continue-before-${context.zh ? 'zh' : 'en'}`);
        const discussions = messages.filter((item: any) => item.phase?.code === 'discuss' && !item.group).length;
        button.click();
        await app.waitFor(() => !button.isConnected, 30000, '續訂入口已消耗');
        await app.waitIdle(60000);
        messages = (await app.snapshot()).messages;
        app.check(messages.filter((item: any) => item.phase?.code === 'discuss' && !item.group).length === discussions, '續訂沒有重跑討論');
        app.check(messages.filter((item: any) => item.taskSummary).length === 2, '舊的阻擋結果與新的交付結果都保留');
        app.check(!messages.some((item: any) => item.planResumable), '已使用的草稿不可再啟動');
      }
      const message = [...messages].reverse().find((item: any) => item.taskSummary);
      app.check(!!message, '每種結束狀態都有結果卡');
      const summary = message.taskSummary;
      app.check(summary.guard.status === (context.passes ? 'passed' : 'blocked'), '結果卡狀態與實際關卡一致');
      app.check(summary.guard.repairRounds === context.expectedRounds, '結果卡保存實際修正輪數');
      const reviews = messages.filter((item: any) => item.review);
      app.check(reviews.length === context.expectedReviews, '審查與有限次重試的回合數正確');
      if (context.outcome === 'format') {
        app.check(messages.filter((item: any) => item.tag === 'review-format').length === 1, '只要求一次格式澄清');
        app.check(reviews.some((item: any) => item.text === '`[NO_ISSUES]`' && item.review.verdict === 'issues'), '格式錯誤的原票保留');
      }
      if (context.counterexample) {
        const evidence = summary.counterexamples?.[0];
        app.check(evidence?.confirmation === (context.passes ? 'rejected' : 'pending'), '反例撤回必須一致同意,未釐清時不當成確認缺陷');
        app.check(evidence?.output.includes('AssertionError'), '原始失敗輸出仍保留');
        app.check(context.passes ? evidence.rejection?.length === 2 && !evidence.afterRepair : !evidence.rejection, '撤回理由與修復後狀態沒有混淆');
        const assessments = messages.filter((item: any) => item.kind === 'agent' && item.phase?.code === 'review' && !item.review);
        const clarified = context.outcome === 'counterexample-retry' || context.outcome === 'counterexample-pending';
        app.check(assessments.length === (clarified ? 3 : 2), '格式澄清最多一次,有效票不重跑');
        if (clarified) app.check(assessments.some((item: any) => item.text.trim() === 'not JSON'), '原始格式錯誤仍保留');
        app.check(!messages.some((item: any) => item.kind === 'agent' && item.phase?.code === 'fix'), '證據澄清不觸發修復');
      }
      if (context.outcome === 'retry' || context.outcome === 'retry-blocked') {
        const notices = messages.filter((item: any) => item.tag === 'review-retry');
        app.check(notices.length === 1, '只通知一次自動重試');
        const notice = document.querySelector(`#timeline [data-msg-id="${notices[0].id}"]`) as HTMLElement;
        app.check(!!notice && new RegExp(context.zh ? '全新上下文重試一次' : 'Retrying once with a fresh context').test(notice.textContent || ''), '重試通知跟隨介面語言');
        const failures = reviews.filter((item: any) => item.review.verdict === 'failed');
        app.check(failures.length === (context.outcome === 'retry' ? 1 : 2), '原失敗紀錄沒有被覆蓋');
        app.check(reviews.filter((item: any) => item.agentId === 'lead').length === (context.passes ? 2 : 1), '成功票不因另一位失敗而重跑');
        const failed = document.querySelector(`#timeline [data-msg-id="${failures[0].id}"]`) as HTMLElement;
        app.check(!!failed && !(failed.querySelector('.retry-btn') as HTMLElement | null)?.checkVisibility(), '失敗紀錄仍在且不能手動繞過把關重試');
        notice.scrollIntoView({ block: 'center' });
        await app.shot(`guarded-${context.outcome}-notice-${context.zh ? 'zh' : 'en'}`);
      }
      const card = document.querySelector(`#timeline [data-msg-id="${message.id}"]`) as HTMLElement;
      app.check(!!card.querySelector('.task-summary'), '結果卡已渲染');
      if (context.counterexample && context.passes) {
        app.check(card.textContent?.includes(context.zh ? '已撤回' : 'Withdrawn'), '結果卡顯示撤回狀態');
        app.check(card.textContent?.includes('unrelated constants'), '結果卡保存具體撤回理由');
      }
      if (context.counterexample && !context.passes) {
        app.check(card.textContent?.includes(context.zh ? '需求判定待釐清' : 'Requirement assessment unresolved'), '結果卡呈現待釐清,不是缺陷確認或通過');
      }
      const expected = context.outcome === 'plan'
        ? (context.zh ? '計畫未通過' : 'Plan not approved')
        : context.passes ? (context.zh ? '全員審查通過' : 'All reviewers approved') : (context.zh ? '多 AI 把關未通過' : 'Multi-AI checks not passed');
      app.check(card.textContent?.includes(expected), '通過與阻擋狀態清楚顯示');
      app.check(card.scrollWidth <= card.clientWidth + 1, '結果卡沒有水平溢出');
      card.scrollIntoView({ block: 'center' });
      await app.shot(`guarded-${context.outcome}-${context.zh ? 'zh' : 'en'}`);
      return { guard: summary.guard, files: summary.files };
    },
  });
  report(`多 AI 把關 ${outcome} ${locale}`, result);
  if (result.ok && outcome !== 'plan' && result.read('notes.txt') !== (expectedRounds === 0 ? 'Draft' : 'Revised')) throw new Error('Content on disk does not match the repair outcome');
  if (result.ok && outcome === 'plan' && result.read('notes.txt') !== null) throw new Error('Blocked plan changed files');
  if (result.ok && counterexample && result.read('.roundtable/counterexamples.json') !== null) throw new Error('Withdrawn or pending counterexamples entered the corpus');
  result.cleanup();
  return result.ok;
}

async function main() {
  let guardedOk = true;
  const retryOnly = process.argv.includes('--retry-only');
  const continueOnly = process.argv.includes('--continue-only');
  const evidenceOnly = process.argv.includes('--evidence-only');
  for (const locale of ['zh-Hant', 'en'] as const) {
    for (const outcome of evidenceOnly ? ['format', 'counterexample', 'counterexample-kept', 'counterexample-retry', 'counterexample-pending'] as const : continueOnly ? ['continue'] as const : retryOnly ? ['retry', 'retry-blocked'] as const : ['passed', 'plan', 'review', 'retry', 'retry-blocked', 'continue', 'format', 'counterexample', 'counterexample-kept', 'counterexample-retry', 'counterexample-pending'] as const) guardedOk = await guarded(locale, outcome) && guardedOk;
  }
  if (retryOnly || continueOnly || evidenceOnly || process.argv.includes('--guarded-only')) {
    if (!guardedOk) process.exitCode = 1;
    return;
  }
  const zh = await once('zh-Hant');
  const en = await once('en');
  if (!zh.ok || !en.ok || !guardedOk) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
