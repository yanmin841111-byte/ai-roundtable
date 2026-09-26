import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { EventChannel, InvokeChannel, IpcArgs, IpcEvents, IpcReturn, RendererApi } from './src/ipc-types';

function invoke<C extends InvokeChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcReturn<C>> {
  return ipcRenderer.invoke(channel, ...args);
}

function on<C extends EventChannel>(channel: C, fn: (payload: IpcEvents[C]) => void) {
  ipcRenderer.on(channel, (_e, payload: IpcEvents[C]) => fn(payload));
}

// 介面一次只看一件任務;對話操作都帶上它的 id,其他任務的事件不進畫面
let currentJob: string | null = null;
const jobId = async () => currentJob || (currentJob = (await invoke('jobs:list')).selectedId);

const api: RendererApi = {
  getConfig: () => invoke('config:get'),
  saveConfig: (cfg) => invoke('config:save', cfg),
  cliTypes: () => invoke('cli:types'),
  checkCli: (opts) => invoke('cli:check', opts),
  cliInstall: {
    plan: (cliId) => invoke('cli:installPlan', cliId),
    run: (cliId, tool) => invoke('cli:install', { cliId, tool }),
    cancel: () => invoke('cli:installCancel'),
    onOutput: (fn) => on('cli:installOutput', fn),
  },
  pickDir: () => invoke('dialog:pickDir'),
  pickExecutable: () => invoke('dialog:pickExecutable'),
  openPath: (p) => invoke('shell:openPath', p),
  jobs: {
    list: async () => { const state = await invoke('jobs:list'); currentJob = currentJob || state.selectedId; return state; },
    create: async () => { const result = await invoke('jobs:create'); currentJob = result.state.selectedId; return result; },
    select: async (id) => {
      const previous = currentJob;
      currentJob = id;
      try { return await invoke('jobs:select', id); }
      catch (error) { if (currentJob === id) currentJob = previous; throw error; }
    },
    close: async (id) => {
      const state = await invoke('jobs:close', id);
      if (!state.jobs.some((job) => job.id === currentJob)) currentJob = state.selectedId;
      return state;
    },
    current: () => currentJob,
    onChange: (fn) => on('jobs:changed', fn),
  },
  snapshot: async () => invoke('chat:snapshot', await jobId()),
  send: async (text, mode, attachments) => invoke('chat:send', await jobId(), { text, mode, attachments }),
  exportChat: async () => invoke('chat:export', await jobId()),
  openSessions: () => invoke('chat:openSessions'),
  stop: async () => invoke('chat:stop', await jobId()),
  answerQuestion: async (answer) => invoke('chat:answer', await jobId(), answer),
  retry: async (messageId) => invoke('chat:retry', await jobId(), messageId),
  getDiff: async () => invoke('diff:changes', await jobId()),
  revertTask: async (scope?: 'task' | 'repair') => invoke('task:revert', await jobId(), scope),
  taskVerification: async (messageId) => invoke('task:verification', await jobId(), messageId),
  reverifyTask: async (messageId, confirmedCommand) => invoke('task:reverify', await jobId(), messageId, confirmedCommand),
  quickSetupOllama: (model) => invoke('ollama:quickSetup', model ? { model } : {}),
  modelCapability: (payload) => invoke('model:capability', payload),
  reset: async () => invoke('chat:reset', await jobId()),
  resume: async (sessionId) => invoke('chat:resume', await jobId(), sessionId),
  // 附件:主程序負責驗證、落地與上限,renderer 只拿 metadata 與縮圖 data URL
  attachments: {
    list: async () => invoke('attachments:list', await jobId()),
    pick: async () => invoke('attachments:pick', await jobId()),
    // items: [{ name, path }](拖放)或 [{ name, data: ArrayBuffer }]
    add: async (items) => invoke('attachments:add', await jobId(), { items }),
    // Electron 32 起 File.path 已移除:拖放時用這個取本機路徑,
    // 就不必把整個檔案讀成 ArrayBuffer 再走一次 IPC
    pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
    remove: async (id) => invoke('attachments:remove', await jobId(), { id }),
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
  // 終端分頁:只是轉交。這一層不保留 id 與狀態,分頁真正的生死在主程序。
  terminal: {
    create: (payload) => invoke('terminal:create', payload || {}),
    write: (id, data) => invoke('terminal:write', { id, data }),
    resize: (id, cols, rows) => invoke('terminal:resize', { id, cols, rows }),
    close: (id) => invoke('terminal:close', { id }),
    list: () => invoke('terminal:list'),
    onData: (fn) => on('terminal:data', fn),
    onExit: (fn) => on('terminal:exit', fn),
  },
  onMessage: (fn) => on('chat:message', (p) => { if (p.jobId === currentJob) fn(p.message); }),
  onState: (fn) => on('chat:state', (p) => { if (p.jobId === currentJob) fn(p.state); }),
  onReset: (fn) => on('chat:reset', (p) => { if (p.jobId === currentJob) fn(); }),
  onSessionSaved: (fn) => on('session:saved', (p) => { if (p.jobId === currentJob) fn({ id: p.id }); }),
};

contextBridge.exposeInMainWorld('api', api);
