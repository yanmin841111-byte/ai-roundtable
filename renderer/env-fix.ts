// 環境問題的統一呈現:照實說一句話,再給「照做就能修好」的下一步。
//
// 為什麼要統一:這個 app 依賴一堆「在你這台機器上才知道」的東西——CLI 有沒有裝、有沒有登入、
// 本機模型有沒有跑起來、這台 Mac 的 git 能不能用。以前每個地方各講各的:有的只丟英文原文,
// 有的叫使用者去做沒有用的事(git 不能用卻叫他 git init),有的給一段指令要自己複製、
// 自己去別的 app 開終端機貼上。
//
// 現在一律是同一張卡片:發生什麼事 → 一顆按鈕就能做的下一步。
// 指令直接送進內建終端(填好但不按 Enter,sudo 這種東西不該由 app 代按);
// 沒有單一指令可跑的(例如還沒安裝某個 CLI)就打開官方說明頁。

import { t } from './i18n';
import { escapeHtml } from './util';
import { openTerminalWith } from './terminal';
import type { CliHealth, CliType, EnvFix } from './api';

/** 卡片上可以多帶一句說明;動作本身的形狀由 src/ipc-types.ts 的 EnvFix 定義 */
export type EnvFixCard = EnvFix & { hint?: string };

// 「打開設定」這個動作要由 app.ts 提供(env-fix 不認得設定畫面,也不該反向 import)
let openSettings: ((tab: string) => void) | null = null;
export function setEnvFixHandlers(handlers: { openSettings: (tab: string) => void }): void {
  openSettings = handlers.openSettings;
}

export function envFixHtml(fix: EnvFixCard | null | undefined): string {
  if (!fix || (!fix.hint && !fix.command && !fix.url && !fix.settingsTab)) return '';
  const hint = fix.hint ? `<div class="env-fix-hint">${escapeHtml(fix.hint)}</div>` : '';
  const command = fix.command
    ? `<div class="env-fix-row"><code class="env-fix-cmd">${escapeHtml(fix.command)}</code>`
      + `<button type="button" class="ghost small" data-env-run="${escapeHtml(fix.command)}" title="${escapeHtml(t('fix.runTitle'))}">${escapeHtml(t('fix.run'))}</button>`
      + `<button type="button" class="ghost small" data-env-copy="${escapeHtml(fix.command)}">${escapeHtml(t('fix.copy'))}</button></div>`
    : '';
  // 一次只給一個下一步:指令 > 設定 > 說明頁。兩顆按鈕並列會讓「該按哪一個」變成一個問題
  const settings = !fix.command && fix.settingsTab
    ? `<div class="env-fix-row"><button type="button" class="ghost small" data-env-settings="${escapeHtml(fix.settingsTab)}">${escapeHtml(t('fix.openSettings'))}</button></div>`
    : '';
  const url = !fix.command && !fix.settingsTab && fix.url
    ? `<div class="env-fix-row"><button type="button" class="ghost small" data-env-url="${escapeHtml(fix.url)}">${escapeHtml(t('fix.openDocs'))}</button></div>`
    : '';
  return `<div class="env-fix">${hint}${command}${settings}${url}</div>`;
}

/** 綁定卡片上的按鈕。用 innerHTML 畫完之後呼叫一次 */
export function bindEnvFix(root: ParentNode = document): void {
  root.querySelectorAll<HTMLButtonElement>('[data-env-run]').forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation(); // CLI 列整列可點(打開編輯器),修復按鈕不該順便觸發它
      void openTerminalWith(button.dataset.envRun || '');
    };
  });
  root.querySelectorAll<HTMLButtonElement>('[data-env-copy]').forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      void navigator.clipboard.writeText(button.dataset.envCopy || '').then(() => {
        button.textContent = t('fix.copied');
        setTimeout(() => { button.textContent = t('fix.copy'); }, 1600);
      }).catch(() => {});
    };
  });
  root.querySelectorAll<HTMLButtonElement>('[data-env-settings]').forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      if (openSettings) openSettings(button.dataset.envSettings || 'general');
    };
  });
  root.querySelectorAll<HTMLButtonElement>('[data-env-url]').forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      // 主程序的 setWindowOpenHandler 會改用系統瀏覽器開啟,不會在 app 裡開新視窗
      window.open(button.dataset.envUrl || '', '_blank');
    };
  });
}

export interface CliDescription {
  tone: 'ok' | 'warn' | 'bad' | '';
  /** 一句話:現在是什麼狀態。ready 時是版本號 */
  text: string;
  /** 原始錯誤(英文居多),放 title 讓需要的人查得到 */
  detail: string;
  fix: EnvFixCard | null;
}

/**
 * 健康檢查結果 → 畫面要說的話與可照做的下一步。
 * 設定頁與成員的模型設定都用這一份,兩邊不會再出現同一個狀態兩種說法。
 */
export function describeCliHealth(status: CliHealth | undefined, type?: CliType): CliDescription {
  if (!status) return { tone: '', text: type && type.bin ? t('ext.checking') : t('ext.noCheck'), detail: '', fix: null };
  const detail = status.error && status.error !== status.hint ? status.error : '';
  if (status.state === 'ready') return { tone: 'ok', text: status.version || t('cli.ready'), detail: '', fix: null };
  // unauthenticated 與 unreachable 都是「設定在,只差一步」
  if (status.state === 'unauthenticated' || status.state === 'unreachable') {
    const text = status.hint || t(status.state === 'unauthenticated' ? 'cli.unauthenticated' : 'cli.unreachable');
    return { tone: 'warn', text, detail, fix: status.fix || null };
  }
  return { tone: 'bad', text: status.error || t('cli.missing'), detail, fix: status.fix || null };
}
