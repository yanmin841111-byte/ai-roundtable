'use strict';

// 情境:側欄的「陣容」。存下目前的成員組合、改動後標出「已修改」、一鍵換回來、刪除。中英文各跑一次。

import { runApp, report } from '../app';
import { scriptedMember } from '../fixtures';

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

async function main() {
  const zh = await once('zh-Hant');
  const en = await once('en');
  if (!zh.ok || !en.ok) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
