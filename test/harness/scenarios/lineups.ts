'use strict';

// 情境:側欄的「陣容」。存下目前的成員組合、改動後標出「已修改」、一鍵換回來、刪除。中英文各跑一次。

import { runApp, report } from '../app';
import { scriptedMember } from '../fixtures';
import fs from 'fs';
import path from 'path';

async function once(locale: 'zh-Hant' | 'en') {
  const zh = locale === 'zh-Hant';
  const r = await runApp({
    members: [
      scriptedMember({ id: 'a', name: 'Alice', canEdit: true }),
      scriptedMember({ id: 'b', name: 'Bob', canEdit: true }),
      scriptedMember({ id: 'c', name: 'Carol', canEdit: true }),
    ],
    settings: { leadAgentId: 'a', uiLocale: locale, language: zh ? '繁體中文' : 'English' },
    constants: { zh },
    timeoutMs: 2 * 60 * 1000,
    scenario: async (H: any) => {
      const g: any = globalThis;
      await g.ready();
      window.confirm = () => true; // 刪除陣容會先問一聲
      const btn = () => document.querySelector('#lineup-btn') as HTMLButtonElement;
      const menu = () => document.querySelector('#lineup-menu') as HTMLElement;
      const note = () => document.querySelector('#lineup-note') as HTMLElement;
      const enabled = async () => (await (window as any).api.getConfig()).agents.filter((a: any) => a.enabled !== false).map((a: any) => a.name).join(',');
      const openMenu = async () => { if (menu().hidden) btn().click(); await g.w(150); };
      const saveAs = async (name: string) => {
        await openMenu();
        (Array.from(menu().querySelectorAll('.lineup-action')).pop() as HTMLButtonElement).click();
        await g.w(100);
        const input = menu().querySelector('#lineup-name') as HTMLInputElement;
        input.value = name;
        input.dispatchEvent(new Event('input'));
        (menu().querySelector('.lineup-form') as HTMLFormElement).requestSubmit();
        await g.w(300);
      };
      const item = (name: string) => Array.from(menu().querySelectorAll('.lineup-row')).find((r) => (r.querySelector('.lineup-main b') as HTMLElement).textContent === name) as HTMLElement;
      const editMember = async (id: string, change: () => void) => {
        (document.querySelector(`#agent-list .agent-card[data-agent-id="${id}"]`) as HTMLElement).click();
        await g.w(400);
        change();
        (document.querySelector('#modal-save') as HTMLButtonElement).click();
        await g.w(400);
      };

      const bobPersona = (await (window as any).api.getConfig()).agents.find((a: any) => a.id === 'b').persona;
      g.check(btn().textContent === (H.zh ? '陣容' : 'Lineups'), `一開始沒有陣容(${btn().textContent})`);
      await openMenu();
      g.check(!!menu().querySelector('.lineup-empty'), '選單說明還沒有陣容、怎麼存');
      await g.shot(`empty-${H.zh ? 'zh' : 'en'}`);

      // 1. 三位都上場,存成「全員」
      await saveAs(H.zh ? '全員' : 'Everyone');
      g.check(btn().textContent === (H.zh ? '陣容:全員' : 'Lineup: Everyone'), `按鈕顯示目前的陣容(${btn().textContent})`);
      g.check(!note().hidden && /全員|Everyone/.test(note().textContent || ''), `側欄說明剛存了陣容(${note().textContent})`);

      // 2. 停用 Carol、改 Bob 的角色:陣容變成「已修改」
      await editMember('c', () => { (document.querySelector('#f-enabled') as HTMLInputElement).checked = false; });
      await editMember('b', () => { (document.querySelector('#f-persona') as HTMLTextAreaElement).value = H.zh ? '專門挑錯的審查者' : 'A strict reviewer'; });
      g.check(/已修改|modified/.test(btn().textContent || ''), `改過之後標出已修改(${btn().textContent})`);
      await openMenu();
      g.check(!!item(H.zh ? '全員' : 'Everyone').querySelector('.lineup-modified'), '選單裡目前的陣容標著已修改');
      g.check(Array.from(menu().querySelectorAll('.lineup-action')).some((b) => /更新「全員」|Update “Everyone”/.test(b.textContent || '')), '提供「用目前的設定更新」');

      // 3. 把現在這組存成「雙人組」
      await saveAs(H.zh ? '雙人組' : 'Pair');
      g.check(btn().textContent === (H.zh ? '陣容:雙人組' : 'Lineup: Pair'), `存完換成新陣容(${btn().textContent})`);

      // 4. 換回「全員」:Carol 回來,Bob 的角色換回存的時候那樣
      await openMenu();
      await g.shot(`menu-${H.zh ? 'zh' : 'en'}`);
      (item(H.zh ? '全員' : 'Everyone').querySelector('.lineup-item') as HTMLButtonElement).click();
      await g.w(400);
      const cfg = await (window as any).api.getConfig();
      g.check((await enabled()) === 'Alice,Bob,Carol', `換回全員:三位都上場(${await enabled()})`);
      g.check(cfg.agents.find((a: any) => a.id === 'b').persona === bobPersona, `Bob 的角色換回存的時候那樣(${cfg.agents.find((a: any) => a.id === 'b').persona})`);
      g.check(!(document.querySelector('#agent-list .agent-card[data-agent-id="c"]') as HTMLElement).classList.contains('disabled'), '側欄的 Carol 不再是停用');
      g.check(btn().textContent === (H.zh ? '陣容:全員' : 'Lineup: Everyone'), `沒有已修改(${btn().textContent})`);

      // 5. 換成「雙人組」:Carol 停用,Bob 是審查者
      await openMenu();
      (item(H.zh ? '雙人組' : 'Pair').querySelector('.lineup-item') as HTMLButtonElement).click();
      await g.w(400);
      const pair = await (window as any).api.getConfig();
      g.check((await enabled()) === 'Alice,Bob', `換成雙人組(${await enabled()})`);
      g.check(/挑錯|strict/.test(pair.agents.find((a: any) => a.id === 'b').persona), 'Bob 換上雙人組裡的角色');
      await g.shot(`applied-${H.zh ? 'zh' : 'en'}`);

      // 6. 刪掉「全員」
      await openMenu();
      (item(H.zh ? '全員' : 'Everyone').querySelector('.lineup-delete') as HTMLButtonElement).click();
      await g.w(300);
      const left = (await (window as any).api.getConfig()).lineups.map((l: any) => l.name).join(',');
      g.check(left === (H.zh ? '雙人組' : 'Pair'), `刪除後只剩雙人組(${left})`);
      g.check((await enabled()) === 'Alice,Bob', '刪除陣容不影響成員');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await g.w(100);
      g.check(menu().hidden, 'Esc 關掉選單');

      const leaks = g.hiddenLeaks();
      g.check(leaks.length === 0, `沒有帶 hidden 卻仍佔版面的元素(${leaks.join(', ') || '無'})`);
      return {};
    },
  });
  report(`陣容 · ${locale}`, r);
  r.cleanup();
  return r;
}

async function quickTeam(locale: 'zh-Hant' | 'en', condition: 'ready' | 'members' | 'writer' | 'folder' | 'save-failed') {
  const result = await runApp({
    members: [
      scriptedMember({ id: 'a', name: 'Alice', canEdit: false }),
      scriptedMember({ id: 'b', name: 'Bob', canEdit: condition !== 'writer' }),
      { ...scriptedMember({ id: 'c', name: 'Carol', canEdit: false }), ...(condition === 'members' ? { cli: 'unregistered-fixture' } : {}) },
    ],
    settings: { leadAgentId: 'a', uiLocale: locale, maxRounds: 1, sidebarWidth: 220, ...(condition === 'folder' ? { workDir: '' } : {}) },
    beforeLaunch: condition === 'save-failed' ? ({ userData }) => fs.chmodSync(path.join(userData, 'config.json'), 0o444) : undefined,
    constants: { locale, condition },
    timeoutMs: 90_000,
    scenario: async (context: any) => {
      const app: any = globalThis;
      await app.ready();
      const original = await app.api.getConfig();
      const menu = () => document.querySelector('#lineup-menu') as HTMLElement;
      const open = (kind: string) => {
        if (menu().hidden) (document.querySelector('#lineup-btn') as HTMLButtonElement).click();
        (menu().querySelector(`[data-preset="${kind}"]`) as HTMLButtonElement).click();
      };
      open('code');
      const warning = () => menu().querySelector('.lineup-preset-warning')?.textContent || '';
      if (['members', 'writer', 'folder'].includes(context.condition)) {
        const expected = context.condition === 'members' ? /2/ : context.condition === 'writer' ? /改檔權限|edit permission/ : /資料夾|working folder/;
        await app.waitFor(() => expected.test(warning()), 15_000, 'specific setup issue displayed');
        app.check((document.querySelector('#lineup-preset-apply') as HTMLButtonElement).disabled, '前置條件不足時不能套用');
        if (context.condition === 'members') app.check(menu().textContent?.includes('Carol'), '指出不可用的成員');
        if (context.condition === 'writer') app.check(!/Three available|需要三位/.test(warning()), '沒有改檔權限不誤報成員不足');
        if (context.condition === 'folder') app.check(Array.from(menu().querySelectorAll('button')).some((button) => /選擇工作資料夾|Choose a working folder/.test(button.textContent || '')), '提供資料夾選擇入口');
        app.check(JSON.stringify(await app.api.getConfig()) === JSON.stringify(original), '被阻擋的組隊不變更設定');
        await app.shot(`quick-${context.condition}-${context.locale}`);
        if (context.condition === 'members') {
          (menu().querySelector('[data-team-action="addMember"]') as HTMLButtonElement).click();
          await app.waitFor(() => !document.querySelector('#modal')!.classList.contains('hidden'), 5000, 'member editor opened');
          app.check(menu().hidden, '新增成員時關閉組隊選單');
          (document.querySelector('#modal-cancel') as HTMLButtonElement | null)?.click();
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
          open('code');
          const trio = menu().querySelector('[data-team-action="copilotTrio"]') as HTMLButtonElement;
          app.check(!!trio, '成員不足時提供 Copilot 三模型建立');
          trio.click();
          await app.waitFor(async () => (await app.api.getConfig()).agents.filter((member: any) => member.cli === 'copilot').length === 3, 5000, 'copilot trio saved');
          const trioConfig = await app.api.getConfig();
          const copilots = trioConfig.agents.filter((member: any) => member.cli === 'copilot');
          app.check(new Set(copilots.map((member: any) => member.model)).size === 3 && copilots.every((member: any) => !member.canEdit), '三個不同模型且預設唯讀');
          app.check((await app.api.snapshot()).messages.length === 0, '建立成員不送出任務');
          await app.shot(`quick-copilot-trio-${context.locale}`);
        }
        if (context.condition === 'writer') {
          (menu().querySelector('.lineup-preset-actions .ghost') as HTMLButtonElement).click();
          open('general');
          app.check(!(document.querySelector('#lineup-preset-apply') as HTMLButtonElement).disabled, '唯讀成員仍可組成文件研究組');
          (document.querySelector('#lineup-preset-apply') as HTMLButtonElement).click();
          await app.waitFor(() => menu().hidden, 5000, 'read-only research team saved');
          const research = await app.api.getConfig();
          app.check(research.settings.workStyle === 'general' && research.agents.every((member: any) => !member.canEdit), '研究組不提升任何改檔權限');
        }
        return { condition: context.condition };
      }
      await app.waitFor(() => !(document.querySelector('#lineup-preset-apply') as HTMLButtonElement).disabled, 15_000, 'available team preview');
      app.check(menu().querySelectorAll('[data-team-role]').length === 3, '預覽列出三個角色');
      app.check(/尚未測試|not tested/.test(menu().textContent || ''), '自訂指令不誤報已驗證');
      app.check((menu().querySelector('[data-team-role="authorId"]') as HTMLSelectElement).value === 'b', '程式開發選用有權限的執行者');
      app.check(JSON.stringify(await app.api.getConfig()) === JSON.stringify(original), '預覽不改設定');
      app.check(menu().scrollWidth <= menu().clientWidth + 1, '組隊預覽沒有水平溢出');
      await app.shot(`quick-preview-${context.locale}-${context.condition}`);
      (menu().querySelector('.lineup-preset-actions .ghost') as HTMLButtonElement).click();
      app.check(JSON.stringify(await app.api.getConfig()) === JSON.stringify(original), '取消保留原設定');
      open('code');
      const lead = menu().querySelector('[data-team-role="leadId"]') as HTMLSelectElement;
      lead.value = 'c';
      lead.dispatchEvent(new Event('change'));
      app.check((menu().querySelector('[data-team-role="reviewerId"]') as HTMLSelectElement).value === 'a', '角色交換仍維持三個不同成員');
      const swapLead = (value: string) => {
        const select = menu().querySelector('[data-team-role="leadId"]') as HTMLSelectElement;
        select.value = value;
        select.dispatchEvent(new Event('change'));
      };
      swapLead('b');
      app.check((document.querySelector('#lineup-preset-apply') as HTMLButtonElement).disabled && /改檔權限|edit permission/.test(warning()), '角色交換不繞過執行者的改檔限制');
      swapLead('c');
      (document.querySelector('#lineup-preset-apply') as HTMLButtonElement).click();
      if (context.condition === 'save-failed') {
        await app.waitFor(() => /未儲存|not saved/.test(document.querySelector('#lineup-note')?.textContent || ''), 5000, 'save failure displayed');
        app.check(JSON.stringify(await app.api.getConfig()) === JSON.stringify(original), '儲存失敗時主程序保留原設定');
        app.check((document.querySelector('#mode') as HTMLSelectElement).value === original.settings.mode, '儲存失敗時介面不假裝套用');
        app.check(!menu().hidden && !(document.querySelector('#lineup-preset-apply') as HTMLButtonElement).disabled, '保留預覽並可重試');
        await app.shot(`quick-save-failed-${context.locale}`);
        return { condition: context.condition };
      }
      await app.waitFor(() => menu().hidden, 5000, 'team saved');
      const saved = await app.api.getConfig();
      app.check(saved.settings.mode === 'guarded' && saved.settings.workStyle === 'code' && saved.settings.discussionMode === 'independent-first' && saved.settings.maxRounds >= 2, '開發組套用多 AI 把關與獨立首輪');
      app.check(saved.settings.leadAgentId === 'c', '保存調整後的主持人');
      app.check(saved.lineups?.length === 1, '建立可再次套用的陣容');
      app.check(saved.agents.every((member: any) => {
        const before = original.agents.find((item: any) => item.id === member.id)!;
        return ['cli', 'model', 'effort', 'canEdit', 'customCommand'].every((key) => member[key] === (before as any)[key]);
      }), '沒有變更模型、指令或改檔權限');
      for (let round = 0; round < 2; round++) {
        open('general');
        (document.querySelector('#lineup-preset-apply') as HTMLButtonElement).click();
        await app.waitFor(() => menu().hidden, 5000, 'research team saved');
      }
      const research = await app.api.getConfig();
      app.check(research.settings.workStyle === 'general' && research.settings.mode === 'guarded', '文件研究組切換到一般任務');
      app.check(research.lineups?.length === 3 && new Set(research.lineups.map((lineup: any) => lineup.name)).size === 3, '同名預設建立新陣容,不覆蓋先前陣容');
      app.check((await app.api.snapshot()).messages.length === 0, '套用陣容不會啟動 AI 任務');
      await app.shot(`quick-applied-${context.locale}`);
      return { condition: context.condition, active: research.settings.activeLineupId };
    },
  });
  report(`快速組隊 ${condition} ${locale}`, result);
  if (result.ok) {
    const disk = JSON.parse(fs.readFileSync(path.join(result.userData, 'config.json'), 'utf8'));
    if (condition === 'ready' && (disk.settings.activeLineupId !== result.value.active || disk.lineups.length !== 3)) throw new Error('Preset teams not saved on disk');
    if (condition === 'save-failed' && disk.settings.mode !== 'divide') throw new Error('Failed save changed disk config');
  }
  result.cleanup();
  return result.ok;
}

async function main() {
  let quickOk = true;
  for (const locale of ['zh-Hant', 'en'] as const) {
    for (const condition of ['ready', 'members', 'writer', 'folder', 'save-failed'] as const) quickOk = await quickTeam(locale, condition) && quickOk;
  }
  if (process.argv.includes('--quick-only')) {
    if (!quickOk) process.exitCode = 1;
    return;
  }
  const zh = await once('zh-Hant');
  const en = await once('en');
  if (!zh.ok || !en.ok || !quickOk) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
