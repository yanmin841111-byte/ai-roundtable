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
  onMessage: (fn) => ipcRenderer.on('chat:message', (_e, m) => fn(m)),
  onState: (fn) => ipcRenderer.on('chat:state', (_e, s) => fn(s)),
  onReset: (fn) => ipcRenderer.on('chat:reset', () => fn()),
});
