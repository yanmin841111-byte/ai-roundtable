const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  cliTypes: () => ipcRenderer.invoke('cli:types'),
  checkCli: () => ipcRenderer.invoke('cli:check'),
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  pickExecutable: () => ipcRenderer.invoke('dialog:pickExecutable'),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  snapshot: () => ipcRenderer.invoke('chat:snapshot'),
  send: (text, mode, attachments) => ipcRenderer.invoke('chat:send', { text, mode, attachments }),
  exportChat: () => ipcRenderer.invoke('chat:export'),
  openSessions: () => ipcRenderer.invoke('chat:openSessions'),
  stop: () => ipcRenderer.invoke('chat:stop'),
  reset: () => ipcRenderer.invoke('chat:reset'),
  resume: (sessionId) => ipcRenderer.invoke('chat:resume', sessionId),
  // 附件:主程序負責驗證、落地與上限,renderer 只拿 metadata 與縮圖 data URL
  attachments: {
    list: () => ipcRenderer.invoke('attachments:list'),
    pick: () => ipcRenderer.invoke('attachments:pick'),
    // items: [{ name, path }](拖放)或 [{ name, data: ArrayBuffer }]
    add: (items) => ipcRenderer.invoke('attachments:add', { items }),
    // Electron 32 起 File.path 已移除:拖放時用這個取本機路徑,
    // 就不必把整個檔案讀成 ArrayBuffer 再走一次 IPC
    pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
    remove: (id) => ipcRenderer.invoke('attachments:remove', { id }),
    thumb: (meta) => ipcRenderer.invoke('attachments:thumb', meta),
  },
  sessions: {
    list: () => ipcRenderer.invoke('session:list'),
    read: (id) => ipcRenderer.invoke('session:read', id),
    remove: (id) => ipcRenderer.invoke('session:delete', id),
  },
  secrets: {
    set: (ref, value) => ipcRenderer.invoke('secrets:set', { ref, value }),
    status: (ref, envName) => ipcRenderer.invoke('secrets:status', { ref, envName }),
    clear: (ref) => ipcRenderer.invoke('secrets:clear', { ref }),
    test: (adapterId) => ipcRenderer.invoke('secrets:test', { adapterId }),
  },
  ext: {
    list: () => ipcRenderer.invoke('ext:list'),
    reload: () => ipcRenderer.invoke('ext:reload'),
    install: (templateFile) => ipcRenderer.invoke('ext:install', templateFile),
    read: (file) => ipcRenderer.invoke('ext:read', file),
    write: (file, content, originalFile) => ipcRenderer.invoke('ext:write', { file, content, originalFile }),
    remove: (file) => ipcRenderer.invoke('ext:delete', file),
    openDir: () => ipcRenderer.invoke('ext:openDir'),
    openDocs: () => ipcRenderer.invoke('ext:openDocs'),
  },
  onMessage: (fn) => ipcRenderer.on('chat:message', (_e, m) => fn(m)),
  onState: (fn) => ipcRenderer.on('chat:state', (_e, s) => fn(s)),
  onReset: (fn) => ipcRenderer.on('chat:reset', () => fn()),
  onSessionSaved: (fn) => ipcRenderer.on('session:saved', (_e, info) => fn(info)),
});
