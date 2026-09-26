'use strict';

// 情境:沒安裝的內建 CLI 可以從設定頁與成員設定直接安裝。
// 只看安裝計畫與介面,不按「開始安裝」:實際執行由 test/cli-install.test.ts 以本機行程驗證。

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { report, runApp } from '../app';
import { scriptedMember } from '../fixtures';

async function scenario(locale: 'zh-Hant' | 'en') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-install-home-'));
  const result = await runApp({
    members: [scriptedMember({ id: 's1', name: 'Member' }), { id: 'c1', name: 'Claude', cli: 'claude' }],
    settings: { uiLocale: locale },
    // 暫存 HOME 讓 ~/.local/bin 裡的 Claude Code 在隔離環境裡找不到,也不讀使用者的登入 shell
    env: { HOME: home, SHELL: '/usr/bin/false', PATH: '/usr/bin:/bin' },
    constants: { locale },
    timeoutMs: 2 * 60 * 1000,
    scenario: async (options) => {
      const harness: any = globalThis;
      await harness.ready();
      const capture = async (name: string) => {
        for (const animation of document.getAnimations()) {
          if (animation.effect?.getComputedTiming().iterations !== Infinity) animation.finish();
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        await harness.shot(`${name}-${options.locale}`);
      };
      const plan = await (window as any).api.cliInstall.plan('claude');
      harness.check(plan && plan.cliId === 'claude', 'Main process returns an install plan');
      harness.check(await (window as any).api.cliInstall.plan('rm -rf /') === null, 'Unknown CLI ids have no plan');

      harness.$('#settings-btn').click();
      harness.$('.settings-tab[data-tab="clis"]').click();
      const row = await harness.waitFor(() => Array.from(document.querySelectorAll('#ext-list .ext-item'))
        .find((item) => /Claude Code/.test(item.textContent || '') && item.querySelector('[data-env-install]')), 25000, 'Missing Claude Code offers install');
      harness.check(!row.querySelector('[data-env-url]'), 'Install replaces the documentation button as the next step');
      await capture('settings-install');
      (row.querySelector('[data-env-install]') as HTMLButtonElement).click();
      const modal = harness.$('#install-modal') as HTMLElement;
      await harness.waitFor(() => !modal.classList.contains('hidden'), 5000, 'Install dialog opened');
      harness.check(harness.text('#install-title').includes('Claude Code'), 'Dialog names the CLI');
      harness.check(harness.text('#install-system').includes('macOS') || harness.text('#install-system').includes(plan.platform), 'Dialog shows the detected system');
      harness.check(harness.$('#install-steps [data-step="install"]').classList.contains('current'), 'Install is the current step');
      if (plan.methods.length) {
        harness.check(harness.text('#install-command-text') === plan.methods[0].command, 'Recommended command comes from the main-process plan');
        harness.check(!harness.$('#install-start').hidden, 'Install requires an explicit start');
        if (plan.methods.length > 1) {
          const second = document.querySelectorAll<HTMLInputElement>('#install-methods input')[1];
          second.click();
          harness.check(harness.text('#install-command-text') === plan.methods[1].command, 'Choosing another method updates the command');
          document.querySelectorAll<HTMLInputElement>('#install-methods input')[0].click();
        }
      } else {
        harness.check(harness.$('#install-start').hidden && !harness.$('#install-status').hidden, 'Without a method the dialog explains the manual path');
      }
      const card = modal.querySelector('.modal-card') as HTMLElement;
      const bounds = card.getBoundingClientRect();
      harness.check(bounds.left >= 0 && bounds.right <= window.innerWidth && bounds.bottom <= window.innerHeight, 'Install dialog fits the window');
      harness.check(card.scrollWidth <= card.clientWidth, 'Install dialog has no horizontal overflow');
      await capture('install-dialog');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      harness.check(modal.classList.contains('hidden'), 'Esc closes the dialog when nothing is running');
      harness.$('#settings-close').click();

      (document.querySelector('[data-agent-id="c1"]') as HTMLElement).click();
      const status = await harness.waitFor(() => {
        const box = harness.$('#f-cli-status') as HTMLElement;
        return box && !box.hidden && box.querySelector('[data-env-install]') ? box : null;
      }, 10000, 'Member settings offer install');
      (status.querySelector('[data-env-install]') as HTMLButtonElement).click();
      await harness.waitFor(() => !modal.classList.contains('hidden'), 5000, 'Install opens above member settings');
      const stacked = Array.from(document.querySelectorAll('.modal:not(.hidden)'));
      harness.check(stacked[stacked.length - 1] === modal, 'Install dialog is the top window');
      harness.$('#install-done').click();
      harness.$('#modal-close').click();
      window.resizeTo(940, 700);
      await harness.waitFor(() => window.innerWidth <= 940, 5000, 'Compact window');
      await capture('workspace-compact');
      harness.check(harness.hiddenLeaks().length === 0, 'Hidden controls occupy no space');
      return { methods: plan.methods.map((method: any) => method.tool) };
    },
  });
  const ok = report(`CLI install (${locale})`, result);
  result.cleanup();
  fs.rmSync(home, { recursive: true, force: true });
  assert.ok(ok, result.error);
}

async function main() {
  await scenario('zh-Hant');
  await scenario('en');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
