import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { Store } from './src/store';
import { Orchestrator } from './src/orchestrator';
import { Registry, setRegistry } from './src/adapters';
import { writeSession, messagesToMarkdown, listSessions, readSession, deleteSession, listConversationIds } from './src/session-log';
import * as attachments from './src/attachments';
import { collectChanges } from './src/diff';
import { SecretStore } from './src/secrets';
import type { AttachmentInput, AttachmentMeta, EventChannel, InvokeChannel, IpcArgs, IpcEvents, IpcReturn } from './src/ipc-types';
import { tx, resolveTextLocale, setSystemLocale } from './src/text';

// 從 Finder / Dock 啟動時環境變數很精簡:補上登入 shell 的 PATH 才找得到 claude / codex,
// 也補上 shell 設定檔裡的其他變數(例如 DEEPSEEK_API_KEY),但不覆蓋已經存在的值。
function importShellEnv() {
  const extra = [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.npm-global/bin')];
  const marker = '__AI_ROUNDTABLE_ENV__';
  try {
    const out = execSync(`${process.env.SHELL || '/bin/zsh'} -ilc 'echo ${marker}; env'`, { encoding: 'utf8', timeout: 5000 });
    const lines = out.slice(out.indexOf(marker) + marker.length).split('\n');
    let key: any = null;
    const shellEnv: Record<string, any> = {};
    for (const line of lines) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) { key = m[1]; shellEnv[key] = m[2]; } else if (key) shellEnv[key] += '\n' + line; // 多行值
    }
    if (shellEnv.PATH) extra.unshift(...shellEnv.PATH.split(':'));
    for (const [k, v] of Object.entries(shellEnv)) {
      if (k !== 'PATH' && process.env[k] === undefined && !/^(_|SHLVL|PWD|OLDPWD)$/.test(k)) process.env[k] = v;
    }
  } catch {}
  const seen = new Set();
  process.env.PATH = [...extra, ...(process.env.PATH || '').split(':')].filter((p: any) => p && !seen.has(p) && seen.add(p)).join(':');
}

let mainWindow: BrowserWindow | null = null;
let store: Store;
let orchestrator: Orchestrator;
let registry: Registry;
let secrets: SecretStore;
let activeTaskStart: number | null = null;
let wasRunning = false;
// 目前對話寫入的紀錄檔;同一段對話每次任務結束都覆寫這一份,新對話時清空
let sessionFileId: string | null = null;
// 已經落地、但還沒隨訊息送出的附件(對應介面上的 chip)。
// 上限由這裡把關,不信任 renderer 傳來的數字。
let pending: AttachmentMeta[] = [];

const userData = () => app.getPath('userData');
// 主程序產生的少數使用者可見文字跟著介面語言
const uiLocale = () => resolveTextLocale(store.get().settings.uiLocale);
const text = (key: string, params: Record<string, string | number> = {}) => tx(uiLocale(), key, params);
// 對話框附在主視窗上;視窗還沒建立(或已關閉)時退回無父視窗的版本
const showOpenDialog = (options: Electron.OpenDialogOptions) =>
  mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options);
const showSaveDialog = (options: Electron.SaveDialogOptions) =>
  mainWindow ? dialog.showSaveDialog(mainWindow, options) : dialog.showSaveDialog(options);
const pendingBytes = () => pending.reduce((n, a) => n + (a.size || 0), 0);

// 依 src/ipc-types.ts 的契約註冊 handler:參數與回傳值都要符合 renderer 看到的型別。
function handle<C extends InvokeChannel>(channel: C, fn: (...args: IpcArgs<C>) => IpcReturn<C> | Promise<IpcReturn<C>>) {
  ipcMain.handle(channel, (_e, ...args) => fn(...(args as IpcArgs<C>)));
}

function dropPending(list: AttachmentMeta[]) {
  for (const meta of list) attachments.removeAttachment(userData(), meta);
}

function resetPending() {
  dropPending(pending);
  pending = [];
}

function persistTask() {
  // runTask 的 rejection handler 可能會在 idle 事件後補上一則錯誤訊息。
  setImmediate(() => {
    const snap = orchestrator.snapshot();
    if (!snap.messages.length) return;
    // conversationId 要寫進紀錄,刪這份對話時才知道要清哪個附件目錄
    const result = writeSession(userData(), snap.messages, { conversationId: snap.conversationId, id: sessionFileId });
    if (result.ok) sessionFileId = result.id;
    send('session:saved', { id: sessionFileId });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'AI Roundtable',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f7f7f4',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer/index.html'));
  // 端對端測試(npm run e2e):載入後在介面執行劇本,把結果印到 stdout,依結果決定結束代碼
  const e2eScript = process.env.AI_ROUNDTABLE_E2E_SCRIPT;
  if (e2eScript) win.webContents.once('did-finish-load', async () => {
    let result: { ok?: boolean } | null = null;
    try { result = await win.webContents.executeJavaScript(fs.readFileSync(e2eScript, 'utf8')); } catch (e) { result = { ok: false, ...{ error: e instanceof Error ? e.message : String(e) } }; }
    console.log(`E2E_RESULT ${JSON.stringify(result)}`);
    stopOrchestrator();
    app.exit(result && result.ok ? 0 : 1);
  });
  // 測試 harness 的多張截圖:劇本在 renderer 裡 console.log('__SHOT__ 名稱'),主程序看到就拍一張。
  // 用 console 當通道是刻意的——不必為了測試在 preload 開新的 IPC 面,production 沒有多一吋介面。
  const shotDir = process.env.AI_ROUNDTABLE_E2E_SHOT_DIR;
  if (shotDir) win.webContents.on('console-message', (_e, _level, msg) => {
    const m = /^__SHOT__ (.+)$/.exec(String(msg || '').trim());
    if (!m) return;
    const name = m[1].replace(/[^A-Za-z0-9._-]/g, '_');
    void (async () => {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir, `${name}.png`), img.toPNG());
        console.log(`__SHOT_OK__ ${name}`);
      } catch (e) { console.log(`__SHOT_FAIL__ ${name} ${e instanceof Error ? e.message : String(e)}`); }
    })();
  });

  const shotFile = process.env.AI_ROUNDTABLE_SHOT;
  if (shotFile) win.webContents.once('did-finish-load', () => setTimeout(async () => {
    if (process.env.AI_ROUNDTABLE_SHOT_JS) console.log('js:', await win.webContents.executeJavaScript(process.env.AI_ROUNDTABLE_SHOT_JS));
    await new Promise((r) => setTimeout(r, 500));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(shotFile, img.toPNG());
    console.log('screenshot saved');
  }, 2500));
  if (process.env.AI_ROUNDTABLE_DEBUG) win.webContents.on('console-message', (_e, level, msg, line, src) => console.log(`[renderer:${level}] ${msg} (${path.basename(src || '')}:${line})`));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  mainWindow = win;
}

function send<C extends EventChannel>(channel: C, ...payload: IpcEvents[C] extends void ? [] : [IpcEvents[C]]) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...payload);
}
function stopOrchestrator() { if (orchestrator) orchestrator.stop(); }

app.whenReady().then(async () => {
  importShellEnv();
  setSystemLocale(app.getLocale());
  store = new Store(app.getPath('userData'));
  secrets = new SecretStore(app.getPath('userData'), safeStorage);
  // 擴充資料夾可用 AI_ROUNDTABLE_ADAPTERS_DIR 覆寫(方便開發外掛)
  registry = new Registry({
    userDir: process.env.AI_ROUNDTABLE_ADAPTERS_DIR || path.join(app.getPath('userData'), 'adapters'),
    templatesDir: path.join(__dirname, 'adapters', 'templates'),
    getSecret: (ref: any) => secrets.get(ref),
    setSecret: (ref: any, value: any) => secrets.set(ref, value),
    getLocale: () => resolveTextLocale(store.get().settings.uiLocale),
  });
  setRegistry(registry);
  // 先在背景讀模型清單(例如 cursor-agent --list-models),介面第一次要清單時就不用等
  for (const { refreshModels } of registry.list()) if (refreshModels) Promise.resolve().then(refreshModels).catch(() => {});
  orchestrator = new Orchestrator(store);
  orchestrator.on('message', (m: IpcEvents['chat:message']) => send('chat:message', m));
  orchestrator.on('state', (s: IpcEvents['chat:state']) => {
    send('chat:state', s);
    if (wasRunning && !s.running && activeTaskStart != null) {
      activeTaskStart = null;
      persistTask();
    }
    wasRunning = !!s.running;
  });
  orchestrator.on('reset', () => { activeTaskStart = null; sessionFileId = null; resetPending(); send('chat:reset'); });

  // 啟動清理:
  //   1. 上次被強制關閉時可能在使用者的工作目錄留下 .roundtable-runtime,一定要清掉
  //   2. 從未寫進 session 的暫存對話附件視為孤兒;已存檔的附件不因時間自動刪除
  try {
    attachments.clearRuntime(store.get().settings.workDir);
    attachments.cleanupOrphans(userData(), {
      keepIds: listConversationIds(userData()),
      activeId: orchestrator.conversationId,
    });
  } catch {}

  handle('config:get', () => store.get());
  handle('config:save', (cfg) => store.save(cfg));
  handle('cli:types', () => registry.catalog());
  handle('cli:check', (opts) => registry.checkAll(opts || {}));

  // CLI 擴充管理
  handle('ext:list', () => registry.summary());
  handle('ext:reload', () => registry.reload());
  handle('ext:install', (templateFile) => registry.installTemplate(templateFile));
  handle('ext:read', (file) => {
    let migration = '';
    let migrationError = '';
    if (file.endsWith('.json')) {
      const r = registry.migrateLegacyApiKey(file);
      if (r.error) migrationError = r.error;
      else if (r.migrated) { migration = text('ext.legacyKeyMigrated'); registry.reload(); }
    }
    return { content: registry.readFile(file), migration, migrationError };
  });
  handle('ext:write', ({ file, content, originalFile }) => registry.writeFile(file, content, { originalFile }));
  handle('ext:delete', (file) => registry.deleteFile(file));
  handle('ext:openDir', () => shell.openPath(registry.userDir));
  handle('ext:openDocs', () => shell.openExternal('https://github.com/yanmin841111-byte/ai-roundtable/blob/main/docs/adapters.md'));
  handle('dialog:pickDir', async () => {
    const r = await showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:pickExecutable', async () => {
    const r = await showOpenDialog({ properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('secrets:set', ({ ref, value }) => secrets.set(ref, value));
  handle('secrets:status', ({ ref, envName }) => secrets.status(ref, envName));
  handle('secrets:clear', ({ ref }) => secrets.clear(ref));
  handle('secrets:test', async ({ adapterId }) => {
    const adapter = registry.loadFresh(adapterId);
    if (!adapter) return { ok: false, error: text('main.extNotFound') };
    if (typeof adapter.testConnection !== 'function') return { ok: false, error: text('main.extNoTest') };
    return adapter.testConnection();
  });
  handle('shell:openPath', (p) => shell.openPath(p));
  handle('chat:snapshot', () => ({ ...orchestrator.snapshot(), sessionId: sessionFileId }));
  // ---------- 附件 ----------
  // 權威儲存在 userData/attachments/<conversationId>/,不寫進使用者的工作目錄。
  const addFiles = (items: AttachmentInput[]) => {
    const result = attachments.addAttachments(userData(), orchestrator.conversationId, items, {
      existingCount: pending.length,
      existingBytes: pendingBytes(),
      // 拒絕原因會直接顯示在輸入框,跟著介面語言
      locale: uiLocale(),
    });
    pending = [...pending, ...result.added];
    // added = 這批新加的;attachments = 目前完整的 pending 清單。兩個都給,renderer 不必猜。
    return { added: result.added, attachments: pending, errors: result.errors, limits: attachments.LIMITS };
  };

  handle('attachments:list', () => ({ attachments: pending, limits: attachments.LIMITS }));
  handle('attachments:add', (payload) => addFiles(Array.isArray(payload?.items) ? payload.items : []));
  handle('attachments:pick', async () => {
    const r = await showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: text('main.attachFilter'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'txt', 'md', 'json', 'csv', 'log'] },
      ],
    });
    if (r.canceled || !r.filePaths.length) return { attachments: pending, errors: [], canceled: true, limits: attachments.LIMITS };
    return addFiles(r.filePaths.map((file) => ({ name: path.basename(file), path: file })));
  });
  handle('attachments:remove', (payload) => {
    const id = payload?.id;
    const meta = pending.find((a) => a.id === id);
    if (meta) {
      attachments.removeAttachment(userData(), meta);
      pending = pending.filter((a) => a.id !== id);
    }
    return { attachments: pending };
  });
  // 縮圖走 data URL(CSP 維持 img-src 'self' data:,不放寬成 file:)
  handle('attachments:thumb', (meta) => attachments.thumbDataUrl(userData(), meta));

  handle('chat:send', async ({ text, mode, attachments: wanted }) => {
    const snap = orchestrator.snapshot();
    if (!snap.running) activeTaskStart = snap.messages.length;
    // renderer 決定「這次要送哪些 chip」,main 仍是唯一驗證與儲存的一方
    let sending = pending;
    if (Array.isArray(wanted)) {
      const keep = new Set(wanted.map((a: any) => (a && a.id) || a));
      sending = pending.filter((a: any) => keep.has(a.id));
      dropPending(pending.filter((a: any) => !keep.has(a.id)));
    }
    const message = await orchestrator.userMessage(text, mode, sending);
    // 成功交給 orchestrator 之後才清 pending:中途丟例外時 renderer 會復原 chip,
    // 後端若先清空就會變成「畫面上還有附件,送出卻是空的」
    pending = [];
    // 沒有可用成員、工作目錄無法建立等前置失敗不會進入 running 狀態。
    if (!orchestrator.snapshot().running && activeTaskStart != null) {
      activeTaskStart = null;
      persistTask();
    }
    return message;
  });
  handle('chat:export', async () => {
    const messages = orchestrator.snapshot().messages;
    if (!messages.length) return { ok: false, error: text('main.nothingToExport') };
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const result = await showSaveDialog({
      title: text('main.exportTitle'),
      defaultPath: `ai-roundtable-${stamp}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      await fs.promises.writeFile(result.filePath, messagesToMarkdown(messages, resolveTextLocale(store.get().settings.uiLocale)), 'utf8');
      return { ok: true, file: result.filePath };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });
  handle('chat:openSessions', () => {
    const dir = path.join(app.getPath('userData'), 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });
  handle('session:list', () => listSessions(app.getPath('userData'), { limit: 50, locale: uiLocale() }));
  handle('session:read', (id) => readSession(app.getPath('userData'), id, uiLocale()));
  handle('session:delete', (id) => {
    const result = deleteSession(app.getPath('userData'), id, uiLocale());
    if (result.ok && id === sessionFileId) sessionFileId = null;
    return result;
  });
  // 載入歷史對話繼續討論:之後的任務會寫回同一份紀錄
  handle('chat:resume', (id) => {
    if (orchestrator.snapshot().running) return { ok: false, error: text('main.stillRunning') };
    const result = readSession(userData(), id, uiLocale());
    if (!result.ok) return result;
    activeTaskStart = null;
    resetPending(); // 未送出的附件屬於舊對話的目錄,不能帶過去
    const snapshot = orchestrator.loadConversation(result.session);
    sessionFileId = id;
    return { ok: true, id, snapshot };
  });
  // 只轉交;id 驗證與 first-answer-wins 都在 orchestrator,IPC 層不保留任何狀態
  handle('chat:answer', (answer) => orchestrator.answerQuestion(answer));
  // 工作目錄目前的檔案改動。唯讀:只讀 git 的輸出,不碰使用者的版本控制狀態。
  // collectChanges 全程非同步——在主程序同步跑 git 會凍結整個視窗。
  handle('diff:changes', () => collectChanges(store.get().settings.workDir));
  // 一鍵連接本機 Ollama。只轉交給 registry,IPC 層不保留任何狀態。
  // 偵測、模型清單、設定寫入全在 adapter 層,介面因此不必碰 baseUrl / API key / JSON。
  handle('ollama:quickSetup', async (payload) => {
    try {
      return await registry.quickSetupOllama(payload?.model ? { model: payload.model } : {});
    } catch (error: any) {
      // registry 對「找不到範本」「選了不存在的模型」等情況是丟例外的;
      // 介面需要的是一個能顯示的結果,不是一個 rejected promise
      return { ok: false, baseUrl: '', models: [], recommendedModel: null, installed: false, error: error?.message || String(error) };
    }
  });
  handle('chat:stop', () => orchestrator.stop());
  handle('chat:reset', () => orchestrator.reset());

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { stopOrchestrator(); app.quit(); });
app.on('before-quit', stopOrchestrator);
