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
        recheck: zh ? '分號補上了\n[NO_ISSUES]' : 'The semicolon is there now\n[NO_ISSUES]',
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
      g.check(new RegExp(H.zh ? '任務結果.*驗收證據不足.*僅語法檢查通過.*秒' : 'Task result.*Incomplete evidence.*Syntax check only.*s').test(head), `標題、整體狀態與用時(${head})`);
      g.check(card!.classList.contains('tone-warn'), '只有語法檢查時不能看起來像可驗收');
      g.check(!!card!.querySelector('.ts-verify.syntax-only') && !card!.querySelector('.ts-verify.passed'), '語法限定徽章不是綠色通過');
      const evidence = card!.querySelector('.ts-evidence')!;
      g.check(new RegExp(H.zh ? '已檢查 2 個.*語法' : 'Syntax checked for 2').test(evidence.textContent || ''), '可直接查看檢查範圍');
      g.check(new RegExp(H.zh ? '未執行專案驗證指令' : 'No project verification commands ran').test(evidence.textContent || ''), '未執行的專案驗證明列');
      g.check(!!(evidence.compareDocumentPosition(card!.querySelector('.ts-members')!) & Node.DOCUMENT_POSITION_FOLLOWING), '證據在成員資訊之前');
      g.check(!!(card!.querySelector('.ts-files')!.compareDocumentPosition(card!.querySelector('.ts-review')!) & Node.DOCUMENT_POSITION_FOLLOWING), '先查看改動再做人工驗收');
      const memberDetails = card!.querySelector('.ts-member-details') as HTMLDetailsElement;
      g.check(!memberDetails.open, '成員明細預設收合');
      (memberDetails.querySelector('summary') as HTMLElement).click();
      g.check(memberDetails.open && (memberDetails.querySelector('.ts-member') as HTMLElement).offsetHeight > 0, '成員明細仍可展開查看');
      (memberDetails.querySelector('summary') as HTMLElement).click();
      const rows = Array.from(card!.querySelectorAll('.ts-member')).map((r) => (r.textContent || '').replace(/\s+/g, ' '));
      g.check(rows.some((r) => new RegExp(H.zh ? 'Alice.*✓ 審查通過.*Bob 審查' : 'Alice.*✓ Approved.*reviewed by Bob').test(r)), `Alice:審查通過(${rows.join(' / ')})`);
      g.check(rows.some((r) => new RegExp(H.zh ? 'Bob.*✓ 審查通過.*Alice 審查' : 'Bob.*✓ Approved.*reviewed by Alice').test(r)), `Bob:修好後複查通過(${rows.join(' / ')})`);
      // 時間線上:修復之後有一則標著「複查」的審查,結論是通過
      const recheck = Array.from(document.querySelectorAll('#timeline .msg')).find((m) => m.querySelector('.badge.recheck')) as HTMLElement | undefined;
      g.check(!!recheck && !!recheck.querySelector('.badge.verdict.pass') && new RegExp(H.zh ? '複查' : 're-check').test(recheck.querySelector('.badge.recheck')!.textContent || ''), '修復後的複查標著「複查」,結論是通過');
      const files = Array.from(card!.querySelectorAll('.ts-file')).map((f) => (f.textContent || '').replace(/\s+/g, ' ').trim());
      g.check(files.some((f) => /a\.js\s*\+2\s*−0/.test(f)) && files.some((f) => /b\.js\s*\+1\s*−0/.test(f)), `列出改動的檔案與行數(${files.join(' / ')})`);
      const timing = card!.querySelector('.ts-review') as HTMLElement;
      const action = (name: string) => (timing.querySelector(`[data-action="${name}"]`) as HTMLButtonElement).click();
      g.check(timing.dataset.state === 'notStarted', '不自動把待機時間當成人工驗收');
      action('start');
      const summaryId = card!.closest('[data-msg-id]')!.getAttribute('data-msg-id');
      const key = 'roundtable.review.v1:' + summaryId;
      await g.waitFor(() => JSON.parse(localStorage.getItem(key) || '{}').reviewMs >= 1000, 10000, '計時落地');
      action('start');
      g.check(timing.dataset.state === 'paused', '計時可暫停');
      const paused = JSON.parse(localStorage.getItem(key)!);
      action('incomplete');
      g.check(JSON.parse(localStorage.getItem(key)!).outcome === 'incomplete', '未完成獨立記錄,不能當成驗收通過');
      action('accept');
      await g.waitFor(() => timing.dataset.state === 'accepted', 10000, '驗收前版本比對');
      const accepted = JSON.parse(localStorage.getItem(key)!);
      g.check((timing.querySelector('[data-action="accept"]') as HTMLButtonElement).disabled, '已驗收版本不能重複提交');
      g.check(Array.from(card!.querySelectorAll<HTMLButtonElement>('button.icon-only')).every((control) => !!control.title && !!control.getAttribute('aria-label') && !!control.querySelector('svg')), '圖示工具都有提示與可存取名稱');
      g.check(accepted.outcome === 'accepted' && accepted.reviewMs === paused.reviewMs && accepted.decidedAt >= accepted.deliveredAt, '人工驗收與累計時間持久保存');
      g.check(card!.classList.contains('tone-warn') && accepted.startedAt > 0, '人工判定不覆寫語法限定的警示');
      g.check(!new RegExp(H.zh ? '待人工驗收' : 'Awaiting human acceptance').test(card!.textContent || ''), '已驗收後不再顯示待驗收');
      const originalUrl = URL.createObjectURL;
      const originalClick = HTMLAnchorElement.prototype.click;
      let exported: Blob | null = null;
      let filename = '';
      try {
        URL.createObjectURL = (value) => { exported = value as Blob; return originalUrl(value); };
        HTMLAnchorElement.prototype.click = function () { filename = this.download; };
        action('export');
        await g.waitFor(() => !!exported, 10000, '匯出前版本比對');
      } finally {
        URL.createObjectURL = originalUrl;
        HTMLAnchorElement.prototype.click = originalClick;
      }
      const record = JSON.parse(await (exported as unknown as Blob).text());
      g.check(record.timing.taskId === summaryId && record.timing.reviewMs === accepted.reviewMs && record.timing.outcome === 'accepted' && filename.endsWith('.json'), '匯出的是本次任務實際的計時與判定');
      const timeline = document.querySelector('#timeline') as HTMLElement;
      const positionCard = () => { timeline.scrollTop += card!.getBoundingClientRect().top - timeline.getBoundingClientRect().top - 80; };
      positionCard();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await g.shot(`card-${H.zh ? 'zh' : 'en'}`);
      card!.style.maxWidth = '360px';
      positionCard();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      g.check(card!.scrollWidth <= card!.clientWidth + 2, '窄版結果卡沒有水平溢位');
      const bounds = card!.getBoundingClientRect();
      g.check(bounds.width > 0 && bounds.width <= 360, `結果卡實際寬度為 ${bounds.width}px`);
      g.check(Array.from(timeline.querySelectorAll('.tl-stage')).every((marker) => marker.getBoundingClientRect().bottom <= bounds.top || marker.getBoundingClientRect().top >= bounds.bottom), '固定階段列不遮住結果卡標題');
      g.check(Array.from(card!.querySelectorAll('.ts-review-actions button')).every((control) => control.getBoundingClientRect().right <= bounds.right), '窄版計時按鈕完整可見');
      await g.shot(`card-narrow-${H.zh ? 'zh' : 'en'}`);
      card!.style.maxWidth = '';

      // 點檔名跳到「檔案改動」的那個檔案
      (Array.from(card!.querySelectorAll('.ts-file')).find((f) => /a\.js/.test(f.textContent || '')) as HTMLButtonElement).click();
      await g.waitFor(() => document.querySelector('#diff-body .diff-file.focused'), 10000, '跳到檔案');
      const focused = document.querySelector('#diff-body .diff-file.focused') as HTMLElement;
      g.check(focused.dataset.path === 'a.js', `點檔名跳到 a.js(${focused.dataset.path})`);
      (document.querySelector('#diff-close') as HTMLButtonElement).click();

      const leaks = g.hiddenLeaks();
      g.check(leaks.length === 0, `沒有帶 hidden 卻仍佔版面的元素(${leaks.join(', ') || '無'})`);
      const member = document.querySelector('#agent-list .agent-card') as HTMLElement;
      member.focus();
      member.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await g.waitFor(() => !document.querySelector('#modal')!.classList.contains('hidden'), 5000, '鍵盤開啟成員設定');
      g.check(member.tabIndex === 0 && member.getAttribute('role') === 'button', '成員列可用鍵盤操作');
      (document.querySelector('#modal-close') as HTMLButtonElement).click();
      (document.querySelector('input[name="theme"][value="dark"]') as HTMLInputElement).click();
      await g.waitFor(() => document.documentElement.dataset.theme === 'dark', 5000, '深色模式');
      const darkCard = document.querySelector('#timeline .task-summary') as HTMLElement;
      timeline.scrollTop += darkCard.getBoundingClientRect().top - timeline.getBoundingClientRect().top - 80;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await g.shot(`card-dark-${H.zh ? 'zh' : 'en'}`);
      return { head, rows, files };
    },
  });
  report(`任務結果卡 · ${locale}`, r);
  r.cleanup();
  return r;
}

async function failedEvidence() {
  const result = await runApp({
    members: [
      scriptedMember({ id: 'author', name: 'Author', canEdit: true, plan: { summary: 'Create JSON', assignments: [{ agent: 'A1', task: 'Create data.json' }] }, writes: { 'data.json': '{"ok":true}\n' }, report: 'Created JSON' }),
      scriptedMember({ id: 'reviewer', name: 'Reviewer', review: '[NO_ISSUES]' }),
    ],
    settings: { uiLocale: 'en', language: 'English', leadAgentId: 'author', workStyle: 'code', verifyCommand: 'echo acceptance-test-failed; exit 2\necho later-gate' },
    scenario: async () => {
      const g: any = globalThis;
      await g.ready();
      const messages = await g.send('Create data.json', 'divide');
      const message = messages.find((item: any) => item.tag === 'task-summary');
      const data = message.taskSummary;
      g.check(data.verify === 'failed' && data.verification.gates.length === 1 && data.verification.gates[0].code === 2, '失敗指令與結束碼保存進摘要');
      g.check(data.verification.skippedCommands[0] === 'echo later-gate', '未執行的指令保留');
      g.check(/acceptance-test-failed/.test(message.text) && /Not run after earlier failure/.test(message.text), '匯出與歷史純文字含驗證證據');
      const card = document.querySelector('#timeline .task-summary') as HTMLElement;
      g.check(/Issues to resolve/.test(card.querySelector('.ts-state')!.textContent || ''), '驗證失敗不被模型放行掩蓋');
      const evidence = card.querySelector('.ts-evidence') as HTMLElement;
      g.check(/Failed: echo acceptance-test-failed/.test(evidence.textContent || '') && /Exit code: 2/.test(evidence.textContent || '') && /Not run after earlier failure: echo later-gate/.test(evidence.textContent || ''), '結果卡直接列出失敗與未執行證據');
      for (const detail of Array.from(evidence.querySelectorAll('details'))) detail.open = true;
      (card.querySelector('[data-action="accept"]') as HTMLButtonElement).click();
      await g.waitFor(() => (card.querySelector('.ts-review') as HTMLElement).dataset.state === 'accepted', 10000, '人工驗收保存');
      g.check(/Issues to resolve/.test(card.querySelector('.ts-state')!.textContent || ''), '人工標記不覆蓋失敗警示');
      card.scrollIntoView({ block: 'start' });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await g.shot('failed-evidence');
      return { verification: data.verification };
    },
  });
  report('驗收失敗證據', result);
  result.cleanup();
  return result;
}

async function staleEvidence() {
  const result = await runApp({
    members: [
      scriptedMember({ id: 'author', name: 'Author', canEdit: true, plan: { summary: 'Create source', assignments: [{ agent: 'A1', task: 'Create a.js' }] }, writes: { 'a.js': 'module.exports = 1;\n' }, report: 'Created source' }),
      scriptedMember({ id: 'reviewer', name: 'Reviewer', review: '[NO_ISSUES]' }),
    ],
    settings: { uiLocale: 'en', language: 'English', leadAgentId: 'author', workStyle: 'code', verifyCommand: 'exit 0' },
    scenario: async () => {
      const g: any = globalThis;
      const api = (window as any).api;
      await g.ready();
      const messages = await g.send('Create a.js', 'divide');
      const message = messages.find((item: any) => item.tag === 'task-summary');
      const original = message.taskSummary.verification;
      const agentCount = (await api.snapshot()).messages.filter((item: any) => item.kind === 'agent').length;
      const card = () => document.querySelector('#timeline .task-summary') as HTMLElement;
      const click = (selector: string) => (card().querySelector(selector) as HTMLButtonElement).click();
      await g.waitFor(() => card().querySelector('.ts-freshness')?.getAttribute('data-freshness') === 'current', 10000, '版本比對完成');
      click('[data-action="accept"]');
      await g.waitFor(() => card().querySelector('.ts-review')?.getAttribute('data-state') === 'accepted', 10000, '首次驗收');
      const terminal = await api.terminal.create({});
      g.check(terminal.ok, '使用真實終端模擬外部改檔');
      await api.terminal.write(terminal.session.id, "printf 'module.exports = 2;\\n' > a.js\r");
      await g.waitFor(async () => (await api.taskVerification(message.id)).freshness === 'stale', 10000, '磁碟改動可被辨識');
      window.dispatchEvent(new Event('focus'));
      await g.waitFor(() => card().querySelector('.ts-freshness')?.getAttribute('data-freshness') === 'stale', 10000, '回到 app 更新過期狀態');
      g.check(!card().querySelector('.ts-head .ts-verify.passed'), '過期證據不顯示綠色驗證徽章');
      g.check(card().querySelector('.ts-review')?.getAttribute('data-state') === 'previousAccepted', '先前版本的人工驗收不能沿用');
      const originalUrl = URL.createObjectURL;
      const originalClick = HTMLAnchorElement.prototype.click;
      let exported: Blob | null = null;
      try {
        URL.createObjectURL = (value) => { exported = value as Blob; return originalUrl(value); };
        HTMLAnchorElement.prototype.click = function () {};
        click('[data-action="export"]');
        await g.waitFor(() => !!exported, 10000, '過期證據匯出');
      } finally {
        URL.createObjectURL = originalUrl;
        HTMLAnchorElement.prototype.click = originalClick;
      }
      const record = JSON.parse(await (exported as unknown as Blob).text());
      g.check(record.freshness === 'stale' && record.acceptanceCurrent === false && record.timing.outcome === 'accepted', '匯出區分舊人工判定與目前版本狀態');
      g.check(record.verificationEvidence.revision === original.revision && record.verificationEvidence.gates[0].command === 'exit 0', '匯出保留實際驗證證據');
      click('[data-action="accept"]');
      await g.waitFor(() => /Reverify first/.test(card().querySelector('.ts-review .ts-review-error')?.textContent || ''), 10000, '阻擋過期驗收');
      const originalConfirm = window.confirm;
      let confirmation = '';
      try {
        window.confirm = (text) => { confirmation = String(text); return false; };
        click('.ts-reverify');
        await g.waitFor(() => !!confirmation, 10000, '重驗確認');
        g.check(/exit 0/.test(confirmation) && /working directory/.test(confirmation), '確認視窗顯示實際指令與目錄');
        g.check(!(await api.snapshot()).messages.find((item: any) => item.id === message.id).taskSummary.verificationHistory, '按取消不執行重驗');
        window.confirm = () => true;
        click('.ts-reverify');
        await g.waitFor(async () => (await api.snapshot()).messages.find((item: any) => item.id === message.id).taskSummary.verificationHistory?.length === 1, 15000, '重驗完成');
      } finally { window.confirm = originalConfirm; }
      await g.waitFor(() => card().querySelector('.ts-freshness')?.getAttribute('data-freshness') === 'current', 10000, '新版證據一致');
      const snapshot = await api.snapshot();
      const updated = snapshot.messages.find((item: any) => item.id === message.id).taskSummary;
      g.check(updated.verification.revision !== original.revision && updated.verify === 'passed', '重新驗證綁定新內容');
      g.check(updated.reviewStale && /earlier version/.test(card().textContent || ''), '重驗通過不代表原審查結論適用新版');
      g.check(snapshot.messages.filter((item: any) => item.kind === 'agent').length === agentCount, '重驗沒有額外模型回合');
      g.check(updated.verificationHistory[0].revision === original.revision && !!card().querySelector('.ts-verification-history'), '原證據保留且可展開');
      g.check(card().querySelector('.ts-review')?.getAttribute('data-state') === 'previousAccepted', '新證據不自動套用舊驗收');
      await api.terminal.close(terminal.session.id);
      const timeline = document.querySelector('#timeline') as HTMLElement;
      timeline.scrollTop += card().getBoundingClientRect().top - timeline.getBoundingClientRect().top - 80;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await g.shot('reverified-evidence');
      return { updated };
    },
  });
  report('版本過期與重新驗證', result);
  const preserved = result.read('a.js') === 'module.exports = 2;\n';
  if (!preserved) result.ok = false;
  result.cleanup();
  return result;
}

async function generalAcceptance() {
  const result = await runApp({
    members: [
      scriptedMember({ id: 'author', name: 'Author', plan: { summary: 'Draft a note', assignments: [{ agent: 'A1', task: 'Draft a note' }] }, report: 'Drafted the note.' }),
      scriptedMember({ id: 'reviewer', name: 'Reviewer', review: '[NO_ISSUES]' }),
    ],
    settings: { uiLocale: 'en', language: 'English', leadAgentId: 'author', workStyle: 'general' },
    scenario: async () => {
      const g: any = globalThis;
      await g.ready();
      const messages = await g.send('Draft a note', 'divide');
      const message = messages.find((item: any) => item.tag === 'task-summary');
      g.check(!message.taskSummary.verification, '一般任務不執行程式驗證');
      const card = document.querySelector('#timeline .task-summary') as HTMLElement;
      (card.querySelector('[data-action="accept"]') as HTMLButtonElement).click();
      await g.waitFor(() => card.querySelector('.ts-review')?.getAttribute('data-state') === 'manualAccepted', 10000, '一般任務仍可人工驗收');
      const timing = JSON.parse(localStorage.getItem('roundtable.review.v1:' + message.id) || '{}');
      g.check(timing.outcome === 'accepted' && !timing.acceptedEvidence, '人工判定不捏造版本證據');
      g.check(/no file-version verification/.test(card.textContent || '') && !card.querySelector('.ts-verify.passed'), '未驗證狀態仍清楚可見');
    },
  });
  report('一般任務人工驗收', result);
  result.cleanup();
  return result;
}

async function main() {
  const zh = await once('zh-Hant');
  const en = await once('en');
  const failure = await failedEvidence();
  const stale = await staleEvidence();
  const general = await generalAcceptance();
  if (!zh.ok || !en.ok || !failure.ok || !stale.ok || !general.ok) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
