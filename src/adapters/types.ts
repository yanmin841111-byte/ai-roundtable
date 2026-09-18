// 轉接器介面:內建轉接器、JSON 擴充與 JS 外掛最後都整理成 Adapter,
// orchestrator 與主程序只透過這份介面使用它們。

import type { ChildProcess } from 'child_process';
import type { Activity, AgentConfig, AttachmentMeta, CliStatus, Model } from '../ipc-types';
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
}

// 轉接器自己回報的結果;欄位都可以省略,usage 是各家原始格式
export interface RunResult {
  text?: string;
  thinking?: string;
  sessionId?: string | null;
  usage?: unknown;
  error?: string | null;
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
  toolEvents?: FileToolTranscriptEntry[];
}

export interface Adapter {
  id: string;
  label: string;
  type: AdapterType;
  description?: string;
  bin?: string | null;
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
  check?(): Promise<CliStatus>;
  testConnection?(): Promise<CliStatus>;
  run(agent: AgentConfig, ctx: RunContext): Promise<RunResult>;
}

export interface RegisteredAdapter extends Adapter {
  origin: 'builtin' | 'user';
  file?: string;
}
