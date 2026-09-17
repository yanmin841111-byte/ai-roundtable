import type { PhaseValue } from '../src/ipc-types';

// Renderer 端看得到的型別:preload 透過 contextBridge 掛上的 window.api,以及它傳遞的資料形狀。
//
// TODO(整合):A2 建立 src/ipc-types.ts 後,這裡的 payload 型別應改成從該檔 re-export,
// 由 preload 與 renderer 共用同一份定義。本檔目前是暫時的單一來源,避免兩邊各寫一份。
// 注意:src/ipc-types.ts 會被 renderer bundle inline,不得 import electron 或 node:* 模組。

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

// 與 src/model-rules.ts 的 Model 同形;此處重述以免 .d.ts 依賴實作檔。
export interface Model {
  id: string;
  label: string;
  description?: string;
  efforts?: string[];
  defaultEffort?: string;
  aliases?: string[];
  unrestrictedEffort?: boolean;
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
  raw?: Record<string, unknown>;
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
  error?: string;
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
  title?: string;
  createdAt?: string | number;
  messageCount?: number;
  agents?: string[];
  error?: string;
}

export interface SessionDetail {
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

// ---------- window.api ----------
export interface RendererApi {
  getConfig(): Promise<AppConfig>;
  saveConfig(cfg: AppConfig): Promise<AppConfig>;
  cliTypes(): Promise<Record<string, CliType>>;
  checkCli(): Promise<Record<string, CliStatus>>;
  pickDir(): Promise<string>;
  pickExecutable(): Promise<string>;
  openPath(p: string): Promise<string>;
  snapshot(): Promise<ChatState & { messages: ChatMessage[] }>;
  send(text: string, mode: string, attachments: AttachmentMeta[]): Promise<void>;
  exportChat(): Promise<{ error?: string } | void>;
  openSessions(): Promise<void>;
  stop(): Promise<void>;
  reset(): Promise<void>;
  resume(sessionId: string): Promise<{ ok: boolean; id: string; error?: string; snapshot?: ChatState }>;
  attachments: {
    list(): Promise<AttachmentsResult>;
    pick(): Promise<AttachmentsResult>;
    add(items: AttachmentInput[]): Promise<AttachmentsResult>;
    pathForFile(file: File): string;
    remove(id: string): Promise<void>;
    thumb(meta: AttachmentMeta): Promise<string | { dataUrl?: string; url?: string } | null>;
  };
  sessions: {
    list(): Promise<{ sessions?: SessionSummary[]; error?: string }>;
    read(id: string): Promise<{ ok: boolean; session?: SessionDetail; error?: string }>;
    remove(id: string): Promise<{ ok: boolean; error?: string }>;
  };
  secrets: {
    set(ref: string, value: string): Promise<void>;
    status(ref: string, envName: string): Promise<{ configured: boolean; hint?: string; source?: string }>;
    clear(ref: string): Promise<void>;
    test(adapterId: string): Promise<{ ok: boolean; version?: string; error?: string }>;
  };
  ext: {
    list(): Promise<ExtSummary>;
    reload(): Promise<void>;
    install(templateFile: string): Promise<{ file: string }>;
    read(file: string): Promise<string | { content: string; migration?: string; migrationError?: string }>;
    write(file: string, content: string, originalFile: string | null): Promise<{ error?: string }>;
    remove(file: string): Promise<void>;
    openDir(): Promise<void>;
    openDocs(): Promise<void>;
  };
  onMessage(fn: (m: ChatMessage) => void): void;
  onState(fn: (s: ChatState) => void): void;
  onReset(fn: () => void): void;
  onSessionSaved(fn: (info: { id?: string }) => void): void;
}

declare global {
  interface Window {
    api: RendererApi;
  }
}
