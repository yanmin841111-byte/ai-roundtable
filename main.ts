import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, net } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { Store } from './src/store';
import { Orchestrator } from './src/orchestrator';
import { Registry, setRegistry, getAdapter } from './src/adapters';
import { writeSession, messagesToMarkdown, listSessions, readSession, deleteSession, listConversationIds } from './src/session-log';
import * as attachments from './src/attachments';
import { SecretStore } from './src/secrets';
import type { AgentConfig, AppConfig, AttachmentInput, AttachmentMeta, ChatSnapshot, EventChannel, InvokeChannel, IpcArgs, IpcEvents, IpcReturn, JobBlocker, JobStatus, JobSummary, JobsState, RevertOutcome } from './src/ipc-types';
import { tx, resolveTextLocale, setSystemLocale } from './src/text';
import { CapabilityStore, setCapabilityStore } from './src/capabilities';
import { workdirChanges } from './src/task-changes';
import { TerminalManager, MAX_SESSIONS as TERMINAL_MAX } from './src/terminal';
import { findMentions } from './src/shared';
import { JobScheduler, RunLedger, localEndpointKey, workdirKey } from './src/jobs';
import { cancelInstall, installPlan, runInstall } from './src/cli-install';
import type { JobResources } from './src/jobs';

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
let registry: Registry;
let secrets: SecretStore;
let terminals: TerminalManager;

// 一件任務 = 一段獨立的對話:自己的 Orchestrator(成員 session、執行程序、提問、基準點)、附件與紀錄檔。
interface Job {
  id: string;
  orchestrator: Orchestrator;
  // 第一次送出時凍結;之後每次開跑前重讀設定,但工作目錄不變。null 表示還沒送出過,照設定走
  config: AppConfig | null;
  createdAt: number;
  // 已經落地、但還沒隨訊息送出的附件(對應介面上的 chip)。上限由這裡把關,不信任 renderer 傳來的數字。
  pending: AttachmentMeta[];
  // 這段對話寫入的紀錄檔;同一段對話每次任務結束都覆寫這一份
  sessionFileId: string | null;
  activeTaskStart: number | null;
  queued: { text: string; mode: string; attachments: AttachmentMeta[]; previousConfig: AppConfig | null } | null;
  resources: JobResources | null;
  staleBaseline: Orchestrator['taskBaseline'];
  outcome: 'done' | 'stopped' | 'error' | null;
  unread: boolean;
  // 還原 / 重新驗證佔著目錄時為 true:這時候的閒置事件不是「任務跑完了」
  maintenance: boolean;
}

const jobs = new Map<string, Job>();
let selectedJobId = '';
const ledger = new RunLedger();
const scheduler = new JobScheduler(() => maxParallel(), (id) => startJob(id));

const userData = () => app.getPath('userData');
// 主程序產生的少數使用者可見文字跟著介面語言
const uiLocale = () => resolveTextLocale(store.get().settings.uiLocale);
const text = (key: string, params: Record<string, string | number> = {}) => tx(uiLocale(), key, params);
// 對話框附在主視窗上;視窗還沒建立(或已關閉)時退回無父視窗的版本
const showOpenDialog = (options: Electron.OpenDialogOptions) =>
  mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options);
const showSaveDialog = (options: Electron.SaveDialogOptions) =>
  mainWindow ? dialog.showSaveDialog(mainWindow, options) : dialog.showSaveDialog(options);
const pendingBytes = (job: Job) => job.pending.reduce((n, a) => n + (a.size || 0), 0);

// 依 src/ipc-types.ts 的契約註冊 handler:參數與回傳值都要符合 renderer 看到的型別。
function handle<C extends InvokeChannel>(channel: C, fn: (...args: IpcArgs<C>) => IpcReturn<C> | Promise<IpcReturn<C>>) {
  ipcMain.handle(channel, (_e, ...args) => fn(...(args as IpcArgs<C>)));
}

function dropPending(list: AttachmentMeta[]) {
  for (const meta of list) attachments.removeAttachment(userData(), meta);
}

function resetPending(job: Job) {
  dropPending(job.pending);
  job.pending = [];
}

function persistTask(job: Job) {
  const snap = job.orchestrator.snapshot();
  if (!snap.messages.length) return;
  const result = writeSession(userData(), snap.messages, { conversationId: snap.conversationId, id: job.sessionFileId });
  if (result.ok) job.sessionFileId = result.id;
  send('session:saved', { jobId: job.id, id: job.sessionFileId });
}

// ---------- 多件任務 ----------
const maxParallel = () => Math.min(6, Math.max(1, Math.round(Number(store?.get().settings.maxParallelJobs) || 2)));
const jobConfig = (job: Job) => job.config || store.get();
const jobWorkDir = (job: Job) => jobConfig(job).settings.workDir;
const busy = (job: Job) => !!job.queued || scheduler.isHeld(job.id) || job.orchestrator.running;
const blockedText = (blocker: JobBlocker | 'busy') => text(`main.jobBlocked.${blocker}`);

function jobOf(jobId: string): Job {
  const job = jobs.get(jobId);
  if (!job) throw new Error(text('main.jobMissing'));
  return job;
}

function createJob(): Job {
  const job: Job = {
    id: crypto.randomUUID(), orchestrator: null as unknown as Orchestrator, config: null, createdAt: Date.now(),
    pending: [], sessionFileId: null, activeTaskStart: null, queued: null, resources: null, staleBaseline: null, outcome: null,
    unread: false, maintenance: false,
  };
  const orchestrator = new Orchestrator({ get: () => jobConfig(job), userDataDir: store.userDataDir });
  job.orchestrator = orchestrator;
  orchestrator.on('message', (message: IpcEvents['chat:message']['message']) => {
    send('chat:message', { jobId: job.id, message });
    if (job.id !== selectedJobId && !job.unread) { job.unread = true; emitJobs(); }
  });
  orchestrator.on('state', (state: IpcEvents['chat:state']['state']) => {
    send('chat:state', { jobId: job.id, state });
    if (!state.running && scheduler.isHeld(job.id) && !job.maintenance) finishRun(job);
    else emitJobs();
  });
  orchestrator.on('reset', () => {
    job.activeTaskStart = null;
    job.sessionFileId = null;
    job.outcome = null;
    resetPending(job);
    send('chat:reset', { jobId: job.id });
    emitJobs();
  });
  jobs.set(job.id, job);
  return job;
}

function jobSummary(job: Job): JobSummary {
  const snap = job.orchestrator.snapshot();
  const first = snap.messages.find((m) => m.kind === 'user')?.text || job.queued?.text || '';
  const status: JobStatus = job.queued ? 'queued' : snap.question ? 'waiting' : snap.running ? 'running' : job.outcome || 'idle';
  return {
    id: job.id,
    title: first.trim().split('\n')[0].slice(0, 80),
    status,
    workDir: job.config ? job.config.settings.workDir : null,
    waitingFor: job.queued ? scheduler.blockerOf(job.id) : null,
    phase: snap.phase,
    unread: job.unread,
    createdAt: job.createdAt,
  };
}

const jobsState = (): JobsState => ({ jobs: [...jobs.values()].map(jobSummary), selectedId: selectedJobId, maxParallel: maxParallel() });
const emitJobs = () => send('jobs:changed', jobsState());
const jobSnapshot = (job: Job): ChatSnapshot => ({ ...job.orchestrator.snapshot(), sessionId: job.sessionFileId });

async function jobResources(job: Job, agents: AgentConfig[]): Promise<JobResources> {
  const endpoints = [...new Set(agents.map((a) => localEndpointKey(getAdapter(a.cli)?.endpoint)).filter((key): key is string => !!key))];
  return { dir: await workdirKey(jobWorkDir(job)), endpoints };
}

// 有 @ 指定就只算被指定的成員;否則整張圓桌都會發言
function speakers(job: Job, body: string): AgentConfig[] {
  const enabled = jobConfig(job).agents.filter((a) => a.enabled !== false);
  const mentioned = findMentions(body, enabled);
  return mentioned.length ? mentioned : enabled;
}

function releaseJob(job: Job) {
  scheduler.release(job.id);
  emitJobs();
}

function finishRun(job: Job) {
  if (!scheduler.isHeld(job.id)) return;
  const o = job.orchestrator;
  const recent = o.messages.slice(job.activeTaskStart ?? o.messages.length);
  job.outcome = o.stopped ? 'stopped' : recent.some((m) => m.level === 'error' || (m.kind === 'agent' && m.error)) ? 'error' : 'done';
  if (job.activeTaskStart != null) {
    job.activeTaskStart = null;
    persistTask(job);
  }
  releaseJob(job);
}

function recordRun(job: Job, resources: JobResources) {
  if (ledger.supersededBy(job.id) && job.orchestrator.taskBaseline) job.staleBaseline = job.orchestrator.taskBaseline;
  ledger.record(job.id, resources.dir);
}

// 排程器輪到這件任務時呼叫。userMessage 會同步進入 running,之後由閒置事件收尾。
function startJob(id: string) {
  const job = jobs.get(id);
  if (!job || !job.queued) { setImmediate(() => { if (job) releaseJob(job); else scheduler.release(id); }); return; }
  const { text: body, mode, attachments: list } = job.queued;
  job.queued = null;
  job.outcome = null;
  job.activeTaskStart = job.orchestrator.messages.length;
  if (job.resources) recordRun(job, job.resources);
  job.orchestrator.userMessage(body, mode, list)
    .catch((error: unknown) => {
      job.pending = [...list, ...job.pending];
      job.orchestrator.system(job.orchestrator.text('sys.error', { message: error instanceof Error ? error.message : String(error) }), { level: 'error' });
      job.outcome = 'error';
      persistTask(job);
    })
    .finally(() => {
      // 沒有可用成員、工作目錄無法建立等前置失敗不會進入 running 狀態。
      if (!job.orchestrator.running) finishRun(job);
      else emitJobs();
    });
}

// 還原、重新驗證:使用者當下的操作,不排隊。要先拿到這個目錄,拿不到就照實說原因。
async function withDirectory<T>(job: Job, run: () => Promise<T>, blocked: (blocker: JobBlocker | 'busy') => T): Promise<T> {
  if (busy(job)) return blocked('busy');
  const resources = await jobResources(job, []);
  if (busy(job) || !jobs.has(job.id)) return blocked('busy');
  const blocker = scheduler.tryHold(job.id, resources, false);
  if (blocker) return blocked(blocker);
  job.maintenance = true;
  try { return await run(); } finally { job.maintenance = false; releaseJob(job); }
}

function createWindow() {
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(__dirname, 'renderer/icon.png'));
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
    // 等 stdout 真的寫出去再結束;寫不進去(EPIPE)也照樣收攤,不能讓 app 卡在這裡
    await new Promise<void>((resolve) => {
      process.stdout.write(`E2E_RESULT ${JSON.stringify(result)}\n`, () => resolve());
    });
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
function stopOrchestrator() {
  scheduler.shutdown();
  for (const job of jobs.values()) { job.queued = null; job.orchestrator.stop(); }
}
// app 結束時終端裡的 shell 也要一起收掉,不留在背景跑
function stopTerminals() { if (terminals) terminals.closeAll(); }

app.whenReady().then(async () => {
  importShellEnv();
  setSystemLocale(app.getLocale());
  store = new Store(app.getPath('userData'));
  secrets = new SecretStore(app.getPath('userData'), safeStorage);
  // 模型能力的測試結果要跨次開啟保留:付費 API 的實際測試不該每次開 app 都重做
  setCapabilityStore(new CapabilityStore(path.join(app.getPath('userData'), 'model-capabilities.json')));
  // 擴充資料夾可用 AI_ROUNDTABLE_ADAPTERS_DIR 覆寫(方便開發外掛)
  registry = new Registry({
    // 網路一律走 Electron 自己的 net.fetch,不用 Node 內建的 fetch:
    // Node 的 fetch(undici)有一道寫死的 300 秒「等回應標頭」上限,而且改不了(那個設定要另外裝套件,
    // 這個 app 刻意不帶任何執行期相依)。本機大模型很容易超過:實測 27B + 思考、一萬五千字的提示,
    // 光是等第一個位元組就要 82 秒,前面再排一個請求就爆掉——然後使用者看到的是
    // 「Headers Timeout Error」,而不是自己設定的 20 分鐘逾時。net.fetch 沒有這道上限,
    // 逾時完全由 spec.timeoutMs 與 AbortController 決定,也就是使用者設定的那個值。
    fetchImpl: (input: any, init: any) => net.fetch(input, init),
    userDir: process.env.AI_ROUNDTABLE_ADAPTERS_DIR || path.join(app.getPath('userData'), 'adapters'),
    templatesDir: path.join(__dirname, 'adapters', 'templates'),
    getSecret: (ref: any) => secrets.get(ref),
    setSecret: (ref: any, value: any) => secrets.set(ref, value),
    getLocale: () => resolveTextLocale(store.get().settings.uiLocale),
  });
  setRegistry(registry);
  // 先在背景讀模型清單(例如 cursor-agent --list-models),介面第一次要清單時就不用等
  for (const { refreshModels } of registry.list()) if (refreshModels) Promise.resolve().then(refreshModels).catch(() => {});
  selectedJobId = createJob().id;

  // 終端分頁:使用者自己動手的地方。輸出直接往 renderer 送,主程序不解讀也不記錄。
  terminals = new TerminalManager();
  terminals.on('data', (payload: IpcEvents['terminal:data']) => send('terminal:data', payload));
  terminals.on('exit', (payload: IpcEvents['terminal:exit']) => send('terminal:exit', payload));

  // 啟動清理:
  //   1. 上次被強制關閉時可能在使用者的工作目錄留下 .roundtable-runtime,一定要清掉
  //   2. 從未寫進 session 的暫存對話附件視為孤兒;已存檔的附件不因時間自動刪除
  try {
    attachments.clearRuntime(store.get().settings.workDir);
    attachments.cleanupOrphans(userData(), {
      keepIds: listConversationIds(userData()),
      activeId: jobs.get(selectedJobId)?.orchestrator.conversationId,
    });
  } catch {}

  handle('config:get', () => store.get());
  handle('config:save', (cfg) => {
    const saved = store.save(cfg);
    // 上限調高了,排隊中的任務可能現在就能開始
    scheduler.pump();
    emitJobs();
    return saved;
  });
  handle('cli:types', () => registry.catalog());
  handle('cli:check', (opts) => registry.checkAll(opts || {}));
  handle('cli:installPlan', (cliId) => installPlan(String(cliId)));
  handle('cli:install', async (payload) => {
    const cliId = String(payload?.cliId || '');
    const result = await runInstall(cliId, String(payload?.tool || ''), (line) => send('cli:installOutput', { cliId, line }), uiLocale());
    if (result.ok) result.health = (await registry.checkAll())[cliId];
    return result;
  });
  handle('cli:installCancel', () => cancelInstall());
  handle('model:capability', (payload) => registry.modelCapability(String(payload?.adapterId || ''), String(payload?.model || ''), payload?.live === true));

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
  handle('chat:snapshot', (jobId) => jobSnapshot(jobOf(jobId)));
  handle('jobs:list', () => jobsState());
  // 目前這件還是空的就直接用它,不要留下一串空白任務
  handle('jobs:create', () => {
    const current = jobs.get(selectedJobId);
    const blank = current && !current.orchestrator.messages.length && !busy(current) && !current.pending.length;
    const job = blank ? current : createJob();
    selectedJobId = job.id;
    job.unread = false;
    emitJobs();
    return { state: jobsState(), snapshot: jobSnapshot(job) };
  });
  handle('jobs:select', (jobId) => {
    const job = jobOf(jobId);
    selectedJobId = job.id;
    job.unread = false;
    emitJobs();
    return { state: jobsState(), snapshot: jobSnapshot(job) };
  });
  handle('jobs:close', (jobId) => {
    const job = jobOf(jobId);
    if (jobs.size <= 1 || busy(job)) throw new Error(text('main.jobCloseBusy'));
    resetPending(job);
    job.orchestrator.removeAllListeners();
    job.orchestrator.stop();
    jobs.delete(job.id);
    if (selectedJobId === job.id) selectedJobId = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt)[0].id;
    emitJobs();
    return jobsState();
  });
  // ---------- 附件 ----------
  // 權威儲存在 userData/attachments/<conversationId>/,不寫進使用者的工作目錄。
  const addFiles = (job: Job, items: AttachmentInput[]) => {
    const result = attachments.addAttachments(userData(), job.orchestrator.conversationId, items, {
      existingCount: job.pending.length,
      existingBytes: pendingBytes(job),
      // 拒絕原因會直接顯示在輸入框,跟著介面語言
      locale: uiLocale(),
    });
    job.pending = [...job.pending, ...result.added];
    // added = 這批新加的;attachments = 目前完整的 pending 清單。兩個都給,renderer 不必猜。
    return { added: result.added, attachments: job.pending, errors: result.errors, limits: attachments.LIMITS };
  };

  handle('attachments:list', (jobId) => ({ attachments: jobOf(jobId).pending, limits: attachments.LIMITS }));
  handle('attachments:add', (jobId, payload) => addFiles(jobOf(jobId), Array.isArray(payload?.items) ? payload.items : []));
  handle('attachments:pick', async (jobId) => {
    const job = jobOf(jobId);
    const r = await showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: text('main.attachFilter'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'txt', 'md', 'json', 'csv', 'log'] },
      ],
    });
    if (r.canceled || !r.filePaths.length) return { attachments: job.pending, errors: [], canceled: true, limits: attachments.LIMITS };
    return addFiles(job, r.filePaths.map((file) => ({ name: path.basename(file), path: file })));
  });
  handle('attachments:remove', (jobId, payload) => {
    const job = jobOf(jobId);
    const id = payload?.id;
    const meta = job.pending.find((a) => a.id === id);
    if (meta) {
      attachments.removeAttachment(userData(), meta);
      job.pending = job.pending.filter((a) => a.id !== id);
    }
    return { attachments: job.pending };
  });
  // 縮圖走 data URL(CSP 維持 img-src 'self' data:,不放寬成 file:)
  handle('attachments:thumb', (meta) => attachments.thumbDataUrl(userData(), meta));

  handle('chat:send', async (jobId, { text: body, mode, attachments: wanted }) => {
    const job = jobOf(jobId);
    const o = job.orchestrator;
    if (!o.running && (job.queued || scheduler.isHeld(job.id))) throw new Error(text('main.jobBusy'));
    // renderer 決定「這次要送哪些 chip」,main 仍是唯一驗證與儲存的一方
    let sending = job.pending;
    if (Array.isArray(wanted)) {
      const keep = new Set(wanted.map((a: any) => (a && a.id) || a));
      sending = job.pending.filter((a: any) => keep.has(a.id));
      dropPending(job.pending.filter((a: any) => !keep.has(a.id)));
    }
    // 進行中:是這件任務的插話,不是新任務
    if (o.running) {
      const message = await o.userMessage(body, mode, sending);
      // 成功交給 orchestrator 之後才清 pending:中途丟例外時 renderer 會復原 chip
      job.pending = [];
      return message;
    }
    const previousConfig = job.config;
    const current = structuredClone(store.get());
    if (previousConfig) current.settings.workDir = previousConfig.settings.workDir;
    job.config = current;
    job.pending = [];
    const queued = { text: body, mode, attachments: sending, previousConfig };
    job.queued = queued;
    emitJobs();
    try {
      const resources = await jobResources(job, speakers(job, body));
      if (job.queued !== queued) return undefined;
      job.resources = resources;
      scheduler.submit(job.id, resources);
    } catch (error) {
      if (job.queued === queued) {
        job.queued = null;
        job.config = previousConfig;
        job.pending = [...sending, ...job.pending];
        emitJobs();
      }
      throw error;
    }
    emitJobs();
    return undefined;
  });
  handle('chat:export', async (jobId) => {
    const messages = jobOf(jobId).orchestrator.snapshot().messages;
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
    if (result.ok) for (const job of jobs.values()) if (job.sessionFileId === id) job.sessionFileId = null;
    return result;
  });
  // 載入歷史對話繼續討論:之後的任務會寫回同一份紀錄
  handle('chat:resume', (jobId, id) => {
    const job = jobOf(jobId);
    if (busy(job)) return { ok: false, error: text('main.stillRunning') };
    // 兩件任務寫同一份紀錄檔會互相覆蓋
    if ([...jobs.values()].some((other) => other !== job && other.sessionFileId === id)) return { ok: false, error: text('main.sessionOpenElsewhere') };
    const result = readSession(userData(), id, uiLocale());
    if (!result.ok) return result;
    job.activeTaskStart = null;
    resetPending(job); // 未送出的附件屬於舊對話的目錄,不能帶過去
    const snapshot = job.orchestrator.loadConversation(result.session);
    // 舊紀錄沒有記下工作目錄:下次送出照目前的設定走
    job.config = null;
    job.outcome = null;
    job.sessionFileId = id;
    emitJobs();
    return { ok: true, id, snapshot };
  });
  // 只轉交;id 驗證與 first-answer-wins 都在 orchestrator,IPC 層不保留任何狀態
  handle('chat:answer', (jobId, answer) => jobOf(jobId).orchestrator.answerQuestion(answer));
  handle('chat:retry', async (jobId, messageId) => {
    const job = jobOf(jobId);
    const o = job.orchestrator;
    if (busy(job)) return { ok: false, error: o.text('sys.retryBusy') };
    const msg = o.messages.find((m) => m.id === messageId);
    const res = await jobResources(job, jobConfig(job).agents.filter((a) => a.id === msg?.agentId));
    if (busy(job) || !jobs.has(job.id)) return { ok: false, error: o.text('sys.retryBusy') };
    const blocker = scheduler.tryHold(job.id, res, true);
    if (blocker) return { ok: false, error: blockedText(blocker) };
    job.resources = res;
    job.activeTaskStart = o.messages.length;
    job.outcome = null;
    const result = await o.retry(messageId);
    if (result.ok && o.running) recordRun(job, res);
    if (!o.running) { job.activeTaskStart = null; releaseJob(job); }
    emitJobs();
    return result;
  });
  // 工作目錄目前的檔案改動。唯讀:不碰使用者的版本控制狀態,全程非同步(同步跑會凍結整個視窗)。
  // 是 git repo 就相對上一次 commit;不是的話,相對最近一次任務開始前記下的內容
  handle('diff:changes', (jobId) => {
    const job = jobOf(jobId);
    return workdirChanges(jobWorkDir(job), job.orchestrator.taskBaseline);
  });
  // 還原這次任務的改動:回到任務開始前的樣子。破壞性操作,介面一定要先問過使用者。
  // 之後有別的任務在同一個目錄跑過就拒絕:基準點會把那件任務的成果一起蓋掉。
  handle('task:revert', (jobId, scope) => {
    const job = jobOf(jobId);
    const refused = (reason: RevertOutcome['reason']): RevertOutcome => ({ ok: false, reason, restored: 0, deleted: 0, skipped: [], failed: [] });
    if (busy(job)) return refused('running');
    return withDirectory(job, async () => {
      if (ledger.supersededBy(job.id) || (job.staleBaseline && job.staleBaseline === job.orchestrator.taskBaseline)) return refused('stale');
      return job.orchestrator.revertTask(scope);
    }, () => refused('busy'));
  });
  handle('task:verification', (jobId, messageId) => jobOf(jobId).orchestrator.taskVerificationStatus(messageId));
  handle('task:reverify', (jobId, messageId, confirmedCommand) => {
    const job = jobOf(jobId);
    return withDirectory(job, () => job.orchestrator.reverifyTask(messageId, confirmedCommand), (blocker) => ({ ok: false, error: blockedText(blocker) }));
  });
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
  // 終端。開在目前的工作目錄——成員在哪裡動手,使用者就在哪裡下指令。
  handle('terminal:create', (payload) => {
    const result = terminals.create({
      cwd: payload?.cwd || store.get().settings.workDir,
      cols: payload?.cols,
      rows: payload?.rows,
    });
    if (result.ok) return { ok: true, session: result.session };
    if (result.code === 'tooMany') return { ok: false, error: text('terminal.tooMany', { max: TERMINAL_MAX }) };
    if (result.code === 'noExpect') return { ok: false, error: text('terminal.noExpect') };
    return { ok: false, error: text('terminal.spawnFailed', { detail: result.detail || '' }) };
  });
  handle('terminal:write', ({ id, data }) => terminals.write(String(id), String(data)));
  handle('terminal:resize', ({ id, cols, rows }) => terminals.resize(String(id), cols, rows));
  handle('terminal:close', ({ id }) => terminals.close(String(id)));
  handle('terminal:list', () => terminals.list());

  handle('chat:stop', (jobId) => {
    const job = jobOf(jobId);
    // 還在排隊:取消排隊,內容交還給輸入框
    if (job.queued) {
      const queued = job.queued;
      job.queued = null;
      scheduler.cancel(job.id);
      job.config = queued.previousConfig;
      job.pending = [...queued.attachments, ...job.pending];
      emitJobs();
      return { canceledText: queued.text };
    }
    job.orchestrator.stop();
    return {};
  });
  handle('chat:reset', async (jobId) => {
    const job = jobOf(jobId);
    if (job.maintenance) throw new Error(text('main.stillRunning'));
    if (job.orchestrator.running) {
      await new Promise<void>((resolve) => {
        const onState = (state: { running: boolean }) => {
          if (state.running) return;
          job.orchestrator.removeListener('state', onState);
          resolve();
        };
        job.orchestrator.on('state', onState);
        job.orchestrator.stop();
      });
    }
    if (job.queued) {
      dropPending(job.queued.attachments);
      job.queued = null;
      scheduler.cancel(job.id);
    }
    job.orchestrator.reset();
    job.config = null;
    job.staleBaseline = null;
    emitJobs();
  });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { stopOrchestrator(); stopTerminals(); cancelInstall(); app.quit(); });
app.on('before-quit', () => { stopOrchestrator(); stopTerminals(); cancelInstall(); });
