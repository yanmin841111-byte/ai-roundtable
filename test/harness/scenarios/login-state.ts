'use strict';

// 情境:CLI 裝好了但沒登入時,畫面有沒有說實話。
//
// 以前 --version 成功就亮綠燈,使用者要送出任務、等它失敗,才會看到一段 stderr 或
// 「401 Unauthorized: Missing bearer…」。這裡驗三件事:成員卡的徽章、設定頁的提示與
// 登入指令,以及真的送出任務時的錯誤訊息。
//
// 用空的設定目錄模擬沒登入(CLAUDE_CONFIG_DIR / CODEX_HOME),不碰使用者真正的登入。
// 需要機器上裝有 claude 與 codex;沒裝就跳過(這個情境本來就不適合進 CI)。

import assert from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runApp, report } from '../app';

function installed(bin: string): boolean {
  try { execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch { return false; }
}

async function main() {
  const missing = ['claude', 'codex'].filter((b) => !installed(b));
  if (missing.length) { console.log(`跳過:這台機器沒有安裝 ${missing.join('、')}`); return; }

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-noauth-'));
  fs.mkdirSync(path.join(empty, 'claude'));
  fs.mkdirSync(path.join(empty, 'codex'));

  const r = await runApp({
    members: [
      { id: 'c1', name: 'Claude', cli: 'claude' },
      { id: 'x1', name: 'Codex', cli: 'codex' },
    ],
    // 設成空字串而不是刪掉:main.ts 會從登入 shell 補回「未定義」的變數,空字串則會保留
    env: {
      CLAUDE_CONFIG_DIR: path.join(empty, 'claude'),
      CODEX_HOME: path.join(empty, 'codex'),
      ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', OPENAI_API_KEY: '', CODEX_API_KEY: '',
    },
    timeoutMs: 4 * 60 * 1000,
    scenario: async () => {
      const g: any = globalThis;
      await g.ready();
      await g.waitFor(() => /\d+\s*\/\s*\d+/.test(g.text('#cli-summary')), 20000, 'CLI 健康檢查完成');
      await g.w(300);

      const badges = (i: number) => Array.from(
        (document.querySelectorAll('#agent-list > *')[i] || document.createElement('div')).querySelectorAll('.agent-name .badge'),
      ).map((b) => (b.textContent || '').trim());
      g.check(badges(0).includes('需要登入'), `Claude 成員卡顯示「需要登入」(${badges(0).join(' / ')})`);
      g.check(badges(1).includes('需要登入'), `Codex 成員卡顯示「需要登入」(${badges(1).join(' / ')})`);
      await g.shot('01-badges');

      g.$('#settings-btn').click();
      const rows = await g.waitFor(() => {
        const list = Array.from(document.querySelectorAll('#ext-list > *')).map((e) => ({
          text: (e.textContent || '').replace(/\s+/g, ' ').trim(),
          // 修復卡片全 app 統一:主要動作是「在終端執行」,旁邊保留「複製」
          fix: (e.querySelector('[data-env-run]') as HTMLElement | null)?.dataset.envRun || '',
          copy: (e.querySelector('[data-env-copy]') as HTMLElement | null)?.dataset.envCopy || '',
        }));
        return list.some((x: any) => /Claude Code/.test(x.text) && /尚未登入/.test(x.text)) ? list : null;
      }, 20000, '設定頁的登入提示');
      const claude = rows.find((x: any) => /Claude Code/.test(x.text));
      const codex = rows.find((x: any) => /Codex/.test(x.text));
      g.check(claude.fix === 'claude auth login', `Claude 的登入指令可以直接在終端執行(${claude.fix})`);
      g.check(codex.fix === 'codex login', `Codex 的登入指令可以直接在終端執行(${codex.fix})`);
      g.check(claude.copy === 'claude auth login' && codex.copy === 'codex login', '也保留「複製」給想自己貼的人');
      // 切到登入提示所在的分頁,並等設定視窗的淡入動畫跑完,截圖才拍得到重點
      (document.querySelector('.settings-tab[data-tab="clis"]') as HTMLElement).click();
      await g.w(600);
      await g.shot('02-settings');
      g.$('#settings-close').click();

      // 真的送出:錯誤要說「沒登入、怎麼修」,而不是一段原始 stderr
      const msgs = await g.send('@Claude 你好', 'divide');
      const turn = msgs.find((m: any) => m.kind === 'agent' && m.agentName === 'Claude');
      g.check(!!turn && /尚未登入/.test(turn.error || ''), `執行時的錯誤說明是沒登入(${String(turn && turn.error).split('\n')[0]})`);
      g.check(/claude auth login/.test(turn.error || ''), '錯誤訊息附上登入指令');
      await g.shot('03-turn-error');

      const leaks = g.hiddenLeaks();
      g.check(leaks.length === 0, `沒有帶 hidden 卻仍佔版面的元素(${leaks.join(', ') || '無'})`);
      return { claudeError: String(turn.error).split('\n')[0] };
    },
  });

  fs.rmSync(empty, { recursive: true, force: true });
  const ok = report('登入狀態', r);
  assert.ok(ok, r.error || '情境失敗');
  r.cleanup();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
