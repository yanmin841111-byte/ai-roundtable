import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg: any) => ipcRenderer.invoke('config:save', cfg),
  cliTypes: () => ipcRenderer.invoke('cli:types'),
  checkCli: () => ipcRenderer.invoke('cli:check'),
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  pickExecutable: () => ipcRenderer.invoke('dialog:pickExecutable'),
  openPath: (p: any) => ipcRenderer.invoke('shell:openPath', p),
  snapshot: () => ipcRenderer.invoke('chat:snapshot'),
  send: (text: any, mode: any, attachments: any) => ipcRenderer.invoke('chat:send', { text, mode, attachments }),
  exportChat: () => ipcRenderer.invoke('chat:export'),
  openSessions: () => ipcRenderer.invoke('chat:openSessions'),
  stop: () => ipcRenderer.invoke('chat:stop'),
  reset: () => ipcRenderer.invoke('chat:reset'),
  resume: (sessionId: any) => ipcRenderer.invoke('chat:resume', sessionId),
  // 附件:主程序負責驗證、落地與上限,renderer 只拿 metadata 與縮圖 data URL
  attachments: {
    list: () => ipcRenderer.invoke('attachments:list'),
    pick: () => ipcRenderer.invoke('attachments:pick'),
    // items: [{ name, path }](拖放)或 [{ name, data: ArrayBuffer }]
    add: (items: any) => ipcRenderer.invoke('attachments:add', { items }),
    // Electron 32 起 File.path 已移除:拖放時用這個取本機路徑,
    // 就不必把整個檔案讀成 ArrayBuffer 再走一次 IPC
    pathForFile: (file: any) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
    remove: (id: any) => ipcRenderer.invoke('attachments:remove', { id }),
    thumb: (meta: any) => ipcRenderer.invoke('attachments:thumb', meta),
  },
  sessions: {
    list: () => ipcRenderer.invoke('session:list'),
    read: (id: any) => ipcRenderer.invoke('session:read', id),
    remove: (id: any) => ipcRenderer.invoke('session:delete', id),
  },
  secrets: {
    set: (ref: any, value: any) => ipcRenderer.invoke('secrets:set', { ref, value }),
    status: (ref: any, envName: any) => ipcRenderer.invoke('secrets:status', { ref, envName }),
    clear: (ref: any) => ipcRenderer.invoke('secrets:clear', { ref }),
    test: (adapterId: any) => ipcRenderer.invoke('secrets:test', { adapterId }),
  },
  ext: {
    list: () => ipcRenderer.invoke('ext:list'),
    reload: () => ipcRenderer.invoke('ext:reload'),
    install: (templateFile: any) => ipcRenderer.invoke('ext:install', templateFile),
    read: (file: any) => ipcRenderer.invoke('ext:read', file),
    write: (file: any, content: any, originalFile: any) => ipcRenderer.invoke('ext:write', { file, content, originalFile }),
    remove: (file: any) => ipcRenderer.invoke('ext:delete', file),
    openDir: () => ipcRenderer.invoke('ext:openDir'),
    openDocs: () => ipcRenderer.invoke('ext:openDocs'),
  },
  onMessage: (fn: any) => ipcRenderer.on('chat:message', (_e: any, m: any) => fn(m)),
  onState: (fn: any) => ipcRenderer.on('chat:state', (_e: any, s: any) => fn(s)),
  onReset: (fn: any) => ipcRenderer.on('chat:reset', () => fn()),
  onSessionSaved: (fn: any) => ipcRenderer.on('session:saved', (_e: any, info: any) => fn(info)),
});
