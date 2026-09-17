'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { Store } = require('./src/store');
const { Orchestrator } = require('./src/orchestrator');
const { CLI_TYPES, checkCli } = require('./src/adapters');

// 從 Finder / Dock 啟動時 PATH 很精簡,補上登入 shell 的 PATH 才找得到 claude / codex。
function fixPath() {
  const extra = [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.npm-global/bin')];
  try {
    const shellPath = execSync(`${process.env.SHELL || '/bin/zsh'} -ilc 'echo -n "$PATH"'`, { encoding: 'utf8', timeout: 5000 });
    if (shellPath) extra.unshift(...shellPath.split(':'));
  } catch {}
  const seen = new Set();
  process.env.PATH = [...extra, ...(process.env.PATH || '').split(':')].filter((p) => p && !seen.has(p) && seen.add(p)).join(':');
}

let win;
let store;
let orchestrator;

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'AI Roundtable',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1117',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer/index.html'));
  if (process.env.AI_ROUNDTABLE_SHOT) win.webContents.once('did-finish-load', () => setTimeout(async () => {
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
  fixPath();
  store = new Store(app.getPath('userData'));
  orchestrator = new Orchestrator(store);
  orchestrator.on('message', (m) => send('chat:message', m));
  orchestrator.on('state', (s) => send('chat:state', s));
  orchestrator.on('reset', () => send('chat:reset'));

  ipcMain.handle('config:get', () => store.get());
  ipcMain.handle('config:save', (_e, cfg) => store.save(cfg));
  ipcMain.handle('cli:types', () => CLI_TYPES);
  ipcMain.handle('cli:check', async () => {
    const out = {};
    for (const [key, t] of Object.entries(CLI_TYPES)) if (t.bin) out[key] = await checkCli(t.bin);
    return out;
  });
  ipcMain.handle('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
  ipcMain.handle('chat:snapshot', () => orchestrator.snapshot());
  ipcMain.handle('chat:send', (_e, { text, mode }) => orchestrator.userMessage(text, mode));
  ipcMain.handle('chat:stop', () => orchestrator.stop());
  ipcMain.handle('chat:reset', () => orchestrator.reset());

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { stopOrchestrator(); app.quit(); });
app.on('before-quit', stopOrchestrator);
