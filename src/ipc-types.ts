// Shared IPC contracts. Keep this module browser-safe: no Electron or Node imports.

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
  originalFile?: string;
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
