// 終端面板:平常收著,工具列的「終端」或 ⌘J 叫出來,靠右直立、和時間軸並排。
//
// 為什麼要有:成員會在工作目錄實際改檔案、跑指令,使用者卻只能在旁邊看。
// 想自己 git diff、npm test、把某個改動 revert 掉,就得切到別的 app、再 cd 一次。
// 這個面板開在同一個工作目錄,分頁跑在真正的 pty 上(vim、top、claude 都能用)。
// 放右邊而不是下面:終端輸出是一行一行往下長的,直立的欄位一次看得到的行數多得多,
// 也不必為了看終端把對話擠掉。
//
// 這裡只負責畫面與輸入輸出;pty、行程與訊號都在主程序(src/terminal.ts)。
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { t } from './i18n';
import { $, escapeHtml, shortPath } from './util';
import { envFixHtml, bindEnvFix } from './env-fix';

export interface TerminalDeps {
  /** 新分頁要開在哪裡。跟著設定走,所以換了工作目錄之後開的分頁也會跟著換 */
  workDir: () => string;
  /** 上次拉好的面板寬度(px);沒有就給 0 */
  width: () => number;
  saveWidth: (width: number) => void;
}

interface Tab {
  id: string;
  /** 第幾個分頁。名稱要跟著介面語言換,所以存號碼而不是存字串 */
  index: number;
  /** 分頁裡的程式自己報的標題(vim、ssh…);沒有就用「終端 n」 */
  title: string;
  cwd: string;
  term: Terminal;
  fit: FitAddon;
  pane: HTMLElement;
  button: HTMLButtonElement;
}

const MIN_WIDTH = 340;
const DEFAULT_WIDTH = 460;
const MAX_RATIO = 0.7;
// 再怎麼拉也要留給對話的寬度。少了這條,終端可以把時間軸壓到只剩一條縫,
// 上方工具列的按鈕也會被擠到要捲才點得到(那排按鈕最少需要 ~510px)。
const MIN_TIMELINE = 560;

let deps: TerminalDeps;
let tabs: Tab[] = [];
let activeId = '';
let counter = 0;
let width = DEFAULT_WIDTH;
let opening = false;

const panel = () => $<HTMLElement>('#terminal-panel');
const body = () => $<HTMLDivElement>('#term-body');
const tabBar = () => $<HTMLDivElement>('#term-tabs');
const toggleButton = () => $<HTMLButtonElement>('#terminal-btn');
const find = (id: string) => tabs.find((tab) => tab.id === id);
const active = () => find(activeId);

// ---------- 配色 ----------
// xterm 要的是實際色碼,拿不到 CSS 變數,所以兩套主題各寫一份。
// 色相跟著 app 的藍,ANSI 八色在兩個背景上都測過對比,不是隨手抓的預設盤。
const DARK: ITheme = {
  background: '#0a0d14', foreground: '#d9dfec', cursor: '#7c96ff', cursorAccent: '#0a0d14',
  selectionBackground: 'rgba(124, 150, 255, .30)', selectionForeground: '#ffffff',
  black: '#2a3140', red: '#ff6b6b', green: '#3ddc97', yellow: '#ffc857',
  blue: '#7c96ff', magenta: '#c792ea', cyan: '#56d4dd', white: '#d9dfec',
  brightBlack: '#5b6580', brightRed: '#ff9a9a', brightGreen: '#7ff0bc', brightYellow: '#ffd98a',
  brightBlue: '#a8bcff', brightMagenta: '#dcb8ff', brightCyan: '#8ae9f0', brightWhite: '#f3f6fc',
};
const LIGHT: ITheme = {
  background: '#fbfcff', foreground: '#232936', cursor: '#4f6bed', cursorAccent: '#ffffff',
  selectionBackground: 'rgba(79, 107, 237, .20)', selectionForeground: '#111725',
  black: '#394152', red: '#c23b3b', green: '#0f8a5f', yellow: '#96660a',
  blue: '#3f5ad8', magenta: '#8b48c2', cyan: '#0e7a88', white: '#c9cfdb',
  brightBlack: '#6b7488', brightRed: '#d95f5f', brightGreen: '#17a874', brightYellow: '#b98216',
  brightBlue: '#5b76ea', brightMagenta: '#a463d9', brightCyan: '#1897a8', brightWhite: '#eef1f8',
};

function darkMode(): boolean {
  const theme = document.documentElement.dataset.theme;
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

const palette = (): ITheme => (darkMode() ? DARK : LIGHT);

/** 主題或系統外觀變了就換色盤(從 applyAppearance 呼叫) */
export function syncTerminalTheme(): void {
  const theme = palette();
  for (const tab of tabs) tab.term.options.theme = theme;
}

// ---------- 面板 ----------
export function isTerminalOpen(): boolean { return !panel().hidden; }

function applyWidth(next: number): void {
  const sidebar = document.querySelector<HTMLElement>('#sidebar');
  const room = window.innerWidth - (sidebar ? sidebar.offsetWidth : 0) - MIN_TIMELINE;
  const max = Math.max(MIN_WIDTH, Math.min(Math.round(window.innerWidth * MAX_RATIO), Math.round(room)));
  width = Math.min(max, Math.max(MIN_WIDTH, Math.round(next)));
  panel().style.width = `${width}px`;
  // 上面那個保留寬度只是個估計:同一排按鈕在不同字體、不同介面語言下需要的寬度不一樣
  // (英文比中文寬,CI 的機器又和開發機不同)。所以量一次真的放不放得下,放不下就把面板讓回去——
  // 不要賭一個寫死的數字剛好夠,那排按鈕被擠出去就點不到了。
  const bar = document.querySelector<HTMLElement>('#topbar');
  if (!bar) return;
  const overflow = bar.scrollWidth - bar.clientWidth;
  if (overflow <= 0) return;
  width = Math.max(MIN_WIDTH, width - overflow);
  panel().style.width = `${width}px`;
}

export async function toggleTerminal(force?: boolean): Promise<void> {
  const open = typeof force === 'boolean' ? force : !isTerminalOpen();
  if (open === isTerminalOpen() && (!open || tabs.length)) {
    if (open) active()?.term.focus();
    return;
  }
  if (!open) {
    // 收起來而已:分頁繼續跑,跑著的指令不會被打斷
    panel().hidden = true;
    toggleButton().classList.remove('on');
    toggleButton().setAttribute('aria-expanded', 'false');
    $<HTMLTextAreaElement>('#input').focus();
    return;
  }
  panel().hidden = false;
  toggleButton().classList.add('on');
  toggleButton().classList.remove('busy');
  toggleButton().setAttribute('aria-expanded', 'true');
  applyWidth(width);
  if (!tabs.length) await newTab();
  else { fitActive(); active()?.term.focus(); }
}

function showError(message: string): void {
  const el = $<HTMLDivElement>('#term-error');
  // 和 app 其他地方同一張卡片;終端開不起來多半是系統層面的事,沒有可照做的指令時就只有那句話
  el.innerHTML = message ? envFixHtml({ hint: message }) : '';
  bindEnvFix(el);
  el.hidden = !message;
}

// ---------- 分頁 ----------
async function newTab(): Promise<void> {
  if (opening) return;
  opening = true;
  try {
    const pane = document.createElement('div');
    pane.className = 'term-pane';
    body().appendChild(pane);
    // 先讓新的 pane 可見再 open:display:none 的容器量不到字寬,
    // fit 會退回預設的 80x24,pty 的大小就跟畫面對不上了。
    for (const other of tabs) other.pane.classList.remove('on');
    pane.classList.add('on');

    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.35,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      scrollback: 5000,
      drawBoldTextInBrightColors: true,
      macOptionIsMeta: true,
      allowProposedApi: true,
      theme: palette(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(pane);
    // 先量一次再開 pty:一開始就用正確的大小,省掉開場那次重排
    try { fit.fit(); } catch {}

    const created = await window.api.terminal.create({ cols: term.cols, rows: term.rows, cwd: deps.workDir() });
    if (!created.ok) {
      pane.remove();
      term.dispose();
      showError(created.error);
      if (activeId) selectTab(activeId); // 開不起來就把畫面還給原本那個分頁
      return;
    }
    showError('');

    counter += 1;
    const button = document.createElement('button');
    button.className = 'term-tab';
    button.type = 'button';
    button.setAttribute('role', 'tab');
    const tab: Tab = { id: created.session.id, index: counter, title: '', cwd: created.session.cwd, term, fit, pane, button };
    renderTabButton(tab);
    button.onclick = () => selectTab(tab.id);
    button.oncontextmenu = (e) => { e.preventDefault(); closeTab(tab.id); };
    tabBar().appendChild(button);
    tabs.push(tab);

    term.onData((data) => { void window.api.terminal.write(tab.id, data); });
    term.onBinary((data) => { void window.api.terminal.write(tab.id, data); });
    term.onResize(({ cols, rows }) => { void window.api.terminal.resize(tab.id, cols, rows); });
    term.onTitleChange((title) => {
      // 程式自己報的標題(例如 ssh、vim)比「終端 1」有用
      tab.title = title.trim().slice(0, 24);
      renderTabButton(tab);
    });
    term.attachCustomKeyEventHandler(handleKey);

    selectTab(tab.id);
  } finally {
    opening = false;
  }
}

function renderTabButton(tab: Tab): void {
  const label = tab.title || t('term.tabName', { n: tab.index });
  tab.button.innerHTML = `<span class="term-tab-dot"></span><span class="term-tab-name">${escapeHtml(label)}</span><span class="term-tab-x" aria-hidden="true">✕</span>`;
  tab.button.title = tab.cwd;
  const close = tab.button.querySelector<HTMLElement>('.term-tab-x');
  if (close) close.onclick = (e) => { e.stopPropagation(); closeTab(tab.id); };
}

function selectTab(id: string): void {
  activeId = id;
  for (const tab of tabs) {
    const on = tab.id === id;
    tab.pane.classList.toggle('on', on);
    tab.button.classList.toggle('active', on);
    tab.button.setAttribute('aria-selected', String(on));
    if (on) tab.button.classList.remove('unseen');
  }
  const current = active();
  $<HTMLElement>('#term-cwd').textContent = current ? shortPath(current.cwd) : '';
  $<HTMLElement>('#term-cwd').title = current ? current.cwd : '';
  fitActive();
  current?.term.focus();
}

function closeTab(id: string): void {
  const tab = find(id);
  if (!tab) return;
  void window.api.terminal.close(id);
  dropTab(id);
}

// 分頁消失(使用者關掉、或 shell 自己結束)之後的收尾
function dropTab(id: string): void {
  const tab = find(id);
  if (!tab) return;
  tab.term.dispose();
  tab.pane.remove();
  tab.button.remove();
  tabs = tabs.filter((item) => item.id !== id);
  if (!tabs.length) {
    counter = 0;
    void toggleTerminal(false);
    return;
  }
  if (activeId === id) selectTab(tabs[tabs.length - 1].id);
}

function fitActive(): void {
  const tab = active();
  if (!tab || panel().hidden) return;
  try { tab.fit.fit(); } catch {}
}

// ⌘T 開分頁、⌘W 關分頁、⌘K 清空、⌘J 收起來:這幾個不送進 shell。
// 其餘一律讓 xterm 處理,Ctrl-C / Ctrl-D / 方向鍵才會是終端原本的行為。
function handleKey(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown' || !(event.metaKey || event.ctrlKey) || event.altKey) return true;
  const key = event.key.toLowerCase();
  if (key === 't') { event.preventDefault(); void newTab(); return false; }
  if (key === 'w') { event.preventDefault(); if (activeId) closeTab(activeId); return false; }
  if (key === 'k') { event.preventDefault(); active()?.term.clear(); return false; }
  if (key === 'j') { event.preventDefault(); void toggleTerminal(false); return false; }
  return true;
}

// ---------- 拖曳改高度 ----------
function setupResize(): void {
  const handle = $<HTMLDivElement>('#term-resize');
  let startX = 0;
  let startWidth = 0;
  const move = (e: PointerEvent) => { applyWidth(startWidth + (startX - e.clientX)); fitActive(); };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.body.classList.remove('term-resizing');
    deps.saveWidth(width);
    fitActive();
  };
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = width;
    document.body.classList.add('term-resizing');
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
  // 鍵盤也能調:分隔線是 separator,左右鍵各 32px
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    applyWidth(width + (e.key === 'ArrowLeft' ? 32 : -32));
    deps.saveWidth(width);
    fitActive();
  });
}

// ---------- 安裝 ----------
export function setupTerminal(d: TerminalDeps): void {
  deps = d;
  width = d.width() || DEFAULT_WIDTH;
  applyWidth(width);

  $<HTMLButtonElement>('#terminal-btn').onclick = () => { void toggleTerminal(); };
  $<HTMLButtonElement>('#term-new').onclick = () => { void newTab(); };
  $<HTMLButtonElement>('#term-hide').onclick = () => { void toggleTerminal(false); };
  $<HTMLButtonElement>('#term-clear').onclick = () => { active()?.term.clear(); active()?.term.focus(); };
  setupResize();

  window.api.terminal.onData(({ id, data }) => {
    const tab = find(id);
    if (!tab) return;
    tab.term.write(data);
    // 沒在看的分頁(或整個面板收著時)標一個點,回來才知道剛剛有動靜
    if (panel().hidden) toggleButton().classList.add('busy');
    else if (id !== activeId) tab.button.classList.add('unseen');
  });
  window.api.terminal.onExit(({ id }) => dropTab(id));

  // 面板大小、視窗大小、字級改變都要重新量:pty 的 cols/rows 要跟畫面一致,
  // 不然 vim 這類全螢幕程式會畫在錯的地方。
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => fitActive()).observe(body());
  window.addEventListener('resize', () => { applyWidth(width); fitActive(); });
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (!document.documentElement.dataset.theme || document.documentElement.dataset.theme === 'system') syncTerminalTheme();
    });
  }
  // 選取之後按 ⌘C:xterm 的選取不在 DOM 選取裡,系統選單的「拷貝」拿不到,
  // 所以在 copy 事件裡自己把選取的文字放進剪貼簿。
  panel().addEventListener('copy', (e: ClipboardEvent) => {
    const selection = active()?.term.getSelection();
    if (!selection || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', selection);
    e.preventDefault();
  });
}

/**
 * 把修復指令送進終端:打開面板、必要時開一個分頁,指令填好但不按 Enter。
 * 不自動執行是刻意的——sudo、安裝、啟動服務這種事要由使用者自己確認後送出。
 */
export async function openTerminalWith(command: string): Promise<void> {
  if (!command) return;
  await toggleTerminal(true);
  const tab = active();
  if (!tab) return;
  await window.api.terminal.write(tab.id, command);
  tab.term.focus();
}

/** 切換介面語言時重畫分頁名稱,並重新確認工具列還放得下(英文的按鈕比中文寬) */
export function relocalizeTerminal(): void {
  for (const tab of tabs) renderTabButton(tab);
  if (!panel().hidden) { applyWidth(width); fitActive(); }
}
