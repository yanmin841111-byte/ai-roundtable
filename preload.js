const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  cliTypes: () => ipcRenderer.invoke('cli:types'),
  checkCli: () => ipcRenderer.invoke('cli:check'),
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  snapshot: () => ipcRenderer.invoke('chat:snapshot'),
  send: (text, mode) => ipcRenderer.invoke('chat:send', { text, mode }),
  stop: () => ipcRenderer.invoke('chat:stop'),
  reset: () => ipcRenderer.invoke('chat:reset'),
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
});
