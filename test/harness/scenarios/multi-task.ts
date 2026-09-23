'use strict';

// 情境:多件獨立任務。
//   - 不同專案目錄的兩件任務同時進行,各自的對話不互相混進去
//   - 同一個目錄的第三件任務排隊,畫面說明在等什麼;按停止取消排隊,內容放回輸入框
//   - 再送一次,前一件結束後自動開始,最後三件都結束
// 全用假成員,每回合刻意等幾秒,讓執行時間真的重疊。

import fs from 'fs';
import path from 'path';
import { runApp, report } from '../app';
import { scriptedMember } from '../fixtures';

async function main() {
  const r = await runApp({
    members: [scriptedMember({ id: 'slow', name: '慢', delayMs: 10000 })],
    beforeLaunch: ({ tmp }) => fs.mkdirSync(path.join(tmp, 'work2'), { recursive: true }),
    timeoutMs: 3 * 60 * 1000,
    scenario: async () => {
      const g: any = globalThis;
      const api = (window as any).api;
      await g.ready();
      const workDir = (await api.getConfig()).settings.workDir;
      const work2 = workDir.replace(/work$/, 'work2');
      const setWorkDir = async (dir: string) => { const cfg = await api.getConfig(); cfg.settings.workDir = dir; await api.saveConfig(cfg); };
      const jobs = async () => (await api.jobs.list()).jobs;
      const statusOf = async (id: string) => (await jobs()).find((j: any) => j.id === id)?.status;

      await api.send('@慢 甲任務', 'divide');
      const first = api.jobs.current();
      await g.waitFor(async () => (await statusOf(first)) === 'running', 5000, '第一件開始');

      g.$('#job-new').click();
      await g.waitFor(() => api.jobs.current() !== first, 5000, '切到新任務');
      const second = api.jobs.current();
      await setWorkDir(work2);
      await api.send('@慢 乙任務', 'divide');
      await g.waitFor(async () => (await statusOf(second)) === 'running', 5000, '第二件開始');
      g.check((await statusOf(first)) === 'running', '不同目錄的兩件任務同時進行');
      g.check(document.querySelectorAll('#job-list .job-item').length === 2, '側欄列出兩件任務');

      g.$('#job-new').click();
      await g.waitFor(() => ![first, second].includes(api.jobs.current()), 5000, '切到第三件');
      const third = api.jobs.current();
      await setWorkDir(workDir);
      await api.send('@慢 丙任務', 'divide');
      const queued = (await jobs()).find((j: any) => j.id === third);
      g.check(queued.status === 'queued' && queued.waitingFor === 'workdir', `同一個目錄的任務排隊等目錄(${queued.status}/${queued.waitingFor})`);
      await g.waitFor(() => !g.$('#job-queue-note').hidden, 3000, '排隊提示出現');
      g.check(/等同一個專案/.test(g.text('#job-queue-note')), '排隊提示說明在等什麼');
      g.check(!g.$('#stop-btn').disabled, '排隊中可以按停止');
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await g.shot('01-queued');

      g.$('#stop-btn').click();
      await g.waitFor(() => g.$('#input').value === '@慢 丙任務', 3000, '取消排隊後內容放回輸入框');
      g.check((await statusOf(third)) === 'idle', '取消排隊後回到尚未開始');
      g.check(g.$('#job-queue-note').hidden, '排隊提示收起來');

      g.$('#input').value = '';
      await api.send('@慢 丙任務', 'divide');
      g.check((await statusOf(third)) === 'queued', '再送一次重新排隊');
      await g.waitFor(async () => (await jobs()).every((j: any) => j.status === 'done'), 60000, '三件都結束');
      g.check((await statusOf(first)) === 'done' && (await statusOf(second)) === 'done', '前兩件正常結束');

      // 對話各自獨立:切回第一件只看得到甲
      g.$(`#job-list [data-job-id="${first}"] .job-open`).click();
      await g.waitFor(() => api.jobs.current() === first && /甲任務/.test(g.text('#timeline')), 5000, '切回第一件');
      const timeline = g.text('#timeline');
      g.check(!/乙任務|丙任務/.test(timeline), '第一件的時間軸沒有混進別件任務的訊息');
      const snap = await api.snapshot();
      g.check(snap.messages.filter((m: any) => m.kind === 'user').map((m: any) => m.text).join('|') === '@慢 甲任務', '第一件的紀錄只有自己的訊息');
      g.check((await api.revertTask()).reason === 'stale', '同目錄較新的任務完成後,舊任務不能覆蓋它的成果');
      g.check(/work$/.test(g.$('#workdir-chip').title.match(/使用 (.*?);/)?.[1] || ''), '工作目錄膠囊顯示這件任務固定的目錄');
      const attached = await api.attachments.add([{ name: 'first.txt', data: new TextEncoder().encode('first task only').buffer }]);
      g.check(attached.attachments.length === 1, '第一件可保留自己的待送附件');
      g.$(`#job-list [data-job-id="${second}"] .job-open`).click();
      await g.waitFor(() => /乙任務/.test(g.text('#timeline')), 5000, '切到第二件');
      g.check(/work2/.test(g.$('#workdir-chip').title), '第二件用的是另一個目錄');
      g.check((await api.attachments.list()).attachments.length === 0, '第二件沒有混入第一件的待送附件');
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await g.shot('02-done');

      const sessions = (await api.sessions.list()).sessions;
      g.check(sessions.length === 3, `每件任務各自存成一筆紀錄(${sessions.length})`);
      g.check(g.hiddenLeaks().length === 0, `沒有 hidden 卻佔版面的元素(${g.hiddenLeaks().join(',')})`);

      await api.send('@慢 乙續作', 'divide');
      await g.waitFor(async () => (await statusOf(second)) === 'running', 5000, '第二件繼續執行');
      g.$(`#job-list [data-job-id="${first}"] .job-open`).click();
      await g.waitFor(() => /甲任務/.test(g.text('#timeline')), 5000, '切回第一件送出續作');
      await g.waitFor(() => /first.txt/.test(g.text('#attach-chips')), 3000, '附件在自己的任務恢復');
      await api.send('@慢 甲續作', 'divide');
      await g.waitFor(async () => (await statusOf(first)) === 'running', 5000, '第一件繼續執行');
      g.$('#stop-btn').click();
      await g.waitFor(async () => (await statusOf(first)) === 'stopped', 5000, '只停止第一件');
      g.check((await statusOf(second)) === 'running', '停止第一件不會停止另一件正在執行的任務');
      await g.waitFor(async () => (await statusOf(second)) === 'done', 30000, '第二件繼續到完成');
      g.check((await api.sessions.list()).sessions.length === 3, '續作仍各自寫回原紀錄');
      await api.send('@慢 reset in progress', 'divide');
      await g.waitFor(async () => (await statusOf(first)) === 'running', 5000, '重設前任務正在執行');
      await api.reset();
      const reset = await api.snapshot();
      g.check(!reset.running && reset.messages.length === 0, '新對話先停止執行中的任務,再清空對話');
      g.check((await statusOf(second)) === 'done', '重設第一件不影響第二件的結果');
      return { ok: true };
    },
  });
  report('多件獨立任務', r);
  if (!r.ok) process.exitCode = 1;
  r.cleanup();
}

async function relay() {
  const result = await runApp({
    members: [
      scriptedMember({ id: 'lead', name: '主持人', plan: { summary: '先建立再交接', assignments: [{ agent: 'A2', task: '建立規格' }, { agent: 'A3', task: '接續實作' }] } }),
      scriptedMember({ id: 'first', name: '第一棒', canEdit: true, writes: { 'spec.txt': 'ready\n' }, report: '規格已完成,請依 spec.txt 實作' }),
      scriptedMember({ id: 'second', name: '第二棒', canEdit: true, writes: { 'result.json': '{"ready":true}\n' }, report: '實作完成' }),
    ],
    settings: { leadAgentId: 'lead', workStyle: 'general' },
    scenario: async () => {
      const g: any = globalThis;
      await g.ready();
      const mode = g.$('#mode') as HTMLSelectElement;
      g.check(Array.from(mode.options).some((option) => option.value === 'relay'), '模式選單提供接力');
      g.check(Array.from(mode.options).some((option) => option.value === 'divide' && /平行/.test(option.text)), '平行分工與接力分開標示');
      mode.value = 'relay';
      g.$('#input').value = '依序完成規格與實作';
      g.$('#send-btn').click();
      await g.waitFor(async () => (await g.snapshot()).messages.some((message: any) => message.tag === 'task-summary'), 30000, '接力結果卡');
      await g.waitIdle();
      const messages = (await g.snapshot()).messages;
      const steps = messages.filter((message: any) => message.kind === 'agent' && message.phase?.code === 'execute');
      g.check(steps.map((message: any) => message.agentId).join(',') === 'first,second', '接力依分工順序執行');
      g.check(steps[0].phase.round === 1 && steps[1].phase.round === 2, '每一棒保留自己的步驟編號');
      g.check(!!document.querySelector('#timeline .task-summary'), '接力結束顯示結果卡');
      g.check(g.hiddenLeaks().length === 0, '接力畫面沒有隱藏元素佔位');
      for (const animation of document.getAnimations()) {
        if (animation.effect?.getTiming().iterations !== Infinity) animation.finish();
      }
      const timeline = g.$('#timeline');
      const card = document.querySelector('#timeline .task-summary')!;
      timeline.scrollTop += card.getBoundingClientRect().top - timeline.getBoundingClientRect().top - 80;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await g.shot('03-relay');
      const api = (window as any).api;
      const original = api.jobs.current();
      g.$('#job-new').click();
      await g.waitFor(() => api.jobs.current() !== original, 5000, '建立同目錄的新任務');
      await g.send('@主持人 another task', 'discuss');
      g.$(`#job-list [data-job-id="${original}"] .job-open`).click();
      await g.waitFor(() => api.jobs.current() === original && !!document.querySelector('#timeline .task-summary'), 5000, '回到有快照的任務');
      await g.send('@主持人 follow up', 'discuss');
      g.check((await api.revertTask()).reason === 'stale', '舊任務續作不會讓過期快照重新取得還原權限');
      return { ok: true };
    },
  });
  if (result.read('spec.txt') !== 'ready\n' || result.read('result.json') !== '{"ready":true}\n') {
    result.ok = false;
    result.error = 'Relay output files did not match the expected contents';
  }
  report('接力工作', result);
  if (!result.ok) process.exitCode = 1;
  result.cleanup();
}

main().then(relay).catch((error) => { console.error(error); process.exitCode = 1; });
