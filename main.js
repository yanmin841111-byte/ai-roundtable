'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { Store } = require('./src/store');
const { Orchestrator } = require('./src/orchestrator');
const { Registry, setRegistry } = require('./src/adapters');
const { writeSession, messagesToMarkdown, listSessions, readSession, deleteSession, listConversationIds } = require('./src/session-log');
const attachments = require('./src/attachments');
const { SecretStore } = require('./src/secrets');

// 從 Finder / Dock 啟動時環境變數很精簡:補上登入 shell 的 PATH 才找得到 claude / codex,
// 也補上 shell 設定檔裡的其他變數(例如 DEEPSEEK_API_KEY),但不覆蓋已經存在的值。
function importShellEnv() {
  const extra = [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.npm-global/bin')];
  const marker = '__AI_ROUNDTABLE_ENV__';
  try {
    const out = execSync(`${process.env.SHELL || '/bin/zsh'} -ilc 'echo ${marker}; env'`, { encoding: 'utf8', timeout: 5000 });
    const lines = out.slice(out.indexOf(marker) + marker.length).split('\n');
    let key = null;
    const shellEnv = {};
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
  process.env.PATH = [...extra, ...(process.env.PATH || '').split(':')].filter((p) => p && !seen.has(p) && seen.add(p)).join(':');
}

let win;
let store;
let orchestrator;
let registry;
let secrets;
let activeTaskStart = null;
let wasRunning = false;
// 已經落地、但還沒隨訊息送出的附件(對應介面上的 chip)。
// 上限由這裡把關,不信任 renderer 傳來的數字。
let pending = [];

const userData = () => app.getPath('userData');
const pendingBytes = () => pending.reduce((n, a) => n + (a.size || 0), 0);

function dropPending(list) {
  for (const meta of list) attachments.removeAttachment(userData(), meta);
}

function resetPending() {
  dropPending(pending);
  pending = [];
}

function persistTask(start) {
  // runTask 的 rejection handler 可能會在 idle 事件後補上一則錯誤訊息。
  setImmediate(() => {
    const snap = orchestrator.snapshot();
    const messages = snap.messages.slice(start);
    // conversationId 要寫進紀錄,刪這份對話時才知道要清哪個附件目錄
    if (messages.length) writeSession(userData(), messages, { conversationId: snap.conversationId });
  });
}

function createWindow() {
  win = new BrowserWindow({
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
  if (process.env.AI_ROUNDTABLE_SHOT) win.webContents.once('did-finish-load', () => setTimeout(async () => {
    if (process.env.AI_ROUNDTABLE_SHOT_JS) console.log('js:', await win.webContents.executeJavaScript(process.env.AI_ROUNDTABLE_SHOT_JS));
    await new Promise((r) => setTimeout(r, 500));
    const img = await win.webContents.capturePage();
    require('fs').writeFileSync(process.env.AI_ROUNDTABLE_SHOT, img.toPNG());
    console.log('screenshot saved');
  }, 2500));
  if (process.env.AI_ROUNDTABLE_DEBUG) win.webContents.on('console-message', (_e, level, msg, line, src) => console.log(`[renderer:${level}] ${msg} (${path.basename(src || '')}:${line})`));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
function stopOrchestrator() { if (orchestrator) orchestrator.stop(); }

app.whenReady().then(async () => {
  importShellEnv();
  store = new Store(app.getPath('userData'));
  secrets = new SecretStore(app.getPath('userData'), safeStorage);
  // 擴充資料夾可用 AI_ROUNDTABLE_ADAPTERS_DIR 覆寫(方便開發外掛)
  registry = new Registry({
    userDir: process.env.AI_ROUNDTABLE_ADAPTERS_DIR || path.join(app.getPath('userData'), 'adapters'),
    templatesDir: path.join(__dirname, 'adapters', 'templates'),
    getSecret: (ref) => secrets.get(ref),
    setSecret: (ref, value) => secrets.set(ref, value),
  });
  setRegistry(registry);
  // 先在背景讀模型清單(例如 cursor-agent --list-models),介面第一次要清單時就不用等
  for (const a of registry.list()) if (a.refreshModels) Promise.resolve().then(() => a.refreshModels()).catch(() => {});
  orchestrator = new Orchestrator(store);
  orchestrator.on('message', (m) => send('chat:message', m));
  orchestrator.on('state', (s) => {
    send('chat:state', s);
    if (wasRunning && !s.running && activeTaskStart != null) {
      const start = activeTaskStart;
      activeTaskStart = null;
      persistTask(start);
    }
    wasRunning = !!s.running;
  });
  orchestrator.on('reset', () => { activeTaskStart = null; resetPending(); send('chat:reset'); });

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

  ipcMain.handle('config:get', () => store.get());
  ipcMain.handle('config:save', (_e, cfg) => store.save(cfg));
  ipcMain.handle('cli:types', () => registry.catalog());
  ipcMain.handle('cli:check', () => registry.checkAll());

  // CLI 擴充管理
  ipcMain.handle('ext:list', () => registry.summary());
  ipcMain.handle('ext:reload', () => registry.reload());
  ipcMain.handle('ext:install', (_e, templateFile) => registry.installTemplate(templateFile));
  ipcMain.handle('ext:read', (_e, file) => {
    let migration = '';
    let migrationError = '';
    if (file.endsWith('.json')) {
      const r = registry.migrateLegacyApiKey(file);
      if (r.error) migrationError = r.error;
      else if (r.migrated) { migration = '已將舊版明文 API key 移至系統安全儲存。'; registry.reload(); }
    }
    return { content: registry.readFile(file), migration, migrationError };
  });
  ipcMain.handle('ext:write', (_e, { file, content, originalFile }) => registry.writeFile(file, content, { originalFile }));
  ipcMain.handle('ext:delete', (_e, file) => registry.deleteFile(file));
  ipcMain.handle('ext:openDir', () => shell.openPath(registry.userDir));
  ipcMain.handle('ext:openDocs', () => shell.openExternal('https://github.com/yanmin841111-byte/ai-roundtable/blob/main/docs/adapters.md'));
  ipcMain.handle('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:pickExecutable', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('secrets:set', (_e, { ref, value }) => secrets.set(ref, value));
  ipcMain.handle('secrets:status', (_e, { ref, envName }) => secrets.status(ref, envName));
  ipcMain.handle('secrets:clear', (_e, { ref }) => secrets.clear(ref));
  ipcMain.handle('secrets:test', async (_e, { adapterId }) => {
    registry.reload();
    const adapter = registry.get(adapterId);
    if (!adapter) return { ok: false, error: '找不到此 API 擴充，請先儲存設定' };
    if (typeof adapter.testConnection !== 'function') return { ok: false, error: '此擴充不支援 API 連線測試' };
    return adapter.testConnection();
  });
  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
  ipcMain.handle('chat:snapshot', () => orchestrator.snapshot());
  // ---------- 附件 ----------
  // 權威儲存在 userData/attachments/<conversationId>/,不寫進使用者的工作目錄。
  const addFiles = (items) => {
    const result = attachments.addAttachments(userData(), orchestrator.conversationId, items, {
      existingCount: pending.length,
      existingBytes: pendingBytes(),
    });
    pending = [...pending, ...result.added];
    // added = 這批新加的;attachments = 目前完整的 pending 清單。兩個都給,renderer 不必猜。
    return { added: result.added, attachments: pending, errors: result.errors, limits: attachments.LIMITS };
  };

  ipcMain.handle('attachments:list', () => ({ attachments: pending, limits: attachments.LIMITS }));
  ipcMain.handle('attachments:add', (_e, { items } = {}) => addFiles(Array.isArray(items) ? items : []));
  ipcMain.handle('attachments:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '可用附件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'txt', 'md', 'json', 'csv', 'log'] },
      ],
    });
    if (r.canceled || !r.filePaths.length) return { attachments: pending, errors: [], canceled: true, limits: attachments.LIMITS };
    return addFiles(r.filePaths.map((file) => ({ name: path.basename(file), path: file })));
  });
  ipcMain.handle('attachments:remove', (_e, { id } = {}) => {
    const meta = pending.find((a) => a.id === id);
    if (meta) {
      attachments.removeAttachment(userData(), meta);
      pending = pending.filter((a) => a.id !== id);
    }
    return { attachments: pending };
  });
  // 縮圖走 data URL(CSP 維持 img-src 'self' data:,不放寬成 file:)
  ipcMain.handle('attachments:thumb', (_e, meta) => attachments.thumbDataUrl(userData(), meta));

  ipcMain.handle('chat:send', async (_e, { text, mode, attachments: wanted }) => {
    const snap = orchestrator.snapshot();
    if (!snap.running) activeTaskStart = snap.messages.length;
    // renderer 決定「這次要送哪些 chip」,main 仍是唯一驗證與儲存的一方
    let sending = pending;
    if (Array.isArray(wanted)) {
      const keep = new Set(wanted.map((a) => (a && a.id) || a));
      sending = pending.filter((a) => keep.has(a.id));
      dropPending(pending.filter((a) => !keep.has(a.id)));
    }
    const message = await orchestrator.userMessage(text, mode, sending);
    // 成功交給 orchestrator 之後才清 pending:中途丟例外時 renderer 會復原 chip,
    // 後端若先清空就會變成「畫面上還有附件,送出卻是空的」
    pending = [];
    // 沒有可用成員、工作目錄無法建立等前置失敗不會進入 running 狀態。
    if (!orchestrator.snapshot().running && activeTaskStart != null) {
      const start = activeTaskStart;
      activeTaskStart = null;
      persistTask(start);
    }
    return message;
  });
  ipcMain.handle('chat:export', async () => {
    const messages = orchestrator.snapshot().messages;
    if (!messages.length) return { ok: false, error: '目前沒有可匯出的對話' };
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const result = await dialog.showSaveDialog(win, {
      title: '匯出本次對話',
      defaultPath: `ai-roundtable-${stamp}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      await require('fs').promises.writeFile(result.filePath, messagesToMarkdown(messages), 'utf8');
      return { ok: true, file: result.filePath };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('chat:openSessions', () => {
    const dir = path.join(app.getPath('userData'), 'sessions');
    require('fs').mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });
  ipcMain.handle('session:list', () => listSessions(app.getPath('userData'), { limit: 50 }));
  ipcMain.handle('session:read', (_e, id) => readSession(app.getPath('userData'), id));
  ipcMain.handle('session:delete', (_e, id) => deleteSession(app.getPath('userData'), id));
  ipcMain.handle('chat:stop', () => orchestrator.stop());
  ipcMain.handle('chat:reset', () => orchestrator.reset());

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { stopOrchestrator(); app.quit(); });
app.on('before-quit', stopOrchestrator);
