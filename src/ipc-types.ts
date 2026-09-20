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
  chatRetry: 'chat:retry',
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
  terminalCreate: 'terminal:create',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalClose: 'terminal:close',
  terminalList: 'terminal:list',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
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
  // 最近一次套用或儲存的陣容;側欄據此標出目前是哪個陣容、之後有沒有改過
  activeLineupId?: string | null;
  // 自動驗證指令(在工作目錄執行,例如 npm test)。空字串代表只做內建的語法檢查
  verifyCommand?: string;
  // 終端面板的寬度(px)。下次打開時維持上次拉好的寬度
  terminalWidth?: number;
}

// 陣容:一組「誰上場、各自的角色、誰主持、什麼流程、討論幾輪」(見 src/lineups.ts)
export interface Lineup {
  id: string;
  name: string;
  members: Array<{ id: string; persona: string }>;
  leadAgentId: string | null;
  mode: string;
  maxRounds: number;
}

export interface AppConfig {
  agents: AgentConfig[];
  settings: AppSettings;
  lineups?: Lineup[];
}

// API 成員所用模型的能力。true / false 是確定的(Ollama 回報、端點提供的模型資料,或實際測過);
// 欄位不存在代表不知道。CLI 成員沒有這份資料:讀檔與圖片由 CLI 自己處理。
export interface ModelCapability {
  model: string;      // 實際使用的模型 id(成員沒指定時是範本的預設模型)
  tools?: boolean;    // 能不能呼叫工具:改檔、審查時自己讀檔都靠它
  images?: boolean;   // 能不能看圖
  source: 'ollama' | 'metadata' | 'probe';
  at: number;         // 取得的時間(ms)
  error?: string;     // 實際測試沒能完成時的原因
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
// ---------- 環境問題的「照做就能修好」 ----------
// 全 app 統一的形狀:偵測到問題的地方填它,介面用同一張卡片呈現。
// 三種下一步,依序是最具體到最一般:
//   command    一行可以直接在內建終端執行的指令(claude auth login、ollama serve…)。
//              永遠只填進終端,不自動執行——sudo、安裝、啟動服務要由使用者自己按 Enter。
//   settingsTab 要在 app 裡做的事(例如填 API key),帶使用者到對的設定分頁
//   url        以上都沒有時的官方說明頁
export interface EnvFix {
  command?: string;
  settingsTab?: string;
  url?: string;
}

export interface CliStatus {
  ok: boolean;
  version?: string;
  error?: string;
  state?: CliState;
  hint?: string;
  // 照做就能修好的下一步(見 EnvFix)
  fix?: EnvFix;
}

// cli:check 給介面的正規化結果:state 一定有值,介面不必比對錯誤字串。
export interface CliHealth {
  state: CliState;
  ok: boolean;
  version?: string;
  error?: string;
  // 未登入時要顯示給使用者的指令,例如「請在終端機執行 codex login」
  hint?: string;
  fix?: EnvFix;
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
  // 失敗的 @ 指定回覆可以重試。由 orchestrator 決定並寫進訊息,介面只照旗標顯示按鈕。
  retryable?: boolean;
  // 這次失敗如果是環境問題(沒登入、沒裝、連不上…),照做就能修好的下一步。
  // 由 runTurn 在回合失敗時補上;不寫進歷史紀錄(環境會變,重新開啟時要重新判斷)。
  fix?: EnvFix;
  // 交叉審查回合:審查者看了什麼、結論是什麼。介面靠它顯示結論徽章與「看了哪些檔案」,
  // 不必從文字猜。
  review?: ReviewInfo;
  // 主持人的分工輸出已經成功解析成下方的「分工結果」。原文(多半是一串 JSON)
  // 對使用者只是重複又難讀,介面收起來;解析失敗時不標,原文要留著讓人看出哪裡不對。
  rawPlan?: boolean;
  // tag === 'task-summary':分工任務結束時的結果卡。text 是同一份資料的純文字版(匯出、歷史紀錄用)
  taskSummary?: TaskSummary;
}

// 每位執行成員這次的結果,依流程實際走到哪裡決定:
//   approved   審查者宣告沒問題
//   repaired   審查提出問題,成員已經修復(修復後沒有再審查一次)
//   unresolved 審查提出問題,但沒有修好(沒有改檔權限,或修復回合失敗)
//   unreviewed 沒有人審查成功
//   failed     執行階段就失敗了
export type TaskOutcome = 'approved' | 'repaired' | 'unresolved' | 'unreviewed' | 'failed';

export interface TaskSummary {
  startedAt: number;
  endedAt: number;
  members: Array<{ name: string; color?: string; outcome: TaskOutcome; reviewers: string[] }>;
  // 這次任務改了哪些檔案(任務開始前後比對,不含使用者之前就有的改動)
  files: Array<{ path: string; status: DiffFileStatus; added: number; removed: number }>;
  moreFiles: number;
  // 這次任務所有回合的用量加總。turnsWithUsage < turns 代表有些回合沒有回報用量,總數偏低
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null; turns: number; turnsWithUsage: number };
  // app 自己跑的自動驗證(語法檢查與驗證指令):passed 通過、failed 沒過、none 沒有東西可驗
  verify?: 'passed' | 'failed' | 'none';
}

// 審查者怎麼看到改動
//   open   自己依路徑打開檔案(CLI 成員)
//   tool   附上內容,也可以用唯讀的 read_file 自己讀
//   inline 只看得到附在提示詞裡的內容
export type ReviewAccess = 'open' | 'tool' | 'inline';
// 這次要審的改動
//   listed    有改動清單
//   none      工作目錄裡沒有偵測到改動
//   untouched 依檔案工具的紀錄,被審者沒有改任何檔案
//   unknown   拿不到改動(工作目錄太大或讀不到)
//   readonly  被審者沒有改檔權限,只審回報
export type ReviewScope = 'listed' | 'none' | 'untouched' | 'unknown' | 'readonly';
// 結論,與流程決定要不要進修復回合用的是同一個判斷
//   pass    審查者明確寫了 [NO_ISSUES]
//   issues  有回覆,但沒有宣告沒問題 → 進修復回合
//   failed  出錯或沒有回覆 → 不算審查過
export type ReviewVerdict = 'pass' | 'issues' | 'failed';

export interface ReviewInfo {
  target: string;      // 被審者的名字
  access: ReviewAccess;
  scope: ReviewScope;
  files: string[];     // 列給審查者的檔案(相對於工作目錄,最多 20 個)
  more: number;        // 清單之外還有幾個改動的檔案
  omitted: string[];   // 列了、但超過上限沒附上內容的檔案(access 不是 open 時才有意義)
  unreadable: string[]; // 列了、但讀不到內容的檔案(已刪除、不是文字檔、沙箱拒絕)
  verdict?: ReviewVerdict; // 回合結束後才有
  recheck?: boolean;       // 修復後的複查
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
  // 工作目錄不是 git repo 時,沒有逐行比對的原因:
  //   not-kept  任務開始前沒有保存原始內容(超過單檔或總量上限)
  //   too-large 檔案現在超過單檔上限
  //   too-many  改動的檔案太多,比對時間用完
  unavailable?: 'not-kept' | 'too-large' | 'too-many';
  // 超過行數上限時只帶前段內容,truncated 為 true,介面要說明「僅顯示前 N 行」
  truncated?: boolean;
  lines: DiffLine[];
}

export type DiffResult =
  // totalFiles 是工作目錄實際的改動檔案數。files 可能因上限而較少,介面必須比對兩者,
  // 否則會把「只顯示前 N 個」呈現成精確的總數與完整增刪統計。
  // files 的路徑一律相對於 repo 根目錄;prefix 是工作目錄在 repo 裡的位置(例如 "web/",在根目錄時是空字串),
  // 介面拿相對於工作目錄的路徑(審查訊息裡的檔名)來找檔案時要先接上它。
  // source:'git' 是相對上一次 commit;'task' 是工作目錄不是 git repo 時,相對最近一次任務開始前(since 是那個時間)
  | { ok: true; dir: string; files: DiffFile[]; totalFiles: number; prefix: string; source?: 'git' | 'task'; since?: number }
  // reason 是給介面判斷要顯示哪一種說明,不是直接給使用者看的文字
  | { ok: false; reason: 'no-workdir' | 'not-a-repo' | 'failed'; detail?: string }
  // git 本身不能用(沒裝開發者工具、或沒同意 Xcode 授權)。這和「這裡不是 repo」是兩件事:
  // 叫使用者去 git init 沒有用,要修的是 git。fix.command 可以直接丟進內建終端執行。
  | { ok: false; reason: 'git-unavailable'; issue: 'missing' | 'license'; fix: EnvFix; detail?: string };

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
  // 那一步照做就能修好時的動作(見 EnvFix),例如「在終端執行 ollama serve」
  fix?: EnvFix | null;
  // 是否已經寫入設定。只有帶 model 呼叫且成功時才是 true
  installed: boolean;
  selectedModel?: string;
  adapterId?: string;
  file?: string;
}

// ---------- 終端 ----------
// 一個分頁就是一個跑在真 pty 上的互動式 shell。renderer 只認得 id 與大小,
// pty、行程、訊號一律留在主程序(src/terminal.ts)。
export interface TerminalSessionInfo {
  id: string;
  /** 實際的工作目錄。要求的目錄不存在時主程序會退回家目錄,所以這裡是「真正在哪裡」 */
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
}

export type TerminalCreateResult =
  | { ok: true; session: TerminalSessionInfo }
  | { ok: false; error: string };

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
  'chat:retry': { args: [messageId: string]; result: { ok: boolean; error?: string } };
  'diff:changes': { args: []; result: DiffResult };
  'ollama:quickSetup': { args: [payload?: { model?: string }]; result: OllamaSetupResult };
  // live 為 true 才會送出實際的對話請求(付費 API 會產生少量費用);否則只用免費的來源與快取
  'model:capability': { args: [payload: { adapterId: string; model: string; live?: boolean }]; result: ModelCapability | null };
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
  'terminal:create': { args: [payload?: { cols?: number; rows?: number; cwd?: string }]; result: TerminalCreateResult };
  'terminal:write': { args: [payload: { id: string; data: string }]; result: void };
  'terminal:resize': { args: [payload: { id: string; cols: number; rows: number }]; result: void };
  'terminal:close': { args: [payload: { id: string }]; result: void };
  'terminal:list': { args: []; result: TerminalSessionInfo[] };
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
  // pty 的原始輸出。不在主程序解碼成字串:多位元組字元會被切在兩個 chunk 之間,
  // 交給終端自己處理才不會出現半個字。
  'terminal:data': { id: string; data: Uint8Array };
  'terminal:exit': { id: string; code: number };
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
  retry(messageId: string): Promise<{ ok: boolean; error?: string }>;
  // 工作目錄目前的檔案改動;唯讀,不提供套用或還原
  getDiff(): Promise<DiffResult>;
  // 一鍵連接本機 Ollama。不帶 model 只偵測並列出已安裝模型;帶 model 則寫入設定
  quickSetupOllama(model?: string): Promise<OllamaSetupResult>;
  modelCapability(payload: { adapterId: string; model: string; live?: boolean }): Promise<ModelCapability | null>;
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
  // 終端分頁。開、輸入、改大小、關,其餘(pty、訊號、孤兒行程)都在主程序
  terminal: {
    create(payload?: { cols?: number; rows?: number; cwd?: string }): Promise<TerminalCreateResult>;
    write(id: string, data: string): Promise<void>;
    resize(id: string, cols: number, rows: number): Promise<void>;
    close(id: string): Promise<void>;
    list(): Promise<TerminalSessionInfo[]>;
    onData(fn: (payload: IpcEvents['terminal:data']) => void): void;
    onExit(fn: (payload: IpcEvents['terminal:exit']) => void): void;
  };
  onMessage(fn: (m: ChatMessage) => void): void;
  onState(fn: (s: ChatState) => void): void;
  onReset(fn: () => void): void;
  onSessionSaved(fn: (info: IpcEvents['session:saved']) => void): void;
}
