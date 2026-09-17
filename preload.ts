import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { EventChannel, InvokeChannel, IpcArgs, IpcEvents, IpcReturn, RendererApi } from './src/ipc-types';

function invoke<C extends InvokeChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcReturn<C>> {
  return ipcRenderer.invoke(channel, ...args);
}

function on<C extends EventChannel>(channel: C, fn: (payload: IpcEvents[C]) => void) {
  ipcRenderer.on(channel, (_e, payload: IpcEvents[C]) => fn(payload));
}

const api: RendererApi = {
  getConfig: () => invoke('config:get'),
  saveConfig: (cfg) => invoke('config:save', cfg),
  cliTypes: () => invoke('cli:types'),
  checkCli: () => invoke('cli:check'),
  pickDir: () => invoke('dialog:pickDir'),
  pickExecutable: () => invoke('dialog:pickExecutable'),
  openPath: (p) => invoke('shell:openPath', p),
  snapshot: () => invoke('chat:snapshot'),
  send: (text, mode, attachments) => invoke('chat:send', { text, mode, attachments }),
  exportChat: () => invoke('chat:export'),
  openSessions: () => invoke('chat:openSessions'),
  stop: () => invoke('chat:stop'),
  reset: () => invoke('chat:reset'),
  resume: (sessionId) => invoke('chat:resume', sessionId),
  // 附件:主程序負責驗證、落地與上限,renderer 只拿 metadata 與縮圖 data URL
  attachments: {
    list: () => invoke('attachments:list'),
    pick: () => invoke('attachments:pick'),
    // items: [{ name, path }](拖放)或 [{ name, data: ArrayBuffer }]
    add: (items) => invoke('attachments:add', { items }),
    // Electron 32 起 File.path 已移除:拖放時用這個取本機路徑,
    // 就不必把整個檔案讀成 ArrayBuffer 再走一次 IPC
    pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
    remove: (id) => invoke('attachments:remove', { id }),
    thumb: (meta) => invoke('attachments:thumb', meta),
  },
  sessions: {
    list: () => invoke('session:list'),
    read: (id) => invoke('session:read', id),
    remove: (id) => invoke('session:delete', id),
  },
  secrets: {
    set: (ref, value) => invoke('secrets:set', { ref, value }),
    status: (ref, envName) => invoke('secrets:status', { ref, envName }),
    clear: (ref) => invoke('secrets:clear', { ref }),
    test: (adapterId) => invoke('secrets:test', { adapterId }),
  },
  ext: {
    list: () => invoke('ext:list'),
    reload: () => invoke('ext:reload'),
    install: (templateFile) => invoke('ext:install', templateFile),
    read: (file) => invoke('ext:read', file),
    write: (file, content, originalFile) => invoke('ext:write', { file, content, originalFile }),
    remove: (file) => invoke('ext:delete', file),
    openDir: () => invoke('ext:openDir'),
    openDocs: () => invoke('ext:openDocs'),
  },
  onMessage: (fn) => on('chat:message', fn),
  onState: (fn) => on('chat:state', fn),
  onReset: (fn) => on('chat:reset', () => fn()),
  onSessionSaved: (fn) => on('session:saved', fn),
};

contextBridge.exposeInMainWorld('api', api);
