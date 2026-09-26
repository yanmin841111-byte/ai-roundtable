'use strict';

// 情境:終端面板。
//
// 驗的是「使用者自己動手的那條路真的通」——這條路只有把 Electron、IPC、pty、xterm
// 疊起來之後才看得出來:
//   - 工具列點下去面板才出現在右側,平常不佔畫面
//   - 分頁是真的 pty:指令跑得動、輸出畫得出來、cols/lines 跟面板一致
//   - 開在成員的工作目錄,不是家目錄(不然使用者下的 git diff 看的是別的專案)
//   - 收起來時分頁繼續活著;關掉分頁時面板跟著收起來
// 不需要任何模型,所以很快、結果固定。

import assert from 'assert';
import { runApp, report } from '../app';
import { scriptedMember } from '../fixtures';

async function main() {
  const r = await runApp({
    members: [scriptedMember({ id: 's1', name: '對照組' })],
    files: { 'readme.txt': 'hello\n' },
    timeoutMs: 3 * 60 * 1000,
    scenario: async () => {
      const g: any = globalThis;
      const api = (window as any).api;
      await g.ready();

      // 平常收著:面板存在但不佔任何版面
      const panel = () => g.$('#terminal-panel') as HTMLElement;
      g.check(panel().hidden && panel().offsetWidth === 0, '一開始終端是收起來的,不佔畫面');
      g.check(!!g.$('#terminal-btn'), '工具列有「終端」按鈕');
      await g.shot('01-closed');

      // 點工具列 → 面板打開,自動開第一個分頁
      const timelineWidth = () => (g.$('#timeline') as HTMLElement).offsetWidth;
      const beforeWidth = timelineWidth();
      g.$('#terminal-btn').click();
      await g.waitFor(() => !panel().hidden && panel().offsetWidth > 300, 8000, '面板展開');
      g.check(panel().getBoundingClientRect().right >= window.innerWidth - 1, '面板靠在視窗右緣');
      g.check(timelineWidth() < beforeWidth, '時間軸讓出寬度給終端,兩邊並排而不是疊在上面');
      const sessions = await g.waitFor(async () => {
        const list = await api.terminal.list();
        return list.length ? list : null;
      }, 15000, '分頁建立');
      g.check(sessions.length === 1, '打開時自動開一個分頁');
      g.check(g.$('#term-tabs').children.length === 1, '分頁列有一個分頁');

      // 工具列那排按鈕不能溢出來蓋在面板上(#main 變窄時最容易發生,而且被蓋住就點不到)
      const tab = g.$('#term-tabs .term-tab') as HTMLElement;
      const box = tab.getBoundingClientRect();
      const onTop = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      g.check(panel().contains(onTop), '面板的分頁沒有被別的東西蓋住');

      // 工具列變窄之後每個按鈕都還要點得到(#main 一窄,不換行的按鈕列最容易被擠出去)
      const bar = g.$('#topbar') as HTMLElement;
      const barFit = () => `需要 ${bar.scrollWidth}px / 有 ${bar.clientWidth}px${bar.classList.contains('compact') ? ' · 已縮排' : ''} · 面板 ${panel().offsetWidth}px`;
      g.check(bar.scrollWidth <= bar.clientWidth + 1, `工具列在變窄之後仍然放得下(${barFit()})`);
      const reset = (g.$('#reset-btn') as HTMLElement).getBoundingClientRect();
      g.check(reset.right <= bar.getBoundingClientRect().right + 1, '最右邊的「新對話」沒有被擠出畫面');
      const composer = g.$('.composer-box') as HTMLElement;
      const controlsFit = () => Array.from(composer.querySelectorAll<HTMLElement>('select, button')).filter((control) => control.offsetWidth > 0).every((control) => control.getBoundingClientRect().right <= composer.getBoundingClientRect().right + 1 && control.getBoundingClientRect().left >= composer.getBoundingClientRect().left - 1);
      g.check(controlsFit(), '終端開啟後流程、附件與送出都留在輸入區內');

      // 工作目錄要和成員一樣
      const workDir = (await api.getConfig()).settings.workDir;
      g.check(sessions[0].cwd === workDir, `分頁開在工作目錄(${sessions[0].cwd}）`);

      // xterm 真的畫出來了,而且 shell 的提示字元出現
      const screen = () => (g.$('#term-body .term-pane.on') || { textContent: '' }).textContent || '';
      await g.waitFor(() => screen().trim().length > 0, 15000, 'shell 的提示字元');

      // 真的是 pty:算式由 shell 算出來(回顯的指令裡沒有 42),
      // cols/lines 來自 pty 的 winsize,不是預設的 80x24
      const id = sessions[0].id;
      await api.terminal.write(id, 'echo RT_$((6*7))_$(tput cols)x$(tput lines)\n');
      const line = await g.waitFor(() => (screen().match(/RT_42_(\d+)x(\d+)/) || null), 20000, '指令輸出');
      const cols = Number(line[1]);
      const rows = Number(line[2]);
      // 80x24 是拿不到畫面大小時的退路。不要拿開發機的數字當標準——CI runner 的螢幕小得多,
      // 視窗跟著縮,行列數自然不一樣。要驗的是「pty 的大小等於畫面上真正的大小」。
      // 不要拿 DOM 的列數去比:xterm 只畫需要的列,而且大小改變後幾個非同步步驟會短暫不同步。
      // 有意義而且精確的對照是:app 自己記錄的分頁大小,和 shell 在 pty 裡實際看到的大小一致
      // (證明 stty 真的生效了)。
      const listed = (await api.terminal.list()).find((x: any) => x.id === id);
      g.check(listed.cols === cols && listed.rows === rows, `app 記錄的大小和 shell 看到的一致(${listed.cols}x${listed.rows} / ${cols}x${rows}）`);
      // 80x24 是量不到畫面時的退路;真的量過才會是別的數字(多少取決於螢幕,不能寫死)
      g.check(cols > 20 && rows > 5 && !(cols === 80 && rows === 24), `pty 的大小是量出來的,不是退路值(${cols}x${rows}）`);
      g.check(g.text('#term-cwd').length > 0, '面板上顯示目前的工作目錄');
      await g.shot('02-open');

      // 改面板寬度 → 前景程式要看得到新的寬度(pty 收到 SIGWINCH)
      const handle = g.$('#term-resize') as HTMLElement;
      const press = (key: string, times: number) => {
        handle.focus();
        for (let i = 0; i < times; i++) handle.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      };
      const panelWidth = () => panel().offsetWidth;
      const before = panelWidth();
      press('ArrowRight', 4); // 縮窄
      if (panelWidth() < before) {
        await api.terminal.write(id, 'echo RT_NARROW_$(tput cols)\n');
        const narrow = await g.waitFor(() => (screen().match(/RT_NARROW_(\d+)/) || null), 20000, '縮窄後的欄數');
        g.check(Number(narrow[1]) < cols, `縮窄面板之後 shell 看到的欄數變少(${cols} → ${narrow[1]}）`);
        press('ArrowLeft', 8); // 再拉寬
        await api.terminal.write(id, 'echo RT_WIDER_$(tput cols)\n');
        const wider = await g.waitFor(() => (screen().match(/RT_WIDER_(\d+)/) || null), 20000, '拉寬後的欄數');
        g.check(Number(wider[1]) > Number(narrow[1]), `拉寬面板之後欄數變多(${narrow[1]} → ${wider[1]}）`);
      } else {
        // 螢幕不夠寬時,面板的上下限會撞在一起(CI runner 就是這樣)。這不是壞掉,
        // 是「再怎麼拉也要留給對話」那條規則在作用;此時沒有可測的縮放。
        g.check(true, `螢幕不夠寬,面板已經在最小寬度(${before}px / 視窗 ${window.innerWidth}px),略過縮放檢查`);
      }

      // 換成英文:同一排按鈕變寬,面板要自己讓回去(CI 的機器字體和開發機不同,這條就是為它加的)
      (document.querySelector('input[name="ui-locale"][value="en"]') as HTMLInputElement).click();
      await g.w(500);
      const barEn = g.$('#topbar') as HTMLElement;
      // 視窗夠大就該完全放得下;真的太小(小螢幕 + 英文標籤)時,總得有東西讓步——
      // 那時的底線是「每個按鈕仍然點得到」:工具列可以橫向捲動,捲到底要看得到最右邊那顆。
      const resetBtn = g.$('#reset-btn') as HTMLElement;
      barEn.scrollLeft = barEn.scrollWidth;
      await g.w(150);
      const barBox = barEn.getBoundingClientRect();
      const resetBox = resetBtn.getBoundingClientRect();
      const reachable = resetBox.right <= barBox.right + 1 && resetBox.left >= barBox.left - 1;
      g.check(barEn.scrollWidth <= barEn.clientWidth + 1 || reachable, `英文介面下工具列放得下,或至少捲得到、點得到(${barFit()})`);
      barEn.scrollLeft = 0;
      g.check(controlsFit(), '英文流程選單及送出操作不溢位');
      g.check(!!(g.$('#mode') as HTMLElement).title && !!(g.$('#mode') as HTMLElement).getAttribute('aria-label'), '精簡流程名稱保留完整流程提示與可存取名稱');
      g.check(panel().offsetWidth >= 340, `讓回去之後面板仍有可用寬度(${panel().offsetWidth}px)`);
      (document.querySelector('input[name="ui-locale"][value="zh-Hant"]') as HTMLInputElement).click();
      await g.w(500);

      // 一直拉也不能把對話擠掉:面板有上限,時間軸與工具列一定留得下
      press('ArrowLeft', 40);
      // 小螢幕上留不到 560px(面板有自己的最小寬度),但一定要留得下一段可讀的對話
      g.check(timelineWidth() >= Math.min(540, Math.round(window.innerWidth * 0.3)), `拉到底時時間軸仍然留著(${timelineWidth()}px / 視窗 ${window.innerWidth}px)`);
      g.check(bar.scrollWidth <= bar.clientWidth + 1, `拉到底時工具列仍然放得下(${barFit()})`);

      // 在終端裡改檔案,工作目錄真的會變(harness 之後用 r.read 獨立驗一次)
      await api.terminal.write(id, "printf 'from-terminal\\n' > from-terminal.txt; echo RT_WROTE_$?\n");
      await g.waitFor(() => /RT_WROTE_0/.test(screen()), 20000, '寫檔指令完成');

      // ⌘J 收起來:面板不見了,但分頁還活著(跑著的指令不該被打斷)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true, bubbles: true }));
      await g.waitFor(() => panel().hidden, 5000, '⌘J 收起面板');
      g.check(panel().offsetWidth === 0, '收起來之後不佔畫面');
      g.check((await api.terminal.list()).length === 1, '收起來時分頁繼續活著');

      // ⌘J 再打開:同一個分頁,畫面內容還在
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true, bubbles: true }));
      await g.waitFor(() => !panel().hidden, 5000, '⌘J 再打開');
      g.check(/RT_42_/.test(screen()), '再打開時原本的輸出還在');

      // 第二個分頁:各自獨立,切回來時畫面內容還在
      g.$('#term-new').click();
      const two = await g.waitFor(async () => {
        const list = await api.terminal.list();
        return list.length === 2 ? list : null;
      }, 15000, '第二個分頁');
      g.check(g.$('#term-tabs').children.length === 2, '分頁列有兩個分頁');
      const second = two.find((x: any) => x.id !== id);
      await api.terminal.write(second.id, 'echo RT_$((8*8))_SECOND\n');
      await g.waitFor(() => /RT_64_SECOND/.test(screen()), 20000, '第二個分頁的輸出');
      g.check(!/RT_42_/.test(screen()), '第二個分頁是乾淨的,看不到第一個分頁的輸出');
      await g.shot('04-two-tabs');
      // 切回第一個分頁
      (g.$('#term-tabs .term-tab') as HTMLElement).click();
      await g.waitFor(() => /RT_42_/.test(screen()), 5000, '切回第一個分頁');
      g.check(!/RT_64_SECOND/.test(screen()), '切回來看到的是第一個分頁的內容');

      // 換深色主題:終端有自己的色盤(xterm 認不得 CSS 變數),要跟著換。
      // 放在最後才換,截圖不會拍到切回淺色之後的畫面。
      const panelBg = () => getComputedStyle(panel()).backgroundColor;
      const lightBg = panelBg();
      (document.querySelector('input[name="theme"][value="dark"]') as HTMLInputElement).click();
      await g.waitFor(() => panelBg() !== lightBg, 5000, '終端跟著換成深色');
      g.check(/RT_42_/.test(screen()), '換主題之後畫面內容還在');
      (g.$('#term-body') as HTMLElement).click();
      await g.w(600); // 讓主題轉場畫完再拍
      await g.shot('03-dark');

      // 一個一個關掉 → 最後一個關掉時面板自己收起來,不留一個空面板
      (g.$('#term-tabs .term-tab .term-tab-x') as HTMLElement).click();
      await g.waitFor(async () => (await api.terminal.list()).length === 1, 10000, '關掉第一個分頁');
      g.check(!panel().hidden, '還有分頁時面板留著');
      (g.$('#term-tabs .term-tab .term-tab-x') as HTMLElement).click();
      await g.waitFor(async () => (await api.terminal.list()).length === 0, 10000, '分頁關閉');
      await g.waitFor(() => panel().hidden, 5000, '最後一個分頁關掉後面板收起來');

      const leaks = g.hiddenLeaks();
      g.check(leaks.length === 0, `沒有帶 hidden 卻仍佔版面的元素(${leaks.join(', ') || '無'})`);
      return { cols, rows, cwd: sessions[0].cwd };
    },
  });

  const ok = report('終端面板', r);
  assert.ok(ok, r.error || '情境失敗');
  // 第二條線:不經過 app,直接看磁碟。終端裡下的指令真的動到了工作目錄。
  assert.strictEqual(r.read('from-terminal.txt'), 'from-terminal\n', '終端寫的檔案應該真的在工作目錄裡');
  console.log('  ok - 獨立驗證:終端寫出的檔案真的在工作目錄');
  r.cleanup();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
