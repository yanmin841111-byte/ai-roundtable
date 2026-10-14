import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { buildSync } from 'esbuild';
import { runApp, report, REPO_ROOT } from '../app';
import { scriptedMember } from '../fixtures';
import type { RendererApi, SessionSummary } from '../../../src/ipc-types';

declare const historyUnderTest: typeof import('../../../renderer/history') & typeof import('../../../renderer/i18n');
declare let historyApi: RendererApi;

async function scenario(H: { zh: boolean }) {
  const g: any = globalThis;
  await g.ready();
  const api = window.api;
  const root = (await api.getConfig()).settings.workDir;
  g.$('#settings-btn').click();
  await g.waitFor(() => g.text('#verify-suggestions').includes('npm test'), 10000, 'project commands detected via IPC');
  const workDir = g.$('#work-dir') as HTMLInputElement;
  const changeDirectory = (dir: string) => {
    workDir.value = dir;
    workDir.dispatchEvent(new Event('input'));
    g.check(g.$('#verify-suggestions').hidden, 'editing directory immediately clears old suggestions');
    workDir.dispatchEvent(new Event('change'));
    g.check(!g.$('#verify-suggestions').querySelector('button'), 'previous project commands cannot be clicked while loading');
  };
  changeDirectory(root + '/bad');
  await g.waitFor(() => g.$('#verify-suggestions [role="alert"]'), 10000, 'invalid package error displayed');
  g.check(g.text('#verify-suggestions').includes('package.json'), 'error names the invalid config');
  g.check(new RegExp(H.zh ? '無法偵測' : 'Could not detect').test(g.text('#verify-suggestions')), 'detection error is localized');
  g.$('#verify-suggestions button').click();
  g.check(!!g.$('#verify-suggestions [role="status"]') && !g.$('#verify-suggestions button'), 'retry enters loading state');
  await g.waitFor(() => g.$('#verify-suggestions [role="alert"]'), 10000, 'retry failure remains explicit');
  g.$('#verify-suggestions').scrollIntoView({ block: 'center' });
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const errorBounds = g.$('#verify-suggestions').getBoundingClientRect();
  g.check(errorBounds.top >= 0 && errorBounds.bottom <= innerHeight, 'error and retry controls are visible');
  await g.shot(H.zh ? 'detect-error-zh' : 'detect-error-en');
  changeDirectory(root + '/empty');
  await g.waitFor(() => g.$('#verify-suggestions').hidden, 10000, 'empty project has no error or commands');
  changeDirectory(root + '/bad');
  changeDirectory(root);
  await g.waitFor(() => g.text('#verify-suggestions').includes('npm test'), 10000, 'latest project wins after rapid directory switches');
  g.check(!g.$('#verify-suggestions [role="alert"]'), 'old errors cannot replace latest suggestions');
  g.$('#verify-suggestions .verify-chip').click();
  g.check(g.$('#verify-command').value === 'npm test', 'adding a suggestion preserves the existing workflow');
  g.check(!g.$('#verify-suggestions [role="status"]'), 'saving unrelated settings does not re-run detection');
  g.check(new RegExp(H.zh ? '不是整體支出的硬上限' : 'not a hard spending cap').test(g.text('[data-i18n="settings.maxTaskCostDesc"]')), 'repair budget scope is explicit');
  g.$('#settings-close').click();

  g.$('#history-toggle').click();
  for (const name of ['partial', 'unknown', 'zero', 'legacy']) {
    const row = await g.waitFor(() => g.$(`[data-session-id="${name}.json"] .history-open`), 10000, 'cost fixture listed');
    row.click();
    await g.waitFor(() => !g.$('#history-modal').classList.contains('hidden') && g.text('#history-modal-title') === name, 10000, 'history preview opened');
    g.$('#history-resume').click();
    await g.waitFor(() => g.$('#history-modal').classList.contains('hidden') && g.$(`#timeline [data-msg-id="${name}-summary"]`), 10000, 'cost fixture resumed');
    const head = g.text('#timeline .ts-head');
    const coverage = g.text('#timeline .ts-cost-coverage');
    const total = g.text('#usage-total');
    if (name === 'partial') {
      g.check(new RegExp(H.zh ? '已知成本' : 'Known cost').test(head), 'cost metric is explicitly labeled known');
      g.check(head.includes('$0.250') && coverage.includes('1/2'), 'partial cost amount and coverage are exact');
      g.check(new RegExp(H.zh ? '不代表免費' : 'does not mean free').test(coverage), 'missing cost is not presented as free');
      g.check(total.includes('1/2') && total.includes('$0.250'), 'conversation total includes turns without any usage');
      await g.shot(H.zh ? 'known-cost-zh' : 'known-cost-en');
    } else if (name === 'unknown') {
      g.check(!/已知成本|Known cost|\$/.test(head) && !coverage, 'no cost metric or warning when nothing reports cost');
      g.check(!/已知成本|Known cost|不代表免費|does not mean free/.test(total), 'header stays quiet when nothing reports cost');
    } else if (name === 'zero') {
      g.check(head.includes('$0.000') && !coverage, 'reported zero is shown without a coverage warning');
    } else {
      g.check(head.includes('$0.250') && new RegExp(H.zh ? '舊紀錄未保存' : 'older record did not save').test(coverage), 'legacy records do not invent coverage');
    }
  }

  // Bundle the real history module with a test-only API binding to control response order.
  historyUnderTest.setLocale(H.zh ? 'zh-Hant' : 'en');
  type Response = Awaited<ReturnType<RendererApi['sessions']['list']>>;
  const pending: Array<{ resolve: (value: Response) => void; reject: (error: Error) => void }> = [];
  historyApi = { ...api, sessions: { ...api.sessions, list: () => new Promise<Response>((resolve, reject) => pending.push({ resolve, reject })) } };
  const session = (title: string): SessionSummary => ({ id: title + '.json', title, agents: ['Member'], messageCount: 1, createdAt: '2026-01-01' });
  const seed = historyUnderTest.loadHistory();
  pending.shift()!.resolve({ sessions: [session('recent seed'), session('older seed')] });
  await seed;
  const search = g.$('#history-search') as HTMLInputElement;
  search.value = 'recent';
  historyUnderTest.renderHistoryList();
  const first = historyUnderTest.loadHistory(true);
  const firstReply = pending.shift()!;
  const latest = historyUnderTest.loadHistory(true);
  pending.shift()!.resolve({ sessions: [session('recent latest')] });
  await latest;
  firstReply.resolve({ sessions: [session('recent stale')] });
  await first;
  g.check(g.text('#history-list').includes('recent latest') && !g.text('#history-list').includes('stale'), 'late success cannot overwrite newer history');

  const oldFailure = historyUnderTest.loadHistory(true);
  const failureReply = pending.shift()!;
  const newest = historyUnderTest.loadHistory(true);
  failureReply.reject(new Error('obsolete failure'));
  await oldFailure;
  g.check(g.$('#history-refresh').disabled && g.$('#history-error').hidden, 'old failure cannot clear current loading state or show an error');
  pending.shift()!.resolve({ sessions: [session('recent newest')] });
  await newest;
  for (const structured of [false, true]) {
    const failed = historyUnderTest.loadHistory(true);
    g.check(g.text('#history-list').includes('recent newest'), 'refresh keeps the existing list visible');
    const reply = pending.shift()!;
    if (structured) reply.resolve({ sessions: [], error: 'permission denied' });
    else reply.reject(new Error('IPC failure'));
    await failed;
    g.check(!g.$('#history-error').hidden && !g.$('#history-refresh').disabled, 'latest failure is visible and retry remains possible');
    g.check(g.text('#history-list').includes('recent newest') && search.value === 'recent', 'failure preserves list and search');
  }
  const retry = historyUnderTest.loadHistory(true);
  pending.shift()!.resolve({ sessions: [session('recent recovered')] });
  await retry;
  g.check(g.$('#history-error').hidden && g.text('#history-list').includes('recent recovered'), 'successful retry clears error and updates history');
  g.check(g.hiddenLeaks().length === 0, 'hidden controls do not occupy space');
}

async function once(locale: 'zh-Hant' | 'en') {
  const bundled = buildSync({
    stdin: { contents: "export * from './renderer/history'; export { setLocale } from './renderer/i18n';", resolveDir: REPO_ROOT },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'historyUnderTest',
    define: { 'window.api': 'historyApi' },
  }).outputFiles[0].text;
  const result = await runApp({
    members: [scriptedMember({ id: 'a', name: 'Member' })],
    files: { 'package.json': '{"scripts":{"test":"node --test"}}', 'bad/package.json': '{' },
    settings: { uiLocale: locale },
    constants: { zh: locale === 'zh-Hant' },
    timeoutMs: 2 * 60 * 1000,
    beforeLaunch: ({ workDir, userData }) => {
      fs.mkdirSync(path.join(workDir, 'empty'));
      const dir = path.join(userData, 'sessions');
      fs.mkdirSync(dir);
      for (const name of ['partial', 'unknown', 'zero', 'legacy']) {
        const costUsd = name === 'unknown' ? null : name === 'zero' ? 0 : 0.25;
        const turnsWithCost = name === 'unknown' ? 0 : name === 'zero' ? 2 : 1;
        const messages = [
          { id: name + '-user', kind: 'user', text: name, ts: Date.now() },
          ...[0, 1].map((index) => ({
            id: name + '-' + index, kind: 'agent', agentId: 'a', agentName: 'Member', status: 'done', text: 'Done',
            ...(index < turnsWithCost ? { usage: { shape: 'anthropic', costUsd, inputTokens: 1, outputTokens: 1 } } : {}),
          })),
          { id: name + '-summary', kind: 'system', tag: 'task-summary', text: 'Summary', taskSummary: {
            startedAt: 1, endedAt: 1001, members: [], files: [], moreFiles: 0,
            usage: { inputTokens: 1, outputTokens: 1, costUsd, turns: 2, turnsWithUsage: turnsWithCost, ...(name === 'legacy' ? {} : { turnsWithCost }) },
          } },
        ];
        fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify({ title: name, messages }));
      }
    },
    scenario: `let historyApi;\n${bundled}\nreturn await (${scenario.toString()})(H);`,
  });
  const ok = report(`Workflow feedback (${locale})`, result);
  if (ok) result.cleanup();
  assert.ok(ok, result.error);
}

(async () => {
  await once('zh-Hant');
  await once('en');
})().catch((error) => { console.error(error); process.exitCode = 1; });
