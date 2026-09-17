'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { Store } = require('./src/store');
const { Orchestrator } = require('./src/orchestrator');
const { Registry, setRegistry } = require('./src/adapters');
const { writeSession, messagesToMarkdown, listSessions, readSession, deleteSession } = require('./src/session-log');

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
let activeTaskStart = null;
let wasRunning = false;

function persistTask(start) {
  // runTask 的 rejection handler 可能會在 idle 事件後補上一則錯誤訊息。
  setImmediate(() => {
    const messages = orchestrator.snapshot().messages.slice(start);
    if (messages.length) writeSession(app.getPath('userData'), messages);
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
  // 擴充資料夾可用 AI_ROUNDTABLE_ADAPTERS_DIR 覆寫(方便開發外掛)
  registry = new Registry({
    userDir: process.env.AI_ROUNDTABLE_ADAPTERS_DIR || path.join(app.getPath('userData'), 'adapters'),
    templatesDir: path.join(__dirname, 'adapters', 'templates'),
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
  orchestrator.on('reset', () => { activeTaskStart = null; send('chat:reset'); });

  ipcMain.handle('config:get', () => store.get());
  ipcMain.handle('config:save', (_e, cfg) => store.save(cfg));
  ipcMain.handle('cli:types', () => registry.catalog());
  ipcMain.handle('cli:check', () => registry.checkAll());

  // CLI 擴充管理
  ipcMain.handle('ext:list', () => registry.summary());
  ipcMain.handle('ext:reload', () => registry.reload());
  ipcMain.handle('ext:install', (_e, templateFile) => registry.installTemplate(templateFile));
  ipcMain.handle('ext:read', (_e, file) => registry.readFile(file));
  ipcMain.handle('ext:write', (_e, { file, content, originalFile }) => registry.writeFile(file, content, { originalFile }));
  ipcMain.handle('ext:delete', (_e, file) => registry.deleteFile(file));
  ipcMain.handle('ext:openDir', () => shell.openPath(registry.userDir));
  ipcMain.handle('ext:openDocs', () => shell.openExternal('https://github.com/yanmin841111-byte/ai-roundtable/blob/main/docs/adapters.md'));
  ipcMain.handle('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
  ipcMain.handle('chat:snapshot', () => orchestrator.snapshot());
  ipcMain.handle('chat:send', async (_e, { text, mode }) => {
    const snap = orchestrator.snapshot();
    if (!snap.running) activeTaskStart = snap.messages.length;
    const message = await orchestrator.userMessage(text, mode);
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
