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
  | 'summary';

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
  usesCustomCommand?: boolean;
  efforts?: string[];
  models?: Model[];
  modelSource?: 'fallback' | 'error' | 'loading' | string;
  modelError?: string;
}

export interface CliStatus {
  ok: boolean;
  version?: string;
  error?: string;
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
  color?: string;
  group?: string;
  directed?: boolean;
  error?: string | null;
  thinking?: string;
  activities?: Activity[];
  attachments?: AttachmentMeta[];
  mentions?: Array<{ id?: string; name: string }>;
  usage?: UsageInfo | null;
}

export interface ChatState {
  running: boolean;
  phase?: PhaseValue;
  sessionId?: string | null;
  messages?: ChatMessage[];
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

export type OkResult = { ok: true } | { ok: false; error: string };
export type SessionReadResult = { ok: true; session: SessionDetail } | { ok: false; error: string };

export type ChatSnapshot = ChatState & { messages: ChatMessage[]; conversationId?: string };

export interface IpcContract {
  'config:get': { args: []; result: AppConfig };
  'config:save': { args: [cfg: SaveConfigPayload<AppConfig>]; result: AppConfig };
  'cli:types': { args: []; result: Record<string, CliType> };
  'cli:check': { args: []; result: Record<string, CliStatus> };
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
  checkCli(): Promise<Record<string, CliStatus>>;
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
