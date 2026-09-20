// 轉接器介面:內建轉接器、JSON 擴充與 JS 外掛最後都整理成 Adapter,
// orchestrator 與主程序只透過這份介面使用它們。

import type { ChildProcess } from 'child_process';
import type { Activity, AgentConfig, AttachmentMeta, CliStatus, EnvFix, Model, ModelCapability } from '../ipc-types';
import type { NormalizedUsage } from '../usage';
import type { StopHandle } from './process';
import type { FileToolTranscriptEntry } from './file-tools';
import type { TextLocale } from '../text';

export type AdapterType = 'builtin' | 'cli' | 'openai' | 'js';

export interface AdapterCapabilities {
  attachments: string[];
  attachmentsNeedCwd: boolean;
}

// listModels() 的回傳:source 說明清單從哪裡來(config、api、cache、fallback、loading、error…)
export interface ModelList {
  models: Model[] | null;
  source: string;
  error?: string | null;
}

// 可以被停止的執行單位:本機行程,或 API 轉接器用 createStopHandle 做的把手
export type Stoppable = ChildProcess | StopHandle;

// 附件在執行當下的樣子:path 是這位成員讀得到的絕對路徑(沙箱型 CLI 是工作目錄裡的副本)
export type RunAttachment = AttachmentMeta & { path: string | null };

export interface TurnCallbacks {
  onText(fullText: string): void;
  onThinking(fullText: string): void;
  onActivity(activity: Activity): void;
  onSession(id: string): void;
  onProc(handle: Stoppable): void;
}

export interface RunContext extends TurnCallbacks {
  locale?: TextLocale;
  prompt: string;
  systemPrompt?: string;
  sessionId?: string | null;
  cwd: string;
  timeoutMs?: number;
  attachments?: RunAttachment[];
  // 只有 orchestrator 確認 divide 流程有另一位 reviewer 時才設為 true。
  // adapter 規格與成員 canEdit 即使都開啟，缺這個閘門仍不會把寫入工具送給模型。
  fileToolsEnabled?: boolean;
  // 只給 read_file(審查回合用)。與 fileToolsEnabled 分開:讀取不需要改檔權限,也不需要 reviewer 閘門。
  readOnlyFileTools?: boolean;
  // prompt 裡只有這一回合需要的一段(原封不動包含在 prompt 裡)。照常送出;
  // 自己保存對話記憶的 adapter 存檔時要換成一行說明,不然之後每回合都會重送。
  ephemeral?: string;
}

// 轉接器自己回報的結果;欄位都可以省略,usage 是各家原始格式
export interface RunResult {
  text?: string;
  thinking?: string;
  sessionId?: string | null;
  usage?: unknown;
  error?: string | null;
  // 這次失敗是環境問題時(沒登入、沒裝、連不上),照做就能修好的下一步。
  // 轉接器知道原因時自己填;沒填的話 runTurn 會再問一次健康檢查補上。
  fix?: EnvFix;
  // 下一輪由 orchestrator 寫入 transcript，讓 reviewer 看得到成功與失敗的工具紀錄。
  toolEvents?: FileToolTranscriptEntry[];
}

// runTurn 補齊欄位、正規化 usage 之後的結果
export interface TurnResult {
  text: string;
  thinking: string;
  sessionId: string | null;
  usage: NormalizedUsage | null;
  error: string | null;
  fix?: EnvFix;
  toolEvents?: FileToolTranscriptEntry[];
}

export interface Adapter {
  id: string;
  label: string;
  type: AdapterType;
  description?: string;
  bin?: string | null;
  // 安裝/設定說明頁。這個 CLI 或服務不在時,介面把它當成「可照做的下一步」顯示,
  // 不在 app 裡寫死安裝指令(各家的安裝方式會變)。
  docsUrl?: string;
  // 能否用 sessionId 續接;不能時每回合會送完整對話紀錄
  supportsResume: boolean;
  // 能否修改檔案 / 執行指令;不能時成員的「允許修改檔案」無效
  supportsEdit: boolean;
  usesCustomCommand?: boolean;
  // 手動輸入模型時可選的強度
  efforts: string[];
  // 沒宣告時交給 usage.ts 依欄位特徵判斷
  usageShape?: string | null;
  // 沒宣告時 attachmentCapabilities 依 supportsEdit 推斷
  capabilities?: AdapterCapabilities;
  listModels?(): ModelList;
  refreshModels?(): Promise<unknown>;
  // locale:健康檢查的錯誤訊息會顯示在設定畫面,要跟著介面語言。檢查時沒有 RunContext,所以另外傳。
  check?(opts?: { locale?: TextLocale }): Promise<CliStatus>;
  testConnection?(): Promise<CliStatus>;
  // OpenAI 相容 adapter:成員設定的模型名稱 → 實際送出的模型 id(沒指定時是範本預設值)
  resolveModel?(model: string): string;
  // OpenAI 相容 adapter 的端點;模型能力的快取依它區分
  endpoint?: string;
  // OpenAI 相容 adapter:查模型能力。live 為 true 才送出實際的對話請求(付費 API 會產生費用)
  modelCapability?(model: string, opts?: { live?: boolean }): Promise<ModelCapability | null>;
  run(agent: AgentConfig, ctx: RunContext): Promise<RunResult>;
}

export interface RegisteredAdapter extends Adapter {
  origin: 'builtin' | 'user';
  file?: string;
}
