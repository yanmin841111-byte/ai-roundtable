// Shared IPC contracts. Keep this module browser-safe: no Electron or Node imports.

import type { Model } from './model-rules';

export type { Model };

export const IPC_CHANNELS = {
  configGet: 'config:get',
  configSave: 'config:save',
  cliTypes: 'cli:types',
  cliCheck: 'cli:check',
  dialogPickDir: 'dialog:pickDir',
  dialogPickExecutable: 'dialog:pickExecutable',
  shellOpenPath: 'shell:openPath',
  chatSnapshot: 'chat:snapshot',
  chatSend: 'chat:send',
  chatExport: 'chat:export',
  chatOpenSessions: 'chat:openSessions',
  chatStop: 'chat:stop',
  chatReset: 'chat:reset',
  chatResume: 'chat:resume',
  chatAnswer: 'chat:answer',
  diffChanges: 'diff:changes',
  ollamaQuickSetup: 'ollama:quickSetup',
  chatMessage: 'chat:message',
  chatState: 'chat:state',
  sessionSaved: 'session:saved',
  attachmentsList: 'attachments:list',
  attachmentsPick: 'attachments:pick',
  attachmentsAdd: 'attachments:add',
  attachmentsRemove: 'attachments:remove',
  attachmentsThumb: 'attachments:thumb',
  sessionList: 'session:list',
  sessionRead: 'session:read',
  sessionDelete: 'session:delete',
  secretsSet: 'secrets:set',
  secretsStatus: 'secrets:status',
  secretsClear: 'secrets:clear',
  secretsTest: 'secrets:test',
  extList: 'ext:list',
  extReload: 'ext:reload',
  extInstall: 'ext:install',
  extRead: 'ext:read',
  extWrite: 'ext:write',
  extDelete: 'ext:delete',
  extOpenDir: 'ext:openDir',
  extOpenDocs: 'ext:openDocs',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export type IpcError = {
  code: string;
  params?: Record<string, string | number>;
  detail?: string;
};

export type IpcFailure = { ok: false; error: IpcError };
export type IpcSuccess<T> = { ok: true; value: T };
export type IpcResult<T> = IpcSuccess<T> | IpcFailure;

export type SaveConfigPayload<TConfig = unknown> = TConfig;
export type SendChatPayload<TAttachment = unknown> = {
  text: string;
  mode: string;
  attachments?: TAttachment[];
};
export type WriteExtensionPayload = {
  file: string;
  content: string;
  originalFile?: string | null;
};
export type SecretRefPayload = { ref: string };
export type SecretStatusPayload = SecretRefPayload & { envName?: string };
export type SecretSetPayload = SecretRefPayload & { value: string };

// ---------- Phase 契約 ----------
// phase 走兩條獨立通道,兩條都改成結構化資料:
//   1. 全域狀態 state.phase  -> renderer 的階段膠囊(phase pill)
//   2. 單則訊息 message.phase -> renderer 的階段/輪次分隔線與訊息徽章
// code 是協定(供程式比對),顯示文字一律由 renderer 依 uiLocale 組出,
// orchestrator 不再產生任何面向使用者的 phase 字串。
export type PhaseCode =
  | 'idle'
  | 'direct'
  | 'discuss'
  | 'divide'
  | 'execute'
  | 'review'
  | 'repair'
  | 'summary'
  // 成員在討論階段提問,流程停在這裡等使用者回答
  | 'ask';

export interface PhaseInfo {
  code: PhaseCode;
  round?: number;
  maxRounds?: number;
  names?: string[];
}

// 舊 session 的 phase 是純字串;讀取歷史紀錄時用這個聯集型別。
export type PhaseValue = PhaseInfo | string;

export function isPhaseInfo(value: unknown): value is PhaseInfo {
  return !!value && typeof value === 'object' && typeof (value as PhaseInfo).code === 'string';
}

// ---------- 設定 ----------
export interface AgentConfig {
  id: string;
  name: string;
  cli: string;
  model: string;
  effort: string;
  persona: string;
  color: string;
  canEdit: boolean;
  enabled: boolean;
  customCommand: string;
}

export interface AppSettings {
  workDir: string;
  maxRounds: number;
  mode: string;
  leadAgentId: string | null;
  language: string;
  maxTranscriptChars: number;
  theme?: string;
  fontSize?: number;
  // 介面語言:'system' 跟隨作業系統;沒設定時視同 system
  uiLocale?: 'system' | 'zh-Hant' | 'en';
}

export interface AppConfig {
  agents: AgentConfig[];
  settings: AppSettings;
}

// ---------- 轉接器(CLI 與擴充) ----------
export interface CliType {
  id: string;
  label: string;
  type: 'builtin' | 'cli' | 'openai' | 'js' | string;
  origin?: string;
  bin?: string;
  file?: string;
  description?: string;
  supportsEdit?: boolean;
  capabilities?: { attachments?: string[]; attachmentsNeedCwd?: boolean };
  usesCustomCommand?: boolean;
  efforts?: string[];
  models?: Model[];
  modelSource?: 'fallback' | 'error' | 'loading' | string;
  modelError?: string;
}

// 'missing' = 找不到指令;'unauthenticated' = 指令在但尚未登入 / 缺 API key;'ready' = 可用。
// 判斷一律只看 exit code,不解析 CLI 的輸出文字(文案與語系都會隨版本改變)。
//
// 'unreachable' 只給「已配置、免驗證(沒有 apiKeyEnv / secretRef)但連不上」的 HTTP 型
// 轉接器使用,典型例子是本機 Ollama 沒有啟動。這類端點不需要登入,套用
// 'unauthenticated' 會讓使用者去找根本不存在的 API key;也不是 'missing',因為設定本身在。
// CLI 型轉接器一律不使用這個值,其 missing / unauthenticated 判定維持原樣。
export type CliState = 'missing' | 'unauthenticated' | 'unreachable' | 'ready';

// 轉接器 check() / testConnection() 的回傳。多數轉接器只填 ok/version/error,
// state 由 registry.checkAll() 統一補齊後才送到介面。
export interface CliStatus {
  ok: boolean;
  version?: string;
  error?: string;
  state?: CliState;
  hint?: string;
}

// cli:check 給介面的正規化結果:state 一定有值,介面不必比對錯誤字串。
export interface CliHealth {
  state: CliState;
  ok: boolean;
  version?: string;
  error?: string;
  // 未登入時要顯示給使用者的指令,例如「請在終端機執行 codex login」
  hint?: string;
}

export interface ExtEntry {
  file: string;
  error?: string;
  overrides?: boolean;
}

export interface ExtTemplate {
  file: string;
  id: string;
  label: string;
  description: string;
  type: string;
}

export interface ExtSummary {
  dir?: string;
  entries: ExtEntry[];
  templates: ExtTemplate[];
}

// 擴充的 JSON 設定檔內容。使用者可自由編輯,欄位不保證齊全。
export interface ExtSpec {
  id?: string;
  label?: string;
  type?: string;
  bin?: string;
  args?: unknown[];
  baseUrl?: string;
  apiKeyEnv?: string;
  secretRef?: string;
  models?: 'auto' | Array<string | Model>;
  capabilities?: { attachments?: string[]; attachmentsNeedCwd?: boolean };
  [key: string]: unknown;
}

// ---------- 訊息 ----------
export interface UsageInfo {
  shape?: string;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheWriteTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  raw?: unknown;
  [key: string]: unknown;
}

export interface Activity {
  id?: string;
  title?: string;
  kind?: string;
  status?: string;
  detail?: string;
  result?: string;
}

export interface AttachmentMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: string;
  path?: string | null;
  relPath?: string | null;
  thumb?: string | null;
  // 訊息裡的附件通常沒有這兩個欄位;composer 的待送附件才會帶。
  thumbUrl?: string | null;
  file?: File | null;
}

// renderer 自己維護的待送附件:多帶 thumbUrl 與尚未落地的 File。
export interface PendingAttachment extends AttachmentMeta {
  thumbUrl: string | null;
  file: File | null;
}

export interface ChatMessage {
  id: string;
  kind: 'agent' | 'user' | 'system';
  level?: string;
  status?: string;
  text?: string;
  ts?: string | number;
  agentId?: string;
  agentName?: string;
  cli?: string;
  model?: string;
  phase?: PhaseValue;
  // 系統訊息的結構標記(例如 'plan' = 分工結果、'tool-audit' = 檔案工具稽核),讓程式不必比對文案
  tag?: string;
  // tag === 'tool-audit' 時的結構化內容;text 是同一份資料的可讀版本
  toolAudit?: ToolAuditEntry[];
  color?: string;
  group?: string;
  directed?: boolean;
  error?: string | null;
  thinking?: string;
  activities?: Activity[];
  attachments?: AttachmentMeta[];
  mentions?: Array<{ id?: string; name: string }>;
  usage?: UsageInfo | null;
  // 這則訊息改了檔案,但沒有其他成員審查過。只有一位成員、或審查階段失敗時會發生;
  // 介面必須明講,否則使用者會把「跑完了」當成「有人看過了」。
  // 由 orchestrator 在執行階段結束時填入(工具呼叫層接線時)。
  unreviewed?: boolean;
}

// ---------- 選項式提問 ----------
// 成員在討論階段(唯一循序執行的階段)可以用 [ASK] 區塊反問使用者,
// orchestrator 會停下來等回答。執行/審查/指定階段是平行的,一律不開放提問。

export interface QuestionOption {
  // 回答時回傳這個;由 parseAsk 依順序指派 a、b、c…,不取用模型自己寫的編號
  id: string;
  label: string;
  detail?: string;
}

export interface PendingQuestion {
  id: string;
  agentId: string;
  agentName: string;
  question: string;
  // 可為空陣列:模型只寫了問題沒給選項時,卡片只顯示自由輸入
  options: QuestionOption[];
  // 目前恆為 true:選項是捷徑,使用者永遠可以自己打字回答
  allowFree: boolean;
  // epoch ms。逾時由 orchestrator 負責結算成 defer,UI 只依這個顯示倒數
  expiresAt: number;
}

export interface QuestionAnswer {
  id: string;
  optionIds?: string[];
  text?: string;
  // defer =「你決定」、逾時、或等待中按下停止
  decision: 'answered' | 'defer';
}

export interface ChatState {
  running: boolean;
  phase?: PhaseValue;
  sessionId?: string | null;
  messages?: ChatMessage[];
  // null 表示目前沒有待答問題
  question?: PendingQuestion | null;
}

// ---------- 歷史紀錄 ----------
export interface SessionSummary {
  id: string;
  conversationId?: string | null;
  attachmentCount?: number;
  title?: string;
  createdAt?: string | number;
  messageCount?: number;
  agents?: string[];
  error?: string;
}

export interface SessionDetail {
  conversationId?: string | null;
  title?: string;
  createdAt?: string | number;
  agents?: string[];
  messages?: ChatMessage[];
}

// ---------- 附件 ----------
export interface AttachLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

// 送進 attachments.add 的項目:拖放給 path,走 IPC 讀檔給 ArrayBuffer。
export type AttachmentInput =
  | { name: string; path: string }
  | { name: string; data: ArrayBuffer };

export interface AttachmentsResult {
  limits?: AttachLimits;
  attachments?: AttachmentMeta[];
  added?: AttachmentMeta[];
  errors?: Array<string | { name?: string; error?: string; message?: string }>;
  canceled?: boolean;
}

// ---------- IPC 契約 ----------
// 每個 invoke 通道的參數與回傳型別。主程序用 handle() 註冊、preload 用 invoke() 呼叫,
// 兩邊都照這份檢查,任何一邊改了形狀另一邊就會編譯失敗。

export interface SecretStatus {
  configured: boolean;
  source: string | null;
  hint: string;
}

export interface ExportResult {
  ok: boolean;
  file?: string;
  error?: string;
  canceled?: boolean;
}

export type ResumeResult =
  | { ok: true; id: string; snapshot: ChatSnapshot }
  | { ok: false; error: string };

export interface ExtReadResult {
  content: string;
  migration: string;
  migrationError: string;
}

// ---------- 檔案改動(紅綠 diff) ----------
// 成員會直接改使用者的檔案,但介面原本只看得到文字描述。這組型別讓介面能逐檔、逐行
// 呈現實際改了什麼。目前是唯讀呈現:不提供套用或還原,避免介面變成第二個版本控制工具。
export type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

// status 沿用 git 的語意,但把未追蹤檔一律歸成 'added':對使用者來說
// 「git 還不知道這個檔案」和「新增的檔案」是同一件事。
export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffFile {
  path: string;
  // 改名前的路徑;只有 status === 'renamed' 才有值
  oldPath?: string;
  status: DiffFileStatus;
  added: number;
  removed: number;
  // 二進位檔沒有逐行內容,只顯示檔名與狀態
  binary?: boolean;
  // 超過行數上限時只帶前段內容,truncated 為 true,介面要說明「僅顯示前 N 行」
  truncated?: boolean;
  lines: DiffLine[];
}

export type DiffResult =
  // totalFiles 是工作目錄實際的改動檔案數。files 可能因上限而較少,介面必須比對兩者,
  // 否則會把「只顯示前 N 個」呈現成精確的總數與完整增刪統計。
  | { ok: true; dir: string; files: DiffFile[]; totalFiles: number }
  // reason 是給介面判斷要顯示哪一種說明,不是直接給使用者看的文字
  | { ok: false; reason: 'no-workdir' | 'not-a-repo' | 'failed'; detail?: string };

// ---------- 檔案工具稽核紀錄 ----------
// 成員用工具改檔時,它「說」自己做了什麼和「實際」做了什麼可能對不上。這份紀錄是實際發生的事,
// 會一併寫進 transcript 讓審查者看得到——否則交叉審查只是在審一篇作文。
//
// 刻意不含檔案內容:read_file 的回傳動輒數萬字,放進 transcript 會把每一回合的提示詞撐爆。
// replaced 只留片段,讓審查者知道改了什麼形狀的東西,細節請看紅綠 diff。
export interface ToolAuditEntry {
  tool: string;
  path?: string;
  ok: boolean;
  error?: string;
  // 修改前後的 SHA-256。前者目前取自模型提供的 expectedSha256,後者是寫入後的實際值。
  shaBefore?: string;
  shaAfter?: string;
  added?: number;
  removed?: number;
  // 增刪行數是近似值。逐行 diff 超過運算保護值時會退回「整檔行數」,
  // 那個數字看起來精確但會嚴重高估;不標出來的話,審查者會拿它當事實。
  statsApproximate?: boolean;
  replacements?: number;
  // 模型自述的修改目的(write_file 的 reason)
  reason?: string;
  // replace_text 實際換掉的片段;已截斷,不是完整檔案內容
  replaced?: { before: string; after: string; truncated: boolean };
}

// ---------- 一鍵連接本機模型(Ollama) ----------
// 目的是讓「接上本機模型」只剩一個決定:選哪個模型。端點、API key、JSON 這些
// 技術細節全部留在 adapter 層,不進到這個契約,介面也就沒有機會把它們顯示出來。
export interface OllamaSetupResult {
  ok: boolean;
  // 實際偵測與寫入用的端點。介面不顯示,但錯誤排查時有用
  baseUrl: string;
  models: Model[];
  // 建議預設選中的模型;沒有已安裝模型時為 null
  recommendedModel: string | null;
  // 偵測失敗時的原始錯誤(英文居多),介面優先顯示 hint 而不是這個
  error?: string | null;
  // 可以照做的下一步,例如「請先執行 ollama serve」
  hint?: string | null;
  // 是否已經寫入設定。只有帶 model 呼叫且成功時才是 true
  installed: boolean;
  selectedModel?: string;
  adapterId?: string;
  file?: string;
}

export type OkResult = { ok: true } | { ok: false; error: string };
export type SessionReadResult = { ok: true; session: SessionDetail } | { ok: false; error: string };

export type ChatSnapshot = ChatState & { messages: ChatMessage[]; conversationId?: string };

export interface IpcContract {
  'config:get': { args: []; result: AppConfig };
  'config:save': { args: [cfg: SaveConfigPayload<AppConfig>]; result: AppConfig };
  'cli:types': { args: []; result: Record<string, CliType> };
  'cli:check': { args: [opts?: { probeCredentialed?: boolean }]; result: Record<string, CliHealth> };
  'dialog:pickDir': { args: []; result: string | null };
  'dialog:pickExecutable': { args: []; result: string | null };
  'shell:openPath': { args: [p: string]; result: string };
  'chat:snapshot': { args: []; result: ChatSnapshot };
  'chat:send': { args: [payload: SendChatPayload<AttachmentMeta>]; result: ChatMessage | undefined };
  'chat:export': { args: []; result: ExportResult };
  'chat:openSessions': { args: []; result: string };
  'chat:stop': { args: []; result: void };
  'chat:reset': { args: []; result: void };
  'chat:resume': { args: [sessionId: string]; result: ResumeResult };
  'chat:answer': { args: [answer: QuestionAnswer]; result: void };
  'diff:changes': { args: []; result: DiffResult };
  'ollama:quickSetup': { args: [payload?: { model?: string }]; result: OllamaSetupResult };
  'attachments:list': { args: []; result: AttachmentsResult };
  'attachments:pick': { args: []; result: AttachmentsResult };
  'attachments:add': { args: [payload: { items: AttachmentInput[] }]; result: AttachmentsResult };
  'attachments:remove': { args: [payload: { id: string }]; result: AttachmentsResult };
  'attachments:thumb': { args: [meta: AttachmentMeta]; result: string | null };
  'session:list': { args: []; result: { sessions: SessionSummary[]; error?: string } };
  'session:read': { args: [id: string]; result: SessionReadResult };
  'session:delete': { args: [id: string]; result: OkResult };
  'secrets:set': { args: [payload: SecretSetPayload]; result: SecretStatus };
  'secrets:status': { args: [payload: SecretStatusPayload]; result: SecretStatus };
  'secrets:clear': { args: [payload: SecretRefPayload]; result: SecretStatus };
  'secrets:test': { args: [payload: { adapterId: string }]; result: CliStatus };
  'ext:list': { args: []; result: ExtSummary };
  'ext:reload': { args: []; result: ExtSummary };
  'ext:install': { args: [templateFile: string]; result: { file: string; summary: ExtSummary } };
  'ext:read': { args: [file: string]; result: ExtReadResult };
  'ext:write': { args: [payload: WriteExtensionPayload]; result: { summary: ExtSummary; error: string | null } };
  'ext:delete': { args: [file: string]; result: ExtSummary };
  'ext:openDir': { args: []; result: string };
  'ext:openDocs': { args: []; result: void };
}

export type InvokeChannel = keyof IpcContract;
export type IpcArgs<C extends InvokeChannel> = IpcContract[C]['args'];
export type IpcReturn<C extends InvokeChannel> = IpcContract[C]['result'];

// 主程序主動推給 renderer 的事件。
export interface IpcEvents {
  'chat:message': ChatMessage;
  'chat:state': ChatState;
  'chat:reset': void;
  'session:saved': { id: string | null };
}

export type EventChannel = keyof IpcEvents;

// ---------- window.api ----------
export interface RendererApi {
  getConfig(): Promise<AppConfig>;
  saveConfig(cfg: AppConfig): Promise<AppConfig>;
  cliTypes(): Promise<Record<string, CliType>>;
  // probeCredentialed:真的連線驗證有 key 的雲端 API(打開設定畫面時才帶)
  checkCli(opts?: { probeCredentialed?: boolean }): Promise<Record<string, CliHealth>>;
  pickDir(): Promise<string | null>;
  pickExecutable(): Promise<string | null>;
  openPath(p: string): Promise<string>;
  snapshot(): Promise<ChatSnapshot>;
  send(text: string, mode: string, attachments: AttachmentMeta[]): Promise<ChatMessage | undefined>;
  exportChat(): Promise<ExportResult>;
  openSessions(): Promise<string>;
  stop(): Promise<void>;
  reset(): Promise<void>;
  resume(sessionId: string): Promise<ResumeResult>;
  // 回答成員的提問。id 驗證與 first-answer-wins 都在 orchestrator,這裡只負責轉交。
  answerQuestion(answer: QuestionAnswer): Promise<void>;
  // 工作目錄目前的檔案改動;唯讀,不提供套用或還原
  getDiff(): Promise<DiffResult>;
  // 一鍵連接本機 Ollama。不帶 model 只偵測並列出已安裝模型;帶 model 則寫入設定
  quickSetupOllama(model?: string): Promise<OllamaSetupResult>;
  attachments: {
    list(): Promise<AttachmentsResult>;
    pick(): Promise<AttachmentsResult>;
    add(items: AttachmentInput[]): Promise<AttachmentsResult>;
    pathForFile(file: File): string;
    remove(id: string): Promise<AttachmentsResult>;
    thumb(meta: AttachmentMeta): Promise<string | null>;
  };
  sessions: {
    list(): Promise<IpcReturn<'session:list'>>;
    read(id: string): Promise<IpcReturn<'session:read'>>;
    remove(id: string): Promise<IpcReturn<'session:delete'>>;
  };
  secrets: {
    set(ref: string, value: string): Promise<SecretStatus>;
    status(ref: string, envName?: string): Promise<SecretStatus>;
    clear(ref: string): Promise<SecretStatus>;
    test(adapterId: string): Promise<CliStatus>;
  };
  ext: {
    list(): Promise<ExtSummary>;
    reload(): Promise<ExtSummary>;
    install(templateFile: string): Promise<IpcReturn<'ext:install'>>;
    read(file: string): Promise<ExtReadResult>;
    write(file: string, content: string, originalFile?: string | null): Promise<IpcReturn<'ext:write'>>;
    remove(file: string): Promise<ExtSummary>;
    openDir(): Promise<string>;
    openDocs(): Promise<void>;
  };
  onMessage(fn: (m: ChatMessage) => void): void;
  onState(fn: (s: ChatState) => void): void;
  onReset(fn: () => void): void;
  onSessionSaved(fn: (info: IpcEvents['session:saved']) => void): void;
}
