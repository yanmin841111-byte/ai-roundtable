// 協調器各階段之間傳遞的資料形狀(執行回報、審查、修復結果、對話紀錄)
import type { Activity, AgentConfig, AttachmentMeta, ChatMessage, PhaseInfo, ReviewInfo, ToolAuditEntry } from '../ipc-types';

// orchestrator 手上的訊息:pushMessage / restoreMessage 一定會補齊這些欄位
export type LiveMessage = ChatMessage & { ts: number | string; status: string; text: string; thinking: string; activities: Activity[] };
export type StagedAttachment = AttachmentMeta & { cwdPath: string };

export interface TurnOptions {
  phase?: PhaseInfo;
  hideAgreed?: boolean;
  group?: string | null;
  // 允許這一回合使用寫檔工具。只有執行階段、且確認有人能審查這次改動時才會是 true。
  // adapter 端還有兩層把關(範本啟用 fileTools、成員 canEdit),三層都成立才會把工具送給模型。
  fileToolsEnabled?: boolean;
  // 只給唯讀的 read_file(審查回合)。讀取不改變任何東西,不需要改檔權限也不需要 reviewer 閘門。
  readOnlyFileTools?: boolean;
  // instruction 裡只有這一回合需要的一段(審查時附上的檔案內容)。會照常送出,
  // 但 API 成員存對話記憶時換成一行說明,否則之後每回合都會重送這幾萬字。
  ephemeral?: string;
  // 交叉審查回合:寫進訊息,回合結束時補上結論
  review?: ReviewInfo;
}

export interface TurnOutcome {
  // 已剝除 [ASK] 區塊的文字。所有下游流程(執行回報、審查、修復、總結)一律用這個,
  // 否則不能提問的階段寫出的 [ASK] 雖然介面看不到,仍會原樣送進下一個模型的提示詞。
  text: string;
  // 未經處理的原始輸出,只有 discussPhase 拿去餵 parseAsk
  raw: string;
  error: string | null;
  // 這一回合實際做了哪些檔案操作。沒有使用工具的 adapter 一律是空陣列。
  toolEvents: ToolAuditEntry[];
  // 這一回合在時間線上的訊息
  id: string;
}

// 主持人輸出的分工;_agentId / _agentName 是比對成員後補上的欄位
export interface Assignment {
  agent?: unknown;
  task?: string;
  _agentId?: string | null;
  _agentName?: string | null;
}

export interface Plan {
  summary?: string;
  assignments: Assignment[];
}

export interface ExecReport {
  agent: AgentConfig;
  task: string;
  report: string;
  error: string | null;
  // 這位成員在執行階段實際做了哪些檔案操作;沒有使用工具時是空陣列
  toolEvents?: ToolAuditEntry[];
}

export interface ReviewPair {
  reviewer: AgentConfig;
  target: ExecReport;
}

export interface Review extends ReviewPair {
  text: string;
  error: string | null;
}

export interface Issue {
  agent: AgentConfig;
  task: string;
  notes: string[];
}

export interface FixFailure {
  item: Issue;
  error: string | null;
}

export interface FixOutcome {
  unresolved: Issue[];
  reviewFailed: Review[];
  fixFailed: FixFailure[];
}

export interface SummaryInput extends Partial<FixOutcome> {
  failed?: ExecReport[];
  gitChanges?: string | null;
}

export interface TranscriptEntry {
  text: string;
  pinned?: boolean;
}

export type GitStatus = Map<string, string>;
