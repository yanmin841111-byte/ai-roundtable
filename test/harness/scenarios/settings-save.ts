'use strict';

// 情境:設定存不進去的時候,介面說的是實話。
//
// 這個情境存在的理由:config:save 以前是送出去就不管了,寫入失敗(磁碟滿了、檔案沒有權限、
// 設定目錄被同步軟體鎖住)照樣閃一個「✓ 已儲存」。使用者相信自己存好了,下次開 app 才發現
// 設定回到舊的——而且不會有任何線索說剛才那一下沒成功。這種「介面騙人」比功能壞掉更難查。
// 單元測試看不到:這是 renderer 的承諾處理,只有真的按下去才會發生。

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { runApp, report } from '../app';
import { scriptedMember } from '../fixtures';

// 對照組:一樣的操作,設定檔可以寫。沒有這一半,上面那些檢查只要介面永遠說失敗就全過了。
async function writable() {
  const r = await runApp({
    members: [scriptedMember({ id: 's1', name: '成員一' }), scriptedMember({ id: 's2', name: '成員二' })],
    timeoutMs: 2 * 60 * 1000,
    scenario: async () => {
      const g: any = globalThis;
      await g.ready();
      g.$('#settings-btn').click();
      await g.waitFor(() => !g.$('#settings').classList.contains('hidden'), 5000, '設定打開');
      const rounds = g.$('#max-rounds') as HTMLInputElement;
      rounds.value = '2';
      rounds.dispatchEvent(new Event('change'));
      const discussion = g.$('#discussion-mode') as HTMLSelectElement;
      discussion.value = 'independent-first';
      discussion.dispatchEvent(new Event('change'));
      const allowGit = g.$('#allow-git') as HTMLInputElement;
      g.check(!allowGit.checked, 'git 提交預設關閉');
      allowGit.checked = true;
      allowGit.dispatchEvent(new Event('change'));
      const hint = await g.waitFor(() => {
        const el = g.$('#settings-saved') as HTMLElement;
        return el && !el.hidden ? el : null;
      }, 8000, '改完設定之後有回應');
      g.check(/已儲存/.test(hint.textContent || ''), `存得進去就說已儲存(顯示:${hint.textContent})`);
      g.check(!hint.classList.contains('failed'), '成功時不帶失敗樣式');
      await g.shot('discussion-mode');
      g.$('#settings-close').click();
      const messages = await g.send('Discuss the task independently first.', 'discuss');
      const discussionTurns = messages.filter((message: any) => message.kind === 'agent' && message.phase?.code === 'discuss');
      g.check(discussionTurns.length === 4, '首輪即使全員同意也必須進入第二輪互評');
      g.check(discussionTurns.every((message: any) => message.phase.maxRounds === 2), '兩輪設定帶到真實討論流程');
      return { text: hint.textContent };
    },
  });
  const ok = report('設定存得進去時說已儲存', r);
  const saved = JSON.parse(fs.readFileSync(path.join(r.userData, 'config.json'), 'utf8'));
  const written = saved.settings.maxRounds === 2 && saved.settings.discussionMode === 'independent-first' && saved.settings.allowGitCommit === true;
  console.log(written ? '  ok - 設定檔確實被寫進去了' : '  失敗:說存好了,檔案卻沒有改');
  r.cleanup();
  assert.ok(ok && written, r.error || '對照組失敗');
}

async function copilotMember(locale: 'zh-Hant' | 'en') {
  const result = await runApp({
    members: [scriptedMember({ id: 's1', name: 'Member' })],
    settings: { uiLocale: locale },
    constants: { locale },
    timeoutMs: 2 * 60 * 1000,
    scenario: async (options) => {
      const harness: any = globalThis;
      await harness.ready();
      harness.$('#add-agent').click();
      await harness.waitFor(() => !harness.$('#modal').classList.contains('hidden'), 10000, 'member editor opened');
      const cli = harness.$('#f-cli') as HTMLSelectElement;
      const option = cli.querySelector('option[value="copilot"]');
      harness.check(option?.textContent === 'GitHub Copilot CLI', 'Copilot is available in the member CLI menu');
      cli.value = 'copilot';
      cli.dispatchEvent(new Event('change'));
      const model = harness.$('#f-model-select') as HTMLSelectElement;
      const effort = harness.$('#f-effort') as HTMLSelectElement;
      const canEdit = harness.$('#f-canEdit') as HTMLInputElement;
      harness.check(model.value === 'auto', 'Copilot defaults to Auto');
      harness.check(!/cache|快取/.test(harness.text('#f-model-desc')), 'Static Auto does not claim a missing model cache');
      harness.check(effort.disabled, 'Auto leaves reasoning effort to the CLI');
      harness.check(!canEdit.disabled, 'Copilot supports editing permission controls');
      harness.$('#f-name').value = 'Copilot';
      harness.check(model.options.length > 4, `Copilot lists the CLI models (${model.options.length} options)`);
      harness.check(Array.from(model.options).some((item: any) => item.value === 'gpt-5-mini' && /低成本|low cost/.test(item.textContent || '')), 'Low-cost Copilot models are labeled');
      model.value = '__custom__';
      model.dispatchEvent(new Event('change'));
      harness.$('#f-model').value = 'custom-model-x';
      harness.$('#f-model').dispatchEvent(new Event('input'));
      harness.check(!effort.disabled, 'Manual models offer reasoning effort');
      effort.value = 'high';
      canEdit.checked = false;
      harness.$('#modal-save').click();
      const saved = await harness.waitFor(async () => {
        const config = await (window as any).api.getConfig();
        return config.agents.find((member: any) => member.cli === 'copilot');
      }, 10000, 'Copilot member saved');
      harness.check(saved.model === 'custom-model-x' && saved.effort === 'high' && !saved.canEdit, 'Model, effort and read-only permission survive IPC save');
      harness.$(`[data-agent-id="${saved.id}"]`).click();
      await harness.waitFor(() => !harness.$('#modal').classList.contains('hidden'), 10000, 'saved member reopened');
      harness.check(cli.value === 'copilot' && model.value === '__custom__', 'Reopened editor retains Copilot and the manual model');
      harness.check(harness.$('#f-model').value === saved.model && effort.value === 'high' && !canEdit.checked, 'Reopened editor retains all Copilot settings');
      harness.check(harness.hiddenLeaks().length === 0, 'Hidden fields do not occupy space');
      for (const animation of document.getAnimations()) {
        if (animation.effect?.getComputedTiming().iterations !== Infinity) animation.finish();
      }
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await harness.shot(`copilot-${options.locale}`);
      return { id: saved.id };
    },
  });
  const ok = report(`Copilot member settings (${locale})`, result);
  const saved = JSON.parse(fs.readFileSync(path.join(result.userData, 'config.json'), 'utf8'));
  const member = saved.agents.find((entry: any) => entry.cli === 'copilot');
  result.cleanup();
  assert.ok(ok, result.error);
  assert.ok(member);
  assert.equal(member.model, 'custom-model-x');
  assert.equal(member.effort, 'high');
  assert.equal(member.canEdit, false);
}

async function connections(locale: 'zh-Hant' | 'en') {
  const result = await runApp({
    members: [scriptedMember({ id: 's1', name: 'Member' })],
    settings: { uiLocale: locale },
    env: { DEEPSEEK_API_KEY: '' },
    constants: { locale },
    timeoutMs: 2 * 60 * 1000,
    scenario: async (options) => {
      const harness: any = globalThis;
      await harness.ready();
      const capture = async (name: string) => {
        for (const animation of document.getAnimations()) {
          if (animation.effect?.getComputedTiming().iterations !== Infinity) animation.finish();
        }
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        await harness.shot(`${name}-${options.locale}`);
      };
      const tools = harness.$('#task-tools') as HTMLElement;
      harness.check(!tools.matches(':popover-open'), 'Secondary tools start closed');
      harness.$('#tools-btn').click();
      await harness.waitFor(() => tools.matches(':popover-open'), 3000, 'Tools open');
      harness.check(tools.contains(harness.$('#terminal-btn')) && tools.contains(harness.$('#export-btn')), 'Terminal and export remain available');
      const bounds = tools.getBoundingClientRect();
      harness.check(bounds.left >= 0 && bounds.right <= window.innerWidth && bounds.top >= 0, 'Tools menu stays inside the window');
      await capture('workspace-tools');
      tools.hidePopover();
      harness.check(harness.$('#composer').contains(harness.$('#stop-btn')), 'Stop is next to task input');
      const style = harness.$('#work-style') as HTMLSelectElement;
      style.value = 'general';
      style.dispatchEvent(new Event('change', { bubbles: true }));
      await harness.waitFor(async () => (await (window as any).api.getConfig()).settings.workStyle === 'general', 5000, 'General task mode saved');

      harness.$('#settings-btn').click();
      harness.$('.settings-tab[data-tab="clis"]').click();
      harness.$('#ext-add').click();
      harness.check(!harness.$('.ext-template-advanced').open, 'Custom connections are collapsed by default');
      harness.check(!!harness.$('#ext-picker-local'), 'Local AI has a direct detection entry');
      await capture('ai-picker');
      harness.$('[data-template="deepseek-api.json"]').click();
      await harness.waitFor(() => !harness.$('#ext-editor').classList.contains('hidden'), 15000, 'API editor opened');
      harness.check(/DeepSeek/.test(harness.text('#ext-editor-title')), 'Editor title is the service name');
      harness.check(!harness.$('#ext-connection-fields').open && !harness.$('#ext-extra-fields').open && !harness.$('#ext-file-settings').open, 'Existing connection defaults and technical settings start collapsed');
      harness.check(harness.$('#ext-cli-fields').hidden && harness.$('#ext-cli-options').hidden, 'API does not show CLI fields');
      harness.check(harness.$('#ext-type').closest('#ext-extra-fields'), 'Protocol selection stays in advanced settings');
      harness.check(harness.$('#ext-get-key').dataset.url === 'https://platform.deepseek.com/api_keys', 'Known provider has an official key-management entry');
      await capture('api-connection');
      const key = harness.$('#ext-api-key') as HTMLInputElement;
      key.value = 'dummy-ui-only';
      harness.$('#ext-key-reveal').click();
      harness.check(key.type === 'text' && harness.$('#ext-key-reveal').getAttribute('aria-pressed') === 'true', 'Reveal key updates accessible state');
      harness.$('#ext-key-reveal').click();
      harness.check(key.type === 'password', 'Key can be hidden again');
      key.value = '';
      const specNow = () => JSON.parse(harness.$('#ext-content').value);
      const models = JSON.stringify(specNow().models);
      harness.$('#ext-label').value = 'Research AI';
      harness.$('#ext-label').dispatchEvent(new Event('input', { bubbles: true }));
      harness.$('#ext-save').click();
      await harness.waitFor(() => !harness.$('#ext-ok').hidden, 15000, 'API settings saved');
      const file = harness.$('#ext-file').value;
      const read = await (window as any).api.ext.read(file);
      const saved = JSON.parse(typeof read === 'string' ? read : read.content);
      harness.check(saved.label === 'Research AI' && JSON.stringify(saved.models) === models, 'Saving basic settings preserves detailed model metadata');
      harness.$('#ext-cancel').click();
      harness.$('#ext-add').click();
      harness.$('.ext-template-advanced').open = true;
      harness.$('[data-template="blank-cli.json"]').click();
      await harness.waitFor(() => !harness.$('#ext-editor').classList.contains('hidden'), 15000, 'Custom CLI editor opened');
      harness.check(harness.$('#ext-api-fields').hidden && !harness.$('#ext-cli-fields').hidden, 'CLI shows only its connection fields');
      const originalArgs = JSON.stringify(specNow().args);
      harness.$('#ext-extra-fields').open = true;
      harness.check(harness.$('#ext-simple-args').hidden && !harness.$('#ext-structured-args').hidden, 'Structured arguments have a configured status instead of an empty disabled field');
      harness.$('#ext-edit-args').click();
      harness.check(!harness.$('#ext-advanced').hidden && JSON.stringify(specNow().args) === originalArgs, 'Edit arguments opens JSON without losing conditions');
      harness.$('#ext-tab-basic').click();
      harness.$('#ext-label').value = 'Custom helper';
      harness.$('#ext-label').dispatchEvent(new Event('input', { bubbles: true }));
      harness.$('#ext-save').click();
      await harness.waitFor(() => !harness.$('#ext-ok').hidden, 15000, 'CLI settings saved');
      harness.check(JSON.stringify(specNow().args) === originalArgs, 'Basic CLI edits preserve conditional argument groups');
      harness.$('#ext-extra-fields').open = false;
      window.resizeTo(940, 720);
      await harness.waitFor(() => window.innerWidth <= 940, 5000, 'Compact window');
      const modal = harness.$('#ext-editor .modal-card') as HTMLElement;
      const modalBounds = modal.getBoundingClientRect();
      harness.check(modalBounds.left >= 0 && modalBounds.right <= window.innerWidth && modalBounds.bottom <= window.innerHeight, 'Editor and action buttons fit the compact window');
      harness.check(modal.scrollWidth <= modal.clientWidth, 'Editor has no horizontal overflow');
      await capture('custom-connection-compact');
      harness.$('#ext-cancel').click();
      harness.$('#settings-close').click();
      const composer = harness.$('.composer-bar') as HTMLElement;
      harness.check(composer.scrollWidth <= composer.clientWidth, 'General task controls fit the compact workspace');
      await capture('workspace-compact');
      harness.check(harness.hiddenLeaks().length === 0, 'Hidden controls occupy no space');
      return { file, models };
    },
  });
  const ok = report(`Connection workflow (${locale})`, result);
  assert.ok(ok, result.error);
  const saved = JSON.parse(fs.readFileSync(path.join(result.userData, 'adapters', result.value.file), 'utf8'));
  assert.equal(saved.label, 'Research AI');
  assert.equal(JSON.stringify(saved.models), result.value.models);
  const cli = JSON.parse(fs.readFileSync(path.join(result.userData, 'adapters', 'blank-cli.json'), 'utf8'));
  assert.equal(cli.label, 'Custom helper');
  assert.equal(cli.args[1].if, 'canEdit');
  result.cleanup();
}

async function layout(locale: 'zh-Hant' | 'en') {
  const result = await runApp({
    members: [scriptedMember({ id: 's1', name: 'Member' })],
    settings: { uiLocale: locale, workDir: '' },
    constants: { locale },
    timeoutMs: 2 * 60 * 1000,
    scenario: async (options) => {
      const harness: any = globalThis;
      await harness.ready();
      const chip = harness.$('#workdir-chip') as HTMLButtonElement;
      harness.check(chip.classList.contains('empty') && chip.querySelector('.chip-icon')?.getAttribute('data-icon') === 'folderPlus' && chip.offsetWidth > 100, `Missing working folder is a full folder-plus button (${chip.offsetWidth}px)`);
      harness.check(chip.title.length > 20 && !/\{dir\}/.test(chip.title), `Missing folder explains the next step (${chip.title})`);
      harness.$('#topbar').classList.add('compact');
      harness.check(chip.offsetWidth === 30 && chip.offsetHeight === 30, `Compact toolbar keeps a square folder button (${chip.offsetWidth}x${chip.offsetHeight})`);
      harness.$('#topbar').classList.remove('compact');
      const drag = async (handle: HTMLElement, dx: number, dy: number) => {
        const box = handle.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        const pointer = (type: string, px: number, py: number) => handle.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, button: 0, buttons: 1, clientX: px, clientY: py }));
        pointer('pointerdown', x, y);
        pointer('pointermove', x + dx, y + dy);
        pointer('pointerup', x + dx, y + dy);
        await harness.w(150);
      };
      const sidebar = harness.$('#sidebar') as HTMLElement;
      const input = harness.$('#input') as HTMLTextAreaElement;
      const sidebarBefore = sidebar.offsetWidth;
      const inputBefore = input.offsetHeight;
      await drag(harness.$('#sidebar-resize'), 80, 0);
      harness.check(sidebar.offsetWidth === sidebarBefore + 80, `Sidebar follows the drag (${sidebarBefore} -> ${sidebar.offsetWidth})`);
      await drag(harness.$('#composer-resize'), 0, -70);
      harness.check(input.offsetHeight === inputBefore + 70, `Input area grows upward (${inputBefore} -> ${input.offsetHeight})`);
      await harness.waitFor(async () => {
        const saved = (await (window as any).api.getConfig()).settings;
        return saved.sidebarWidth === sidebar.offsetWidth && saved.composerHeight === input.offsetHeight;
      }, 5000, 'Layout sizes saved');
      await drag(harness.$('#sidebar-resize'), 2000, 0);
      const timeline = harness.$('#timeline') as HTMLElement;
      harness.check(sidebar.offsetWidth <= 420 && timeline.offsetWidth >= 520, `Sidebar keeps room for the timeline (${sidebar.offsetWidth}/${timeline.offsetWidth})`);
      await drag(harness.$('#composer-resize'), 0, -2000);
      harness.check(input.offsetHeight <= Math.round(window.innerHeight * 0.45), 'Input area cannot cover the conversation');
      const composerHandle = harness.$('#composer-resize') as HTMLElement;
      const before = input.offsetHeight;
      composerHandle.focus();
      composerHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      harness.check(input.offsetHeight === before - 24 && composerHandle.getAttribute('aria-valuenow') === String(input.offsetHeight), 'Keyboard resizing updates the separator value');
      harness.$('#sidebar-resize').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      composerHandle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      harness.check(sidebar.offsetWidth === sidebarBefore && input.offsetHeight === inputBefore, 'Double-click restores default sizes');
      await harness.waitFor(async () => {
        const saved = (await (window as any).api.getConfig()).settings;
        return !('sidebarWidth' in saved) && !('composerHeight' in saved);
      }, 5000, 'Reset removes saved sizes');
      await drag(harness.$('#sidebar-resize'), 36, 0);
      await drag(composerHandle, 0, -40);
      for (const animation of document.getAnimations()) {
        if (animation.effect?.getComputedTiming().iterations !== Infinity) animation.finish();
      }
      await harness.shot(`layout-${options.locale}`);
      harness.check(harness.hiddenLeaks().length === 0, 'Resize handles leave no hidden-space leaks');
      return { sidebar: sidebar.offsetWidth, input: input.offsetHeight };
    },
  });
  const ok = report(`Resizable layout (${locale})`, result);
  const saved = JSON.parse(fs.readFileSync(path.join(result.userData, 'config.json'), 'utf8')).settings;
  result.cleanup();
  assert.ok(ok, result.error);
  assert.equal(saved.sidebarWidth, result.value.sidebar);
  assert.equal(saved.composerHeight, result.value.input);
}

async function main() {
  await layout('zh-Hant');
  await layout('en');
  await connections('zh-Hant');
  await connections('en');
  if (process.argv.includes('--connections-only')) return;
  await copilotMember('zh-Hant');
  await copilotMember('en');
  // root 對唯讀檔照樣寫得進去,這個情境就測不到東西了——照實說跳過,不要假裝通過
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.log('(以 root 執行,唯讀檔擋不住寫入,跳過這個情境)');
    return;
  }
  await writable();
  const r = await runApp({
    members: [scriptedMember({ id: 's1', name: '成員一' })],
    // 啟動之後才鎖不行:app 開起來要先讀得到設定。唯讀檔可以讀、不能寫,正好。
    beforeLaunch: ({ userData }) => fs.chmodSync(path.join(userData, 'config.json'), 0o444),
    timeoutMs: 2 * 60 * 1000,
    scenario: async () => {
      const g: any = globalThis;
      await g.ready();
      g.$('#settings-btn').click();
      await g.waitFor(() => !g.$('#settings').classList.contains('hidden'), 5000, '設定打開');

      // 改一個設定:設定頁是改完就存(change 事件),寫入一定會失敗
      const rounds = g.$('#max-rounds') as HTMLInputElement;
      rounds.value = '2';
      rounds.dispatchEvent(new Event('change'));

      const hint = await g.waitFor(() => {
        const el = g.$('#settings-saved') as HTMLElement;
        return el && !el.hidden ? el : null;
      }, 8000, '改完設定之後有回應');
      const text = hint.textContent || '';
      g.check(!/已儲存|Saved/.test(text), `存不進去時不能說「已儲存」(顯示:${text})`);
      g.check(/沒有存到/.test(text), `要照實說沒有存到(顯示:${text})`);
      g.check(hint.classList.contains('failed'), '失敗的樣式跟成功的不一樣');
      await g.shot('01-save-failed');

      // 而且要說得出原因,不是只有一句「失敗」
      g.check(/EACCES|permission|denied|唯讀|read-only/i.test(text), `訊息帶著原因(顯示:${text})`);
      return { text };
    },
  });

  const ok = report('設定存不進去時照實說', r);
  // 從 app 外面獨立確認:檔案真的沒有被改動過
  const saved = JSON.parse(fs.readFileSync(path.join(r.userData, 'config.json'), 'utf8'));
  const untouched = saved.settings.maxRounds === 1;
  console.log(untouched ? '  ok - 設定檔確實沒有被寫入' : '  失敗:設定檔居然被改了');
  r.cleanup();
  assert.ok(ok && untouched, r.error || '情境失敗');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
