// 協調器:安排多個 AI 成員輪流發言、達成共識後分工執行、交叉審查、再修復一輪。
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { runTurn, getAdapter, effectiveCanEdit } from './adapters';
import { hasMarker, stripMarker, findMentions, parseAsk, stripAsk } from './shared';
import type { ParsedAsk } from './shared';
import { isPhaseInfo } from './ipc-types';
import type { Activity, AgentConfig, AttachmentMeta, ChatMessage, ChatState, PendingQuestion, PhaseInfo, QuestionAnswer, ToolAuditEntry } from './ipc-types';
import type { Adapter, RunAttachment, Stoppable } from './adapters/types';
import type { Store } from './store';
import { tx, resolveTextLocale, joinNames, quoteName } from './text';
import type { TextLocale } from './text';
import { RUNTIME_DIR, newConversationId, attachmentCapabilities, buildAttachmentPrompt, stageToCwd, clearRuntime, absolutePath } from './attachments';
import { FileToolSession } from './adapters/file-tools';

const AGREED = 'AGREED';
const NO_ISSUES = 'NO_ISSUES';
const ASK = 'ASK';
const MARK = (t: string) => `[${t}]`;
const EMIT_INTERVAL = 70; // 串流更新合併發送的間隔(ms),避免每個 token 都走一次 IPC
const ASK_TIMEOUT_MS = 5 * 60 * 1000; // 提問等多久算使用者不回答(結算成 defer,流程繼續)
const ASK_MAX_PER_SESSION = 3;  // 整個對話最多打斷使用者幾次;被節流掉的問題不計入
const ASK_MAX_ANSWER_CHARS = 2000; // 自由輸入的回答上限
const SEP = '\n\n';            // 對話紀錄各則之間的分隔
const TRUNCATE_RESERVE = 200;   // 截斷時為省略提示預留的字元空間
const MAX_GIT_FILES = 200;      // 總結提示裡最多列出的變更檔案數
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/; // 與 attachments 的目錄名規則一致
const MESSAGE_KINDS = new Set(['user', 'agent', 'system']);

// orchestrator 手上的訊息:pushMessage / restoreMessage 一定會補齊這些欄位
type LiveMessage = ChatMessage & { ts: number | string; status: string; text: string; thinking: string; activities: Activity[] };
type StagedAttachment = AttachmentMeta & { cwdPath: string };

interface TurnOptions {
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
}

interface TurnOutcome {
  // 已剝除 [ASK] 區塊的文字。所有下游流程(執行回報、審查、修復、總結)一律用這個,
  // 否則不能提問的階段寫出的 [ASK] 雖然介面看不到,仍會原樣送進下一個模型的提示詞。
  text: string;
  // 未經處理的原始輸出,只有 discussPhase 拿去餵 parseAsk
  raw: string;
  error: string | null;
  // 這一回合實際做了哪些檔案操作。沒有使用工具的 adapter 一律是空陣列。
  toolEvents: ToolAuditEntry[];
}

// 主持人輸出的分工;_agentId / _agentName 是比對成員後補上的欄位
interface Assignment {
  agent?: unknown;
  task?: string;
  _agentId?: string | null;
  _agentName?: string | null;
}

interface Plan {
  summary?: string;
  assignments: Assignment[];
}

interface ExecReport {
  agent: AgentConfig;
  task: string;
  report: string;
  error: string | null;
  // 這位成員在執行階段實際做了哪些檔案操作;沒有使用工具時是空陣列
  toolEvents?: ToolAuditEntry[];
}

interface ReviewPair {
  reviewer: AgentConfig;
  target: ExecReport;
}

interface Review extends ReviewPair {
  text: string;
  error: string | null;
}

interface Issue {
  agent: AgentConfig;
  task: string;
  notes: string[];
}

interface FixFailure {
  item: Issue;
  error: string | null;
}

interface FixOutcome {
  unresolved: Issue[];
  reviewFailed: Review[];
  fixFailed: FixFailure[];
}

interface SummaryInput extends Partial<FixOutcome> {
  failed?: ExecReport[];
  gitChanges?: string | null;
}

interface TranscriptEntry {
  text: string;
  pinned?: boolean;
}

type GitStatus = Map<string, string>;

class Orchestrator extends EventEmitter {
  store: Store;
  conversationId: string;
  attachments: AttachmentMeta[];
  staged: StagedAttachment[];
  attachmentsSeen: Set<string>;
  messages: LiveMessage[];
  sessions: Record<string, string>;
  lastSeen: Record<string, number>;
  procs: Set<Stoppable>;
  running: boolean;
  stopped: boolean;
  phase: PhaseInfo;
  taskStartIndex: number;
  taskCwd: string | null;
  directedQueue: Array<{ msg: LiveMessage; agentIds: string[] }>;
  emitTimers: Map<string, NodeJS.Timeout>;
  // ---------- 選項式提問 ----------
  // pendingQuestion 與 askResolve 一定同時有值或同時為 null:askResolve 是「還有人在等」的唯一判準,
  // settleQuestion() 把它清成 null 就等於 first-answer-wins,後到的回答/逾時/stop 都會被擋掉。
  pendingQuestion: PendingQuestion | null;
  askResolve: ((answer: QuestionAnswer) => void) | null;
  askTimer: NodeJS.Timeout | null;
  askCount: number;                        // 本對話已實際暫停過幾次(session 上限用)
  askRoundUsed: number | null;             // 本任務中已經觸發過提問的討論回合
  askLastRound: Record<string, number>;    // agentId -> 上次觸發提問的回合,用來擋連續兩回合

  constructor(store: Store) {
    super();
    this.store = store;
    // 附件要在「送出當下」就有歸屬,不能等任務結束寫 session 時才有 id
    this.conversationId = newConversationId();
    this.attachments = [];        // 本次任務的附件 metadata
    this.staged = [];             // 沙箱 CLI 用的工作目錄副本
    this.attachmentsSeen = new Set(); // 已經看過完整附件區塊的 agentId
    this.messages = [];
    this.sessions = {};   // agentId -> session id
    this.lastSeen = {};   // agentId -> 該成員上次發言時的訊息數
    this.procs = new Set();
    this.running = false;
    this.stopped = false;
    this.phase = { code: 'idle' };
    this.taskStartIndex = 0;
    this.taskCwd = null;          // 本次任務開始時的工作目錄;任務中途改設定也不影響暫存與清理
    this.directedQueue = [];      // 進行中用 @ 指定成員的訊息,任務結束前要確保對方有回覆
    this.emitTimers = new Map(); // msgId -> timer,串流更新的節流
    this.pendingQuestion = null;
    this.askResolve = null;
    this.askTimer = null;
    this.askCount = 0;
    this.askRoundUsed = null;
    this.askLastRound = {};
  }

  // ---------- 狀態與事件 ----------
  get config() { return this.store.get(); }
  get userDataDir() { return this.store.userDataDir; }
  // 系統訊息與提示詞跟著介面語言;回覆語言另由 settings.language 寫進系統提示
  get locale(): TextLocale { return resolveTextLocale(this.config.settings.uiLocale); }
  text(key: string, params: Record<string, string | number> = {}) { return tx(this.locale, key, params); }
  get agents() { return this.config.agents.filter((a) => a.enabled !== false); }
  get lead(): AgentConfig {
    const agents = this.agents;
    return agents.find((a) => a.id === this.config.settings.leadAgentId) || agents[0];
  }

  snapshot() {
    return {
      running: this.running,
      phase: this.phase,
      messages: this.messages,
      conversationId: this.conversationId,
      attachments: this.attachments,
      // 待答問題不進 session 紀錄,但一定要進 snapshot:renderer 重載時只靠即時事件就補不回卡片,
      // 流程還在等回答,使用者卻沒有地方可以回答。
      question: this.pendingQuestion,
    };
  }
  // phase 只帶 code 與參數,顯示文字由 renderer 依 uiLocale 組出。
  setPhase(phase: PhaseInfo) { this.phase = phase; this.emit('state', { running: this.running, phase }); }

  pushMessage(m: Partial<ChatMessage> & Pick<ChatMessage, 'kind'>): LiveMessage {
    const msg: LiveMessage = { id: crypto.randomUUID(), ts: Date.now(), status: 'done', text: '', thinking: '', activities: [], ...m };
    this.messages.push(msg);
    this.emit('message', msg); // 建立節點要立即送出,不節流
    return msg;
  }

  // flush = true 時立刻送出並取消排程中的更新(回合結束、狀態變更時使用)
  updateMessage(msg: LiveMessage, patch: Partial<LiveMessage>, flush = false) {
    Object.assign(msg, patch);
    this.emitMessage(msg, flush);
  }

  emitMessage(msg: LiveMessage, flush = false) {
    const timer = this.emitTimers.get(msg.id);
    if (flush) {
      if (timer) { clearTimeout(timer); this.emitTimers.delete(msg.id); }
      this.emit('message', msg);
      return;
    }
    if (timer) return; // 已有排程,合併到那一次送出(訊息物件是同一個參考,送的一定是最新狀態)
    this.emitTimers.set(msg.id, setTimeout(() => {
      this.emitTimers.delete(msg.id);
      this.emit('message', msg);
    }, EMIT_INTERVAL));
  }

  clearEmitTimers() {
    for (const t of this.emitTimers.values()) clearTimeout(t);
    this.emitTimers.clear();
  }

  system(text: string, extra: Partial<ChatMessage> = {}) { return this.pushMessage({ kind: 'system', text, ...extra }); }

  // ---------- 對外操作 ----------
  async userMessage(text: string, mode: string, attachments: AttachmentMeta[] = []) {
    // 有了新訊息,之前失敗的回合就不再是「最近一次」,前情與附件也不同了,不再提供重試
    this.clearRetryable();
    const list = Array.isArray(attachments) ? attachments : [];
    const mentioned = findMentions(text, this.agents);
    // metadata 跟著訊息走,歷史對話重開才看得到附件;絕不放 base64 內容
    const msg = this.pushMessage({
      kind: 'user',
      text,
      attachments: list,
      ...(mentioned.length ? { mentions: mentioned.map((a) => ({ id: a.id, name: a.name })) } : {}),
      // 閒置時的 @ 指定會開啟一次「只有被指定成員回覆」的任務,介面據此顯示階段分隔
      ...(mentioned.length && !this.running ? { directed: true } : {}),
    });
    if (list.length) {
      this.attachments = this.running ? [...this.attachments, ...list] : list;
      this.attachmentsSeen.clear(); // 有新附件就讓每位成員重新看到完整清單
      // 進行中追加的附件也要補進沙箱 CLI 的 cwd 暫存,不能只處理任務開始前的那一批。
      if (this.running) this.stageAttachments(this.agents, this.taskCwd || this.config.settings.workDir, list, false);
    } else if (!this.running) {
      this.attachments = [];
      this.attachmentsSeen.clear();
    }
    if (this.running) {
      // 進行中:訊息會在下一位成員發言時自動帶入;有 @ 指定時,任務結束前還沒輪到對方就補一次指定回覆
      if (mentioned.length) this.directedQueue.push({ msg, agentIds: mentioned.map((a) => a.id) });
      return msg;
    }
    const run = mentioned.length
      ? this.runExclusive(() => this.directedPhase(mentioned))
      : this.runTask(text, mode || this.config.settings.mode);
    run.catch((e: unknown) => this.system(this.text('sys.error', { message: e instanceof Error ? e.message : String(e) }), { level: 'error' }));
    return msg;
  }

  // ---------- 重試 ----------
  // 只開放給 @ 指定回覆。分工流程裡的回合失敗之後,流程已經往下走了(失敗的成果不進審查、
  // 總結會提到它),事後單獨重跑一個執行回合會繞過審查閘門與「尚未審查」標記——
  // 那正是這個產品最不能出錯的地方。指定回覆是單一回合,不牽涉後續階段,重跑是乾淨的。
  // 也只開放給最後一次任務裡的失敗:之後的訊息會改變前情與附件,重跑的就不是同一件事。
  async retry(messageId: string): Promise<{ ok: boolean; error?: string }> {
    if (this.running) return { ok: false, error: this.text('sys.retryBusy') };
    const idx = this.messages.findIndex((m) => m.id === messageId);
    const msg = this.messages[idx];
    const agent = msg && this.agents.find((a) => a.id === msg.agentId);
    if (!msg || !msg.retryable || !agent) return { ok: false, error: this.text('sys.retryNotAllowed') };
    let lastUser = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) if (this.messages[i].kind === 'user') { lastUser = i; break; }
    if (lastUser < 0 || idx < lastUser) return { ok: false, error: this.text('sys.retryNotAllowed') };
    this.clearRetryable();
    const run = this.runExclusive(async () => {
      // runExclusive 預設最後一則是使用者訊息;重試時要指回觸發這次指定的那一則,
      // 任務敘述才會被釘在對話紀錄裡,截斷時不會先丟掉。
      this.taskStartIndex = lastUser;
      await this.directedPhase([agent]);
    });
    run.catch((e: unknown) => this.system(this.text('sys.error', { message: e instanceof Error ? e.message : String(e) }), { level: 'error' }));
    return { ok: true };
  }

  // 一定要 flush:這是一次性的狀態改變,不是串流片段。沒 flush 的更新會排進計時器,
  // 而 runExclusive 結束時會清掉所有計時器——回合跑得比送出間隔快時(例如重試立刻成功),
  // 這筆更新就被丟掉,畫面上舊訊息的重試鍵永遠不會收起來。
  clearRetryable() {
    for (const m of this.messages) if (m.retryable) this.updateMessage(m, { retryable: false }, true);
  }

  // ---------- 選項式提問 ----------
  // 使用者按下選項 / 送出自由回答時,由 IPC 層原封不動轉進來。
  // id 驗證、內容正規化與 first-answer-wins 一律在這裡做,IPC 層不保留任何狀態。
  answerQuestion(answer: QuestionAnswer) {
    const q = this.pendingQuestion;
    if (!q || !answer || typeof answer !== 'object' || answer.id !== q.id) return;
    const valid = new Set(q.options.map((o) => o.id));
    const optionIds = (Array.isArray(answer.optionIds) ? answer.optionIds : []).filter((id) => valid.has(id));
    const text = typeof answer.text === 'string' ? answer.text.trim().slice(0, ASK_MAX_ANSWER_CHARS) : '';
    // 宣稱已回答卻兩者皆空,等同「你決定」,不要送一句空話回去干擾成員
    const answered = answer.decision === 'answered' && (optionIds.length > 0 || text.length > 0);
    this.settleQuestion(answered ? { id: q.id, optionIds, text, decision: 'answered' } : { id: q.id, decision: 'defer' });
  }

  // 回答、逾時、stop() 三條路徑唯一的收斂點。回傳是否真的由這次呼叫結算。
  settleQuestion(answer: QuestionAnswer): boolean {
    const resolve = this.askResolve;
    if (!resolve) return false; // 已經結算過,或本來就沒有人在等
    try {
      if (this.askTimer) clearTimeout(this.askTimer);
    } finally {
      // 先把狀態清乾淨再 resolve,等待端醒來時看到的一定是「沒有待答問題」
      this.askTimer = null;
      this.askResolve = null;
      this.pendingQuestion = null;
      this.emit('state', { running: this.running, phase: this.phase, question: null });
    }
    resolve(answer);
    return true;
  }

  // 節流規則(已定案):每回合最多一題、每對話最多三題、同一成員不得連續兩回合提問。
  canAsk(agent: AgentConfig, round: number) {
    if (this.stopped || this.askResolve) return false;
    if (this.askCount >= ASK_MAX_PER_SESSION) return false;
    if (this.askRoundUsed === round) return false;
    return this.askLastRound[agent.id] !== round - 1;
  }

  // 只由 discussPhase 呼叫(唯一循序執行的階段)。回傳是否真的暫停過流程。
  // 平行階段不呼叫這裡,所以「同時只有一個待答問題」是結構上的保證,不靠判斷式。
  async maybeAsk(agent: AgentConfig, text: string, round: number, maxRounds: number): Promise<boolean> {
    const parsed: ParsedAsk | null = parseAsk(text);
    // 被節流的問題不暫停也不計數;[ASK] 區塊已經在 turn() 裡從顯示文字剝掉了
    if (!parsed || !this.canAsk(agent, round)) return false;

    const question: PendingQuestion = {
      id: crypto.randomUUID(),
      agentId: agent.id,
      agentName: agent.name,
      question: parsed.question,
      options: parsed.options,
      allowFree: parsed.allowFree,
      expiresAt: Date.now() + ASK_TIMEOUT_MS,
    };
    this.askCount++;
    this.askRoundUsed = round;
    this.askLastRound[agent.id] = round;
    this.pendingQuestion = question;
    this.phase = { code: 'ask', names: [agent.name] };

    const answer = await new Promise<QuestionAnswer>((resolve) => {
      this.askResolve = resolve;
      this.askTimer = setTimeout(() => this.settleQuestion({ id: question.id, decision: 'defer' }), ASK_TIMEOUT_MS);
      // 進入等待狀態只送這一次;卡片與階段文字都由這則事件驅動
      this.emit('state', { running: this.running, phase: this.phase, question } as ChatState);
    });

    // 回答寫進對話紀錄,讓後面每一位成員都看得到,否則下一位會再問一次同樣的事
    if (!this.stopped) this.pushMessage({ kind: 'user', text: this.answerText(question, answer) });
    this.setPhase({ code: 'discuss', round, maxRounds });
    return true;
  }

  answerText(question: PendingQuestion, answer: QuestionAnswer) {
    const name = quoteName(this.locale, question.agentName);
    if (answer.decision !== 'answered') return this.text('sys.askDeferred', { name });
    const picked = (answer.optionIds || [])
      .map((id) => question.options.find((o) => o.id === id))
      .filter(Boolean)
      .map((o) => o!.label);
    const parts = [...picked, ...(answer.text ? [answer.text] : [])];
    return this.text('sys.askAnswered', { name, answer: parts.join('\n') });
  }

  // reset / 載入歷史對話時把提問狀態歸零。等待中的 promise 交給 settleQuestion 結算成 defer。
  clearAsk() {
    this.settleQuestion({ id: this.pendingQuestion?.id || '', decision: 'defer' });
    this.askCount = 0;
    this.askRoundUsed = null;
    this.askLastRound = {};
  }

  stop() {
    this.stopped = true;
    // 卡在等回答的流程一定要先放行,否則 runExclusive 會永遠停在 await,使用者只能重開 app
    this.settleQuestion({ id: this.pendingQuestion?.id || '', decision: 'defer' });
    for (const p of this.procs) { try { p.kill('SIGTERM'); } catch {} }
    // stop / app quit 不必等外部 CLI 真正退出才清附件副本。
    this.staged = [];
    clearRuntime(this.taskCwd || this.config.settings.workDir, this.conversationId);
  }

  reset() {
    this.stop();
    this.clearAsk();
    this.clearEmitTimers();
    // 舊對話的工作目錄暫存一定要清掉,不能留在使用者的 repo 裡
    clearRuntime(this.config.settings.workDir, this.conversationId);
    this.conversationId = newConversationId();
    this.attachments = [];
    this.staged = [];
    this.attachmentsSeen.clear();
    this.messages = [];
    this.sessions = {};
    this.lastSeen = {};
    this.taskStartIndex = 0;
    this.directedQueue = [];
    this.emit('reset');
    this.setPhase({ code: 'idle' });
  }

  // 載入歷史對話繼續討論。CLI 的 session 不會跟著紀錄保存,所以每位成員下一次發言時
  // 會收到(依上限截斷的)完整對話紀錄,而不是只有新訊息。
  loadConversation({ messages, conversationId }: { messages?: unknown; conversationId?: string | null } = {}) {
    if (this.running) throw new Error('目前仍在進行中,請先停止再載入歷史對話');
    // 待答問題不寫進 session,載入歷史對話時一律當成已經 defer
    this.clearAsk();
    this.clearEmitTimers();
    clearRuntime(this.config.settings.workDir, this.conversationId);
    this.conversationId = conversationId && CONVERSATION_ID.test(conversationId) ? conversationId : newConversationId();
    this.messages = (Array.isArray(messages) ? messages : []).filter((m) => m && typeof m === 'object').map((m) => restoreMessage(m, this.locale));
    this.attachments = [];
    this.staged = [];
    this.attachmentsSeen.clear();
    this.sessions = {};
    this.lastSeen = {};
    this.taskStartIndex = 0;
    this.directedQueue = [];
    this.stopped = false;
    this.setPhase({ code: 'idle' });
    return this.snapshot();
  }

  // ---------- 主流程 ----------
  async runTask(task: string, mode: string) {
    return this.runExclusive(async (agents, cwd) => {
      const agreed = await this.discussPhase(agents, task);
      if (this.stopped) return;
      if (mode === 'divide') {
        if (!agreed) this.system(this.text('sys.maxRoundsDivide', { max: this.config.settings.maxRounds }));
        const plan = await this.assignPhase(agents, task);
        if (this.stopped) return;
        // 分工失敗不該讓整場會議無聲中止。討論已經發生了,至少把它總結起來,
        // 否則使用者看完一輪完整討論只拿到一句「已中止」,成果全部丟掉。
        if (!plan) { await this.summaryPhase(task, 'discuss', {}); return; }
        const gitBefore = await gitStatus(cwd);
        // 審查要看的改動:工作目錄在執行前後的快照差異(見 snapshotDir)
        const snapBefore = await snapshotDir(cwd);
        // 大的工作目錄快照要花上一秒。這段時間按了停止,不能再啟動執行者——它們會照樣改檔
        if (this.stopped) return;
        const { reports, failed } = await this.executePhase(agents, plan);
        if (this.stopped) return;
        const gitAfter = await gitStatus(cwd);
        const gitChanges = describeGitChanges(gitBefore, gitAfter, this.locale);
        const changed = diffSnapshots(snapBefore, snapBefore && await snapshotDir(cwd));
        if (this.stopped) return;
        const reviews = await this.reviewPhase(agents, reports, changed, failed);
        if (this.stopped) return;
        this.markUnreviewed(reports, reviews);
        const fix = await this.fixPhase(reviews);
        if (this.stopped) return;
        await this.summaryPhase(task, 'divide', { failed, gitChanges, ...fix });
      } else {
        if (!agreed) this.system(this.text('sys.maxRoundsSummary', { max: this.config.settings.maxRounds }));
        await this.summaryPhase(task, 'discuss', {});
      }
    });
  }

  // 任務的共同外殼:檢查成員與工作目錄、暫存附件、結束時一定清理。
  // body(agents, cwd) 是實際流程(完整圓桌或 @ 指定回覆)。
  async runExclusive(body: (agents: AgentConfig[], cwd: string) => Promise<void>) {
    const agents = this.agents;
    if (agents.length === 0) { this.system(this.text('sys.noAgents'), { level: 'error' }); return; }
    const cwd = this.config.settings.workDir;
    try { fs.mkdirSync(cwd, { recursive: true }); } catch (e: any) { this.system(this.text('sys.cwdFailed', { cwd, message: e.message }), { level: 'error' }); return; }

    this.running = true;
    this.stopped = false;
    this.taskStartIndex = this.messages.length - 1; // user 訊息的位置
    this.taskCwd = cwd;
    this.directedQueue = [];
    // 回合編號每個任務都從 1 重新算,跨任務比對會誤判;三題上限是對話級的,不在這裡歸零
    this.askRoundUsed = null;
    this.askLastRound = {};
    this.stageAttachments(agents, cwd);
    try {
      await body(agents, cwd);
      if (!this.stopped) await this.answerDirectedQueue();
    } finally {
      this.running = false;
      this.clearEmitTimers();
      // 不論正常結束、出錯或被停止,工作目錄的附件副本都要當場刪掉
      this.unstageAttachments(cwd);
      this.taskCwd = null;
      this.directedQueue = [];
      if (this.stopped) this.system(this.text('sys.stopped'));
      this.setPhase({ code: 'idle' });
    }
  }

  // @ 指定:只有被指定的成員回覆;多人時平行執行
  async directedPhase(targets: AgentConfig[]) {
    // names 必須維持陣列:PhaseInfo.names 是 string[],顯示時的分隔符由 renderer 決定。
    const names = targets.map((a) => String(a.name));
    this.setPhase({ code: 'direct', names });
    const group = targets.length > 1 ? crypto.randomUUID() : null;
    await Promise.all(targets.map((agent) => this.turn(agent, this.directedPrompt(agent, targets), { phase: { code: 'direct' }, hideAgreed: true, group })));
  }

  // 進行中送出的 @ 指定訊息:被指定的成員若在那之後都沒發言過,任務結束前補一次指定回覆
  async answerDirectedQueue() {
    while (this.directedQueue.length && !this.stopped) {
      const { msg, agentIds } = this.directedQueue.shift()!;
      const at = this.messages.indexOf(msg);
      const spoke = new Set(this.messages.slice(at + 1).filter((m) => m.kind === 'agent').map((m) => m.agentId));
      const targets = this.agents.filter((a) => agentIds.includes(a.id) && !spoke.has(a.id));
      if (targets.length) await this.directedPhase(targets);
    }
  }

  directedPrompt(agent: AgentConfig, targets: AgentConfig[]) {
    const others = targets.filter((a) => a.id !== agent.id).map((a) => quoteName(this.locale, a.name));
    const cwd = this.taskCwd || this.config.settings.workDir;
    return [
      this.text('prompt.directed'),
      others.length ? this.text('prompt.directedOthers', { others: joinNames(this.locale, others) }) : this.text('prompt.directedAlone'),
      effectiveCanEdit(agent) ? this.text('prompt.directedCanEdit', { cwd }) : this.text('prompt.directedReadOnly'),
    ].join('\n');
  }

  // 沙箱型 CLI(capabilities.attachmentsNeedCwd)讀不到 userData 下的絕對路徑,
  // 只好在工作目錄放一份暫存副本。userData 仍是唯一權威來源。
  stageAttachments(agents: AgentConfig[], cwd: string, items: AttachmentMeta[] = this.attachments, reset = true) {
    if (reset) this.staged = [];
    if (!items.length) return;
    const needsCwd = agents.some((a) => attachmentCapabilities(getAdapter(a.cli)).needCwd);
    if (!needsCwd) return;
    const { staged, error } = stageToCwd(this.userDataDir, this.conversationId, cwd, items);
    this.staged = reset ? staged : [...this.staged, ...staged];
    if (error) this.system(this.text('sys.stageFailed', { error }), { level: 'warn' });
  }

  unstageAttachments(cwd: string) {
    this.staged = [];
    const r = clearRuntime(cwd, this.conversationId);
    if (!r.ok) this.system(this.text('sys.unstageFailed', { dir: RUNTIME_DIR, error: r.error }), { level: 'warn' });
  }

  // 階段一:輪流討論直到全員同意或到達回合上限
  async discussPhase(agents: AgentConfig[], task: string) {
    const maxRounds = Math.max(1, Number(this.config.settings.maxRounds) || 3);
    for (let round = 1; round <= maxRounds; round++) {
      this.setPhase({ code: 'discuss', round, maxRounds });
      let agreedCount = 0;
      for (const agent of agents) {
        if (this.stopped) return false;
        const { text, raw } = await this.turn(agent, this.discussPrompt(agent, task, round, maxRounds), { phase: { code: 'discuss', round, maxRounds } });
        // 提問只在討論階段成立:這裡是唯一循序執行的地方,不會有兩位成員同時搶待答狀態。
        // 只有這裡吃 raw,其餘流程一律用已剝除的 text。
        const asked = await this.maybeAsk(agent, raw, round, maxRounds);
        if (this.stopped) return false;
        // 只認「最後幾行、單獨成行」的標記,避免成員在內文中提到它就被誤判為同意
        // 反問使用者的成員這回合不算同意:他自己都還沒下結論
        if (!asked && hasMarker(text, AGREED)) agreedCount++;
      }
      if (agreedCount === agents.length) { this.system(this.text('sys.agreed', { round })); return true; }
    }
    return false;
  }

  // 階段二:主持人產生分工 JSON(用 A1/A2 短代號,避免模型抄錯 UUID 或名稱)
  async assignPhase(agents: AgentConfig[], task: string): Promise<Plan | null> {
    this.setPhase({ code: 'divide' });
    const lead = this.lead;
    const codes = new Map<string, AgentConfig>();
    agents.forEach((a, i) => codes.set(`A${i + 1}`, a));
    const roster = [...codes.entries()]
      .map(([code, a]) => this.text('prompt.rosterItem', { code, name: a.name, label: getAdapter(a.cli)?.label || a.cli, readonly: effectiveCanEdit(a) ? '' : this.text('prompt.rosterReadOnly') }))
      .join('\n');
    const prompt = [
      this.text('prompt.assign'),
      roster,
      '',
      this.text('prompt.assignNoOverlap'),
      this.text('prompt.assignCodes', { codes: joinNames(this.locale, [...codes.keys()]) }),
      this.text('prompt.assignJson'),
      this.text('prompt.assignExample'),
    ].join('\n');

    for (let attempt = 1; attempt <= 2; attempt++) {
      const { text, error } = await this.turn(lead, prompt, { phase: { code: 'divide' }, hideAgreed: true });
      if (this.stopped) return null;
      // 主持人整個回合就失敗(CLI 沒安裝、key 失效、逾時)時,輸出必然是空的。
      // 這種情況下報「格式無法解析」是誤診,會讓使用者去調整提示詞而不是去修設定。
      if (error) {
        this.system(this.text('sys.planLeadFailed', { name: lead.name }), { level: 'warn' });
        continue;
      }
      const plan = extractJson(text) as Plan | null;
      if (plan && Array.isArray(plan.assignments)) {
        for (const a of plan.assignments) {
          const target = resolveAgent(a.agent, codes, agents);
          a._agentId = target ? target.id : null;
          a._agentName = target ? target.name : null;
        }
        const matched = plan.assignments.filter((a) => a._agentId && a.task);
        const unmatched = plan.assignments.filter((a) => !a._agentId && a.task);
        if (unmatched.length) {
          this.system(
            this.text('sys.unmatched', { list: unmatched.map((a) => this.text('prompt.unmatchedItem', { agent: String(a.agent), task: a.task || '' })).join('\n') }),
            { level: 'warn' },
          );
        }
        if (matched.length) {
          const lines = matched.map((a) => this.text('prompt.planItem', { name: a._agentName || '', task: a.task || '' })).join('\n');
          this.system(this.text('sys.plan', { summary: plan.summary || '', lines }), { tag: 'plan' });
          return plan;
        }
        this.system(this.text('sys.planNoMatch'), { level: 'warn' });
      } else {
        this.system(this.text('sys.planUnparsable'), { level: 'warn' });
      }
    }
    this.system(this.text('sys.planFailed'), { level: 'error' });
    return null;
  }

  // 階段三:各成員平行執行自己的工作
  async executePhase(agents: AgentConfig[], plan: Plan): Promise<{ reports: ExecReport[]; failed: ExecReport[] }> {
    this.setPhase({ code: 'execute' });
    const cwd = this.taskCwd || this.config.settings.workDir;
    const group = crypto.randomUUID(); // 同一批平行發言,介面會並排顯示
    const jobs: Array<Promise<ExecReport>> = [];
    for (const agent of agents) {
      const mine = plan.assignments.filter((a) => a._agentId === agent.id && a.task);
      if (mine.length === 0) continue;
      const taskText = mine.map((a) => a.task).join('\n');
      const prompt = [
        this.text('prompt.execute', { cwd }),
        effectiveCanEdit(agent) ? this.text('prompt.executeCanEdit') : this.text('prompt.executeReadOnly'),
        this.text('prompt.executeReport'),
        '',
        taskText,
      ].join('\n');
      // 第一層閘門:確認有人能審查這次改動,才把寫檔工具交給模型。
      // 用全體啟用成員判斷(不是只看這次被分配到工作的人)——沒被分配工作的成員
      // 一樣能在審查階段擔任 reviewer,這與 pickReviewPairs 的行為一致。
      const fileToolsEnabled = effectiveCanEdit(agent) && hasQualifiedReviewer(agents, agent.id);
      jobs.push(
        this.turn(agent, prompt, { phase: { code: 'execute' }, hideAgreed: true, group, fileToolsEnabled })
          .then(({ text, error, toolEvents }) => ({ agent, task: taskText, report: text, error, toolEvents })),
      );
    }
    if (jobs.length === 0) { this.system(this.text('sys.nobodyAssigned'), { level: 'warn' }); return { reports: [], failed: [] }; }

    const all = await Promise.all(jobs);
    // 稽核紀錄緊接在執行結果之後寫進 transcript,審查者才能拿實際改動去對照成員的報告。
    // 用 system 訊息而不是偽裝成使用者發言:它是流程產生的事實,不是任何人說的話。
    for (const r of all) this.writeToolAudit(r.agent, r.toolEvents || []);
    const reports = all.filter((r) => !r.error && (r.report || '').trim());
    const failed = all.filter((r) => r.error || !(r.report || '').trim());
    if (failed.length) {
      this.system(
        this.text('sys.execFailed', { list: failed.map((f) => this.text('prompt.failedItem', { name: f.agent.name, error: f.error || this.text('sys.noReport') })).join('\n') }),
        { level: 'error' },
      );
    }
    return { reports, failed };
  }

  // 階段四:交叉審查
  // 兩份以上成果沿用執行者輪替;只有一份時由其他啟用成員(即使沒被分配到工作)擔任審查者,
  // 避免「一人執行、其他人只討論」的常見分工完全沒有品質關卡。
  async reviewPhase(agents: AgentConfig[], reports: ExecReport[], changed: string[] | null = null, failed: ExecReport[] = []): Promise<Review[]> {
    const pairs = pickReviewPairs(agents, reports);
    if (pairs.length === 0) {
      if (reports.length >= 1) this.system(this.text('sys.noReviewer'), { level: 'warn' });
      return [];
    }
    this.setPhase({ code: 'review' });
    const group = crypto.randomUUID();
    const cwd = this.taskCwd || this.config.settings.workDir;
    // 可能動過工作目錄的成員:有改檔權限的 CLI 成員(含執行失敗的,它可能改到一半),
    // 以及真的用工具改過檔的 API 成員。唯讀成員、沒改任何檔的 API 成員不算。
    const writers = [...reports, ...failed].filter((r) => effectiveCanEdit(r.agent)
      && (getAdapter(r.agent.cli)?.type !== 'openai' || ownPaths(r).size > 0));
    const jobs = pairs.map(({ reviewer, target }) => {
      // 審查的核心是「看到實際改動」。以前對每位審查者都說「請打開檔案確認」,但 API 與本機
      // 模型在審查時沒有任何工具,只看得到一行稽核摘要——它們只能審執行者自己寫的報告,
      // 或者像實際發生過的那樣,把工具呼叫當成文字寫出來假裝讀了檔。依審查者的能力給它
      // 看得到改動的方式,讓「請打開檔案」這句話對每一位都做得到。
      const access = reviewAccess(getAdapter(reviewer.cli));
      // API 成員只能透過檔案工具改檔,工具紀錄就是它全部的改動;CLI 成員直接動檔案,
      // 只能看工作目錄的差異,而那是所有成員改動的總和。
      const tracked = getAdapter(target.agent.cli)?.type === 'openai';
      const own = ownPaths(target);
      //   readonly  被審者沒有改檔權限:它的工作不會改動檔案,只審回報(別人的改動不列給它)
      //   listed    有清單
      //   untouched API 成員的工具紀錄裡沒有任何改檔
      //   none      工作目錄前後沒有差異(例如只做分析的任務)
      //   unknown   拿不到工作目錄快照(太大或讀不到)
      // 拿不到清單時不能照樣說「下面附上了內容」——後面什麼都沒有,審查者只能看報告下判斷,
      // 正是這個改動要防止的假審查。改成照實說,並要求它不要只憑報告宣告沒問題。
      const readOnlyTarget = !effectiveCanEdit(target.agent);
      const all = readOnlyTarget ? [] : tracked ? [...own] : reviewFiles(target, changed);
      const files = all.slice(0, REVIEW_FILES_MAX);
      const more = all.length - files.length;
      const state = readOnlyTarget ? 'readonly' : files.length > 0 ? 'listed' : tracked ? 'untouched' : changed === null ? 'unknown' : 'none';
      const opening = access === 'open' ? 'prompt.review' : ({
        readonly: 'prompt.reviewReadOnly',
        listed: access === 'inline' ? 'prompt.reviewInline' : 'prompt.reviewAttached',
        untouched: 'prompt.reviewUntouched',
        none: 'prompt.reviewNoChanges',
        unknown: access === 'inline' ? 'prompt.reviewInlineUnknown' : 'prompt.review',
      } as const)[state];
      const toolLine = access !== 'tool' ? null
        : state === 'listed' ? 'prompt.reviewReadTool' : state === 'unknown' ? 'prompt.reviewReadToolUnlisted' : 'prompt.reviewReadToolAny';
      const openLine = access !== 'open' ? null
        : state === 'none' ? 'prompt.reviewNoFilesChanged' : state === 'untouched' ? 'prompt.reviewUntouchedLine' : null;
      // 還有別人可能動過工作目錄時,差異是所有人的改動,分不出哪個檔案是誰改的:照實標明
      const shared = writers.some((r) => r !== target) && files.some((f) => !own.has(f));
      const list = [...files.map((f) => `- ${f}`), ...(more > 0 ? [this.text('git.more', { n: more })] : [])].join('\n');
      // 有工具的審查者也附上內容:範本支援工具不代表它選的模型支援,被拒時 adapter 會不帶工具重送
      const { text: content, omitted } = access !== 'open' && files.length ? this.inlineReviewContent(files, cwd) : { text: '', omitted: [] as string[] };
      const vars = { name: target.agent.name, mark: MARK(NO_ISSUES) };
      const lines: Array<string | null> = [
        this.text(opening, vars),
        toolLine ? this.text(toolLine, vars) : null,
        openLine ? this.text(openLine, vars) : null,
        '',
        this.text('prompt.reviewTask', { task: target.task }),
        '',
        this.text('prompt.reviewReport', { report: target.report }),
        files.length ? `\n${this.text(shared ? 'prompt.reviewFilesAll' : 'prompt.reviewFiles', { name: target.agent.name, list })}` : null,
        content ? `\n${content}` : null,
        // 清單最多 20 個,附內容最多 6 個、兩萬字:沒附上的要點名,不能讓審查者以為看到了全部
        omitted.length ? `\n${this.text('prompt.reviewOmitted', { list: omitted.map((f) => `- ${f}`).join('\n') })}` : null,
        // 判定規則放在最後:前面可能附了上萬字的檔案內容,規則寫在內容之前,模型讀完內容就忘了——
        // 實測本機模型會在指出錯誤之後照樣寫上 [NO_ISSUES],或把它接在句尾而不是單獨一行。
        '',
        this.text('prompt.reviewWhat'),
        this.text('prompt.reviewMark', { mark: MARK(NO_ISSUES) }),
      ];
      const prompt = lines.filter((line): line is string => line !== null).join('\n');
      return this.turn(reviewer, prompt, { phase: { code: 'review' }, hideAgreed: true, group, readOnlyFileTools: access === 'tool', ephemeral: content || undefined })
        .then(({ text, error }) => ({ reviewer, target, text, error }));
    });
    return Promise.all(jobs);
  }

  // 無法自行讀檔的審查者:用唯讀的檔案工具把內容讀出來附上。沿用同一層沙箱——
  // 不能讀 .git、不能經由符號連結逃出工作目錄、只收 UTF-8 文字、有大小上限——不另寫一套讀檔。
  // 回傳附上的內容,以及因為數量或長度上限而沒附上的檔案
  inlineReviewContent(files: string[], cwd: string): { text: string; omitted: string[] } {
    let session: FileToolSession;
    try { session = new FileToolSession(cwd, { readOnly: true }); } catch { return { text: '', omitted: files }; }
    let budget = REVIEW_INLINE_TOTAL_CHARS;
    const blocks: string[] = [];
    const omitted: string[] = [];
    for (const [i, file] of files.entries()) {
      if (i >= REVIEW_INLINE_FILES || budget <= 0) { omitted.push(file); continue; }
      const r = session.execute('read_file', { path: file, limit: Math.min(REVIEW_INLINE_FILE_CHARS, budget) });
      if (r.ok) {
        const content = r.content || '';
        budget -= content.length;
        blocks.push(this.text('prompt.reviewFileBlock', { path: file, content: r.truncated ? content + this.text('prompt.reviewTruncated') : content }));
      } else {
        // 刪掉的檔案也會落在這裡;讀不到的原因照實交給審查者
        blocks.push(this.text('prompt.reviewFileUnreadable', { path: file, error: r.error || '' }));
      }
    }
    return { text: blocks.length ? `${this.text('prompt.reviewContent')}\n${blocks.join('\n\n')}` : '', omitted };
  }

  // 把一位成員這回合的檔案操作寫成稽核訊息。
  // 沒有動到任何檔案就不寫,避免每個唯讀成員後面都掛一則空紀錄。
  writeToolAudit(agent: AgentConfig, events: ToolAuditEntry[]) {
    if (!Array.isArray(events) || events.length === 0) return;
    // read_file 不改變任何東西,列出來只會把審查者的注意力稀釋掉;失敗的讀取仍要留,
    // 因為那代表成員可能是在資訊不足的情況下做了修改。
    const shown = events.filter((e) => e.tool !== 'read_file' || !e.ok);
    if (shown.length === 0) return;
    const lines = shown.map((e) => {
      const head = `${e.ok ? '✓' : '✗'} ${e.tool} ${e.path || ''}`.trim();
      if (!e.ok) return `${head} — ${e.error || this.text('sys.toolUnknownError')}`;
      // 近似值要在審查者讀到的文字裡就講明,否則它會拿高估的數字當實際改動規模
      const counts = e.added != null || e.removed != null
        ? ` (+${e.added || 0}/-${e.removed || 0}${e.statsApproximate ? this.text('sys.toolStatsApprox') : ''})`
        : '';
      return `${head}${counts}${e.reason ? ` — ${e.reason}` : ''}`;
    });
    this.system(this.text('sys.toolAudit', { name: agent.name, list: lines.join('\n') }), {
      tag: 'tool-audit',
      toolAudit: shown,
      ...(shown.some((e) => !e.ok) ? { level: 'warn' } : {}),
    });
  }

  // 標記「這次改動沒有人看過」。
  //
  // 只有一位成員、或審查者自己也失敗時,交叉審查會靜默地不發生,而介面上看起來跟
  // 順利跑完一模一樣——使用者會把「跑完了」讀成「有人檢查過了」。可以改檔的執行者
  // 若沒有一份成功的他人審查,就在它的執行訊息上標出來,讓這件事無法被誤讀。
  //
  // 只針對允許改檔的成員:唯讀成員沒有改動,沒被審查也不構成風險。
  markUnreviewed(reports: ExecReport[], reviews: Review[]) {
    const reviewed = new Set(
      reviews
        // 審查失敗(逾時、崩潰、沒有輸出)不算審查過;這與 fixPhase 的判定一致
        .filter((rv) => !rv.error && (rv.text || '').trim() && rv.reviewer.id !== rv.target.agent.id)
        .map((rv) => rv.target.agent.id),
    );
    for (const report of reports) {
      if (!effectiveCanEdit(report.agent) || reviewed.has(report.agent.id)) continue;
      // 執行階段每位成員只發一次言,取最後一則即可
      const msg = [...this.messages].reverse().find(
        (m) => m.kind === 'agent' && m.agentId === report.agent.id && isPhaseInfo(m.phase) && m.phase.code === 'execute',
      );
      if (msg) this.updateMessage(msg as LiveMessage, { unreviewed: true }, true);
    }
  }

  // 階段五:修復回合(只跑一輪,讓被審查者修掉問題或說明不修的理由)
  // 回傳 { unresolved, reviewFailed, fixFailed },三種未閉環的情況都要讓總結看得到
  async fixPhase(reviews: Review[]): Promise<FixOutcome> {
    // 審查本身失敗(CLI 逾時、崩潰、沒有輸出)不能當成「沒問題」
    const reviewFailed = reviews.filter((rv) => rv.error || !(rv.text || '').trim());
    if (reviewFailed.length) {
      this.system(
        this.text('sys.reviewFailed', { list: reviewFailed.map((rv) => this.text('sys.reviewFailedItem', { reviewer: rv.reviewer.name, target: rv.target.agent.name, error: rv.error || this.text('sys.noReviewText') })).join('\n') }),
        { level: 'error' },
      );
    }

    const issues = new Map<string, Issue>(); // agentId -> { agent, task, notes }
    for (const rv of reviews) {
      if (rv.error || !(rv.text || '').trim()) continue;
      if (hasMarker(rv.text, NO_ISSUES)) continue; // 審查者明確表示沒問題
      const t = rv.target;
      const issue = issues.get(t.agent.id) || { agent: t.agent, task: t.task, notes: [] };
      issues.set(t.agent.id, issue);
      issue.notes.push(this.text('prompt.reviewNote', { reviewer: rv.reviewer.name, text: stripMarker(rv.text, NO_ISSUES) }));
    }
    if (issues.size === 0) {
      if (reviewFailed.length) this.system(this.text('sys.noSuccessfulReview'), { level: 'warn' });
      else if (reviews.length) this.system(this.text('sys.noIssues'));
      return { unresolved: [], reviewFailed, fixFailed: [] };
    }

    const unresolved: Issue[] = [];
    const jobs: Array<Promise<FixFailure>> = [];
    const group = crypto.randomUUID();
    for (const it of issues.values()) {
      if (!effectiveCanEdit(it.agent)) { unresolved.push(it); continue; }
      const prompt = [
        this.text('prompt.fix'),
        this.text('prompt.fixLast'),
        '',
        this.text('prompt.fixTask', { task: it.task }),
        '',
        this.text('prompt.fixNotes', { notes: it.notes.join('\n\n') }),
      ].join('\n');
      jobs.push(this.turn(it.agent, prompt, { phase: { code: 'repair' }, hideAgreed: true, group }).then(({ error }) => ({ item: it, error })));
    }

    if (unresolved.length) {
      this.system(
        this.text('sys.unresolved', { names: this.locale === 'en' ? joinNames('en', unresolved.map((u) => u.agent.name)) : unresolved.map((u) => u.agent.name).join('」、「') }),
        { level: 'warn' },
      );
    }

    let fixFailed: FixFailure[] = [];
    if (jobs.length) {
    this.setPhase({ code: 'repair' });
      const results = await Promise.all(jobs);
      // 修復本身也可能失敗(逾時、崩潰),那些問題等於沒修掉
      fixFailed = results.filter((r) => r.error);
      if (fixFailed.length) {
        this.system(
          this.text('sys.fixFailed', { list: fixFailed.map((r) => this.text('prompt.fixFailedItem', { name: r.item.agent.name, error: r.error || '' })).join('\n') }),
          { level: 'error' },
        );
      }
    }
    return { unresolved, reviewFailed, fixFailed };
  }

  // 階段六:主持人總結
  async summaryPhase(task: string, mode: string, { failed = [], unresolved = [], reviewFailed = [], fixFailed = [], gitChanges = null }: SummaryInput = {}) {
    this.setPhase({ code: 'summary' });
    const notes: string[] = [];
    if (failed.length) {
      notes.push(this.text('prompt.summary.failed', { list: failed.map((f) => this.text('prompt.summary.failedItem', { name: f.agent.name, error: f.error || this.text('sys.noReport') })).join('\n') }));
    }
    if (reviewFailed.length) {
      notes.push(this.text('prompt.summary.reviewFailed', { list: reviewFailed.map((rv) => this.text('prompt.summary.reviewFailedItem', { reviewer: rv.reviewer.name, target: rv.target.agent.name, error: rv.error || this.text('sys.noReviewText') })).join('\n') }));
    }
    if (fixFailed.length) {
      notes.push(this.text('prompt.summary.fixFailed', { list: fixFailed.map((r) => this.text('prompt.summary.fixFailedItem', { name: r.item.agent.name, error: r.error || '', notes: r.item.notes.join('\n') })).join('\n\n') }));
    }
    if (unresolved.length) {
      notes.push(this.text('prompt.summary.unresolved', { list: unresolved.map((u) => this.text('prompt.summary.unresolvedItem', { name: u.agent.name, notes: u.notes.join('\n') })).join('\n\n') }));
    }
    if (gitChanges) {
      notes.push(this.text('prompt.summary.git', { changes: gitChanges }));
    }
    const prompt = [
      mode === 'divide' ? this.text('prompt.summary.divide') : this.text('prompt.summary.discuss'),
      ...notes,
    ].join('\n\n');
    await this.turn(this.lead, prompt, { phase: { code: 'summary' }, hideAgreed: true });
  }

  // ---------- 提示詞 ----------
  // showAgreed:只有討論階段才需要共識標記的規則,其他階段提到它只會汙染提示詞
  systemPrompt(agent: AgentConfig, { showAgreed = true }: { showAgreed?: boolean } = {}) {
    const locale = this.locale;
    const others = joinNames(locale, this.agents.filter((a) => a.id !== agent.id).map((a) => quoteName(locale, a.name))) || this.text('prompt.system.noOthers');
    const lang = this.config.settings.language || '繁體中文';
    const rules = [
      this.text('prompt.system.rule1', { lang }),
      this.text('prompt.system.rule2'),
      this.text('prompt.system.rule3'),
    ];
    // showAgreed 同時也是「現在是討論階段」的判準:提問只在討論階段成立,
    // 在平行階段提到這個機制只會讓成員在不能提問的地方寫出 [ASK]。
    if (showAgreed) {
      rules.push(this.text('prompt.system.agreed', { mark: MARK(AGREED) }));
      rules.push(this.text('prompt.system.ask', { open: MARK(ASK), close: MARK('/' + ASK), max: ASK_MAX_PER_SESSION }));
    }
    rules.push(this.text('prompt.system.act'));
    return [
      this.text('prompt.system.intro', { name: agent.name, others }),
      this.text('prompt.system.persona', { persona: agent.persona || this.text('prompt.system.noPersona') }),
      this.text('prompt.system.rules'),
      ...rules,
    ].join('\n');
  }

  discussPrompt(agent: AgentConfig, task: string, round: number, maxRounds: number) {
    const first = this.lastSeen[agent.id] == null;
    const header = first ? this.text('prompt.task', { task }) : '';
    const tail = round === maxRounds
      ? this.text('prompt.discussLast', { mark: MARK(AGREED) })
      : this.text('prompt.discuss', { round, max: maxRounds, mark: MARK(AGREED) });
    return [header, tail].filter(Boolean).join('\n');
  }

  // 這位成員這回合實際拿得到的附件(沙箱 CLI 用工作目錄副本,其餘用 userData 權威路徑)
  attachmentsFor(adapter: Adapter | null): RunAttachment[] {
    if (!this.attachments.length) return [];
    const { needCwd } = attachmentCapabilities(adapter);
    const byId = new Map(this.staged.map((s) => [s.id, s]));
    return this.attachments.map((m) => ({
      ...m,
      path: needCwd ? (byId.get(m.id)?.cwdPath || null) : absolutePath(this.userDataDir, m),
    }));
  }

  // 可續接的成員只在第一次發言時收到完整附件區塊(含內嵌文字),之後靠 session 記憶;
  // 不可續接的成員每回合都要重送,否則下一輪就完全不知道有附件這回事。
  attachmentPrompt(agent: AgentConfig, adapter: Adapter | null, resumable: boolean) {
    if (!this.attachments.length) return '';
    const seen = this.attachmentsSeen.has(agent.id);
    if (seen && resumable) return '';
    this.attachmentsSeen.add(agent.id);
    const { needCwd } = attachmentCapabilities(adapter);
    return buildAttachmentPrompt(this.userDataDir, this.attachments, adapter, { staged: needCwd ? this.staged : [], locale: this.locale });
  }

  // 收集該成員尚未看到的訊息,組成「[名稱]: 內容」的紀錄
  // 不支援 resume 的成員(自訂 CLI、所有 OpenAI 相容 API)每回合都要重送全部紀錄,
  // 這裡要加上字元上限,否則長討論會直接撞上模型的 context 上限。
  unseenTranscript(agent: AgentConfig, current: LiveMessage) {
    const seen = this.lastSeen[agent.id];
    // 真的有 session 可以續接,才能只送新訊息。只看 adapter 支不支援續接不夠:
    // 回合失敗在建立 session 之前(例如 CLI 沒登入)時,CLI 手上什麼都沒有,
    // 只送新訊息等於讓成員失去整段前情——包括原本的任務。與 turn() 判斷續接的條件一致。
    const resumable = !!(getAdapter(agent.cli)?.supportsResume && this.sessions[agent.id]);
    // 可續接且發言過的成員只需要新訊息;第一次發言(含剛載入的歷史對話)要從頭看起
    const incremental = resumable && seen != null;
    const from = incremental ? seen : 0;
    const entries: TranscriptEntry[] = [];
    // 整段對話的第一個任務(載入歷史對話時就是原始任務)也要保留
    const firstUser = this.messages.findIndex((m) => m.kind === 'user');
    for (let i = from; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m === current || m.status === 'running') continue;
      // 任務敘述與分工結果是後面每一句話的前提,截斷時一定要保留
      if (m.kind === 'user') entries.push({ text: `[${this.text('transcript.user')}${mentionLabel(m, this.locale)}]:\n${m.text}`, pinned: i === this.taskStartIndex || i === firstUser });
      else if (m.kind === 'agent' && m.agentId !== agent.id && m.text) entries.push({ text: `[${m.agentName}]:\n${m.text}` });
      // 舊紀錄沒有 tag 欄位,退回比對當時的文案
      else if (m.kind === 'system' && m.level !== 'error' && (m.tag === 'plan' || m.text.startsWith('**分工結果**'))) entries.push({ text: `[${this.text('transcript.system')}]:\n${m.text}`, pinned: true });
      // 檔案工具的稽核紀錄:審查者一定要看得到成員實際改了什麼,
      // 否則它只能審報告文字,而報告文字可能與實際改動完全對不上。
      // pinned:這是審查的依據,截斷 transcript 時不能先丟掉它。
      else if (m.kind === 'system' && m.tag === 'tool-audit') entries.push({ text: `[${this.text('transcript.system')}]:\n${m.text}`, pinned: true });
    }
    if (entries.length === 0) return '';
    if (incremental) return entries.map((e) => e.text).join(SEP); // 只送新訊息,量本來就小
    return truncateTranscript(entries, Number(this.config.settings.maxTranscriptChars) || 0, this.locale);
  }

  // ---------- 執行一次發言 ----------
  // 回傳 { text, error };錯誤不再被吞掉,由上層決定是否影響流程
  async turn(agent: AgentConfig, instruction: string, { phase, hideAgreed = false, group = null, fileToolsEnabled = false, readOnlyFileTools = false, ephemeral }: TurnOptions = {}): Promise<TurnOutcome> {
    const startIdx = this.messages.length;
    const msg = this.pushMessage({ kind: 'agent', agentId: agent.id, agentName: agent.name, color: agent.color, cli: agent.cli, model: agent.model, phase, status: 'running', ...(group ? { group } : {}) });
    const transcript = this.unseenTranscript(agent, msg);
    const adapter = getAdapter(agent.cli);
    const resumable = !!(adapter?.supportsResume && this.sessions[agent.id]);
    const attachmentBlock = this.attachmentPrompt(agent, adapter, resumable);
    const prompt = [
      transcript ? (resumable ? this.text('transcript.new') : this.text('transcript.sofar')) + '\n' + transcript : '',
      attachmentBlock,
      instruction,
    ].filter(Boolean).join('\n\n');

    let text = '';
    const result = await runTurn(agent, {
      prompt,
      systemPrompt: this.systemPrompt(agent, { showAgreed: !hideAgreed }),
      sessionId: this.sessions[agent.id] || null,
      cwd: this.taskCwd || this.config.settings.workDir,
      locale: this.locale,
      fileToolsEnabled,
      readOnlyFileTools,
      ephemeral,
      // imageInline 型的 adapter 從這裡取實際影像;其餘 adapter 忽略即可
      attachments: attachmentBlock ? this.attachmentsFor(adapter) : [],
      onProc: (p) => { this.procs.add(p); p.on('close', () => this.procs.delete(p)); },
      onSession: (id) => { this.sessions[agent.id] = id; },
      onText: (t) => { text = t; this.updateMessage(msg, { text: t }); },
      onThinking: (t) => this.updateMessage(msg, { thinking: t }),
      onActivity: (a) => {
        const existing = msg.activities.find((x) => x.id === a.id);
        if (existing) Object.assign(existing, a); else msg.activities.push({ ...a });
        this.emitMessage(msg);
      },
    });
    if (result.sessionId) this.sessions[agent.id] = result.sessionId;
    text = result.text || text;
    const error = result.error || null;
    // 只有成功的回合才算「看過了」。失敗代表成員沒有真正收到這些內容,
    // 下一回合(或重試)必須重送,否則它會在不知道前情的狀況下回答。
    if (!error) this.lastSeen[agent.id] = startIdx;
    // 顯示、對話紀錄與所有下游提示詞都不留 [ASK] 區塊:問題由卡片呈現,留著會同一個問題出現兩次;
    // 被節流或非討論階段的 [ASK] 走同一條路徑剝掉,對成員來說就是「問了但沒被受理」。
    const display = stripAsk(text);
    this.updateMessage(msg, {
      text: display,
      thinking: result.thinking || msg.thinking,
      usage: result.usage,
      status: error ? 'error' : 'done',
      error,
      // 只有 @ 指定回覆可以重試,理由見 retry()
      ...(error && isPhaseInfo(phase) && phase.code === 'direct' ? { retryable: true } : {}),
    }, true); // 回合結束一定要 flush,不能讓最後一次更新卡在節流裡
    return { text: display, raw: text, error, toolEvents: toAuditEntries((result as { toolEvents?: unknown }).toolEvents) };
  }
}

// adapter 回傳的工具紀錄 → 稽核紀錄。
// 這裡是唯一會碰到 adapter 內部形狀的地方,刻意放在轉換層:file-tools 的欄位改名時
// 只需要改這一個函式,orchestrator 與介面看到的形狀不變。
function toAuditEntries(raw: unknown): ToolAuditEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((e: any) => {
    const r = e?.result || {};
    const entry: ToolAuditEntry = { tool: e?.name || '', ok: !!e?.ok };
    if (e?.path) entry.path = e.path;
    if (r.error) entry.error = r.error;
    // 寫入類工具回傳 newSha256;read_file 回傳 sha256(它就是之後寫入要帶的 expectedSha256)
    if (r.newSha256) entry.shaAfter = r.newSha256;
    else if (r.sha256) entry.shaAfter = r.sha256;
    if (r.shaBefore) entry.shaBefore = r.shaBefore;
    if (typeof r.added === 'number') entry.added = r.added;
    if (typeof r.removed === 'number') entry.removed = r.removed;
    // 近似旗標一定要跟著數字走。少了它,退化成整檔行數的統計看起來仍然精確,
    // 審查者會拿一個高估好幾個數量級的數字當事實。
    if (r.statsApproximate) entry.statsApproximate = true;
    if (typeof r.replacements === 'number') entry.replacements = r.replacements;
    if (r.reason) entry.reason = r.reason;
    if (r.replaced) entry.replaced = r.replaced;
    return entry;
  });
}

// 「[使用者 → @Codex]」:讓每位成員都看得出這則訊息指定給誰
function mentionLabel(m: ChatMessage, locale: TextLocale = 'zh-Hant') {
  const names = Array.isArray(m.mentions) ? m.mentions.map((x) => x && x.name).filter(Boolean) : [];
  return names.length ? ` → ${joinNames(locale, names.map((n) => `@${n}`))}` : '';
}

// 從紀錄還原訊息:補齊欄位;存檔時還在輸出中的訊息不可能再完成,標成中斷
function restoreMessage(m: any, locale: TextLocale = 'zh-Hant'): LiveMessage {
  const kind: ChatMessage['kind'] = MESSAGE_KINDS.has(m.kind) ? m.kind : 'system';
  const msg: LiveMessage = {
    ...m,
    id: typeof m.id === 'string' && m.id ? m.id : crypto.randomUUID(),
    kind,
    text: typeof m.text === 'string' ? m.text : String(m.text ?? ''),
    thinking: typeof m.thinking === 'string' ? m.thinking : '',
    activities: Array.isArray(m.activities) ? m.activities : [],
    status: m.status === 'error' ? 'error' : 'done',
  };
  if (m.status === 'running') { msg.status = 'error'; msg.error = m.error || tx(locale, 'sys.unfinishedOnSave'); }
  // 載入的歷史對話不提供重試:附件與 CLI 的 session 都已經跟當時不同,重跑的不是同一件事
  msg.retryable = false;
  return msg;
}

// ---------- 對話紀錄截斷 ----------
// 單則訊息本身就超過預算時就地裁尾,避免一則訊息吃掉整個額度
function clipEntry(text: string, max: number, locale: TextLocale) {
  const notice = tx(locale, 'transcript.clipped');
  if (text.length <= max) return text;
  if (max <= notice.length) return notice.slice(0, Math.max(0, max));
  return text.slice(0, max - notice.length) + notice;
}

// 把對話紀錄壓到 limit 字元以內。
// pinned(任務敘述、分工結果)與最新一則一定保留,其餘從新到舊盡量保留;
// 被裁掉的位置就地插入「已省略中間 N 則訊息」,不做靜默裁切。
// limit <= 0 視為不限制。
function truncateTranscript(entries: TranscriptEntry[], limit: number, locale: TextLocale = 'zh-Hant') {
  const omitNotice = (n: number) => tx(locale, 'transcript.omitted', { n });
  const texts = entries.map((e) => e.text);
  const full = texts.join(SEP);
  if (!Number.isFinite(limit) || limit <= 0 || full.length <= limit) return full;

  const budget = Math.max(0, limit - TRUNCATE_RESERVE);
  const last = entries.length - 1;
  // 最新一則等同釘選:成員至少要看得到上一位說了什麼
  const items = entries.map((e, i) => ({ pinned: !!e.pinned || i === last, text: e.text }));
  const cost = (t: string) => t.length + SEP.length;

  // 第一步:決定保留哪些。釘選的必留,其餘從最新往回補,遇到放不下的就停,
  // 保留一段連續的最近紀錄而不是零散幾則。
  const keep = new Array(items.length).fill(false);
  let used = 0;
  for (let i = 0; i < items.length; i++) if (items[i].pinned) { keep[i] = true; used += cost(items[i].text); }
  for (let i = items.length - 1; i >= 0; i--) {
    if (keep[i]) continue;
    if (used + cost(items[i].text) > budget) break;
    keep[i] = true;
    used += cost(items[i].text);
  }

  // 第二步:必留的部分本身就超過預算時(例如任務敘述與分工結果都很長),
  // 在所有保留項目之間做 max-min 公平分配再各自裁尾。
  // 不能讓排在前面的項目吃光額度,否則最後的整體裁切會把最新一則整個擠掉。
  const kept = items.map((_, i) => i).filter((i) => keep[i]);
  const allowance = allocateBudget(kept.map((i) => cost(items[i].text)), budget);
  const shown = new Map<number, string>();
  kept.forEach((i, k) => shown.set(i, clipEntry(items[i].text, Math.max(0, allowance[k] - SEP.length), locale)));

  const out: string[] = [];
  let dropped = 0;
  for (let i = 0; i < items.length; i++) {
    if (!keep[i]) { dropped++; continue; }
    if (dropped) { out.push(omitNotice(dropped)); dropped = 0; }
    out.push(shown.get(i)!);
  }
  if (dropped) out.push(omitNotice(dropped));

  const text = out.join(SEP);
  return text.length <= limit ? text : text.slice(0, limit); // 最後保險:絕不超過上限
}

// max-min 公平分配:需求小的先拿滿,省下來的額度再平分給還不夠的,
// 所以沒有任何一項會被歸零,總和也不會超過 budget。
function allocateBudget(costs: number[], budget: number) {
  const out: number[] = new Array(costs.length).fill(0);
  const order = costs.map((_, i) => i).sort((a, b) => costs[a] - costs[b]);
  let remaining = budget;
  let left = costs.length;
  for (const i of order) {
    const take = Math.min(costs[i], Math.floor(remaining / left));
    out[i] = take;
    remaining -= take;
    left--;
  }
  return out;
}

// ---------- 審查配對 ----------
// 兩份以上成果:每人審查下一位(環狀)。
// 只有一份:從其他啟用成員裡挑一位(優先有執行成果的),讓單人執行也有品質關卡。
// 整場只剩一名啟用成員時回空陣列,由呼叫端提示並略過。
// 「誰有資格審查 targetId 的改動」——合格條件只有一條:不是改動的本人。
//
// 這個判定是唯一的真相來源,執行前的工具閘門與執行後的 markUnreviewed 都用它。
// 兩邊各寫一套的話,就會出現「事前開了寫入工具、事後卻沒有人審」的縫隙,
// 而那正是使用者最不可能自己發現的一種失敗:畫面看起來跟順利跑完一模一樣。
function reviewerCandidates(agents: AgentConfig[] | null | undefined, targetId: string): AgentConfig[] {
  return (agents || []).filter((a) => a && a.id !== targetId);
}

// 這次改動有沒有人能審。執行前只知道「誰會執行」,還沒有 report,所以用 id 判斷。
function hasQualifiedReviewer(agents: AgentConfig[] | null | undefined, targetId: string): boolean {
  return reviewerCandidates(agents, targetId).length > 0;
}

function pickReviewPairs(agents: AgentConfig[] | null | undefined, reports: ExecReport[]): ReviewPair[] {
  if (!Array.isArray(reports) || reports.length === 0) return [];
  if (reports.length >= 2) {
    return reports.map((r, i) => ({ reviewer: r.agent, target: reports[(i + 1) % reports.length] }));
  }
  const target = reports[0];
  const executed = new Set(reports.map((r) => r.agent.id));
  // 與 hasQualifiedReviewer 共用同一組候選人;這裡只是再挑出優先順序
  // (先找也執行過的人,他讀過工作內容,審起來更有依據)
  const candidates = reviewerCandidates(agents, target.agent.id);
  const reviewer = candidates.find((a) => executed.has(a.id)) || candidates[0];
  return reviewer ? [{ reviewer, target }] : [];
}

// ---------- 審查者看得到改動的方式 ----------
const REVIEW_FILES_MAX = 20;
const REVIEW_INLINE_FILES = 6;
const REVIEW_INLINE_FILE_CHARS = 6000;
const REVIEW_INLINE_TOTAL_CHARS = 20000;
// 「檔案數 × 回報長度」的上限,約 0.1 秒內掃得完
const MENTION_SCAN_BUDGET = 50_000_000;

//   open   本身就能依路徑讀檔(Claude Code、Codex、Cursor 宣告了 filePath)
//   tool   OpenAI 相容端點且範本開了檔案工具:給唯讀的 read_file,內容也照樣附上
//   inline 兩者皆否:把改動檔案目前的內容直接附在提示詞裡
// 依能力分,不依品牌分:模型換版本很快,能力才是這一步真正需要知道的事。
function reviewAccess(adapter: Adapter | null | undefined): 'open' | 'tool' | 'inline' {
  if (!adapter) return 'inline';
  if (attachmentCapabilities(adapter).modes.has('filePath')) return 'open';
  // OpenAI 相容 adapter 的 supportsEdit 就等於「範本明確開啟了檔案工具,端點支援工具呼叫」
  if (adapter.type === 'openai' && adapter.supportsEdit) return 'tool';
  return 'inline';
}

// 這位成員自己用工具改過的檔案(精確)
function ownPaths(report: ExecReport): Set<string> {
  return new Set((report.toolEvents || [])
    .filter((e) => e.ok !== false && e.tool !== 'read_file' && e.path)
    .map((e) => String(e.path)));
}

// CLI 被審者要審的檔案:自己的工具紀錄(通常沒有)+ 工作目錄的差異。附內容有數量上限,
// 排前面的才看得到,所以任務或回報裡提到的排前面。其他成員工具紀錄裡的檔案不排除:
// CLI 成員可能也改了同一個檔案,排除掉就會把它的改動藏起來。
// 回傳完整清單;超過 REVIEW_FILES_MAX 的部分由呼叫端截掉並註明還有幾個。
function reviewFiles(target: ExecReport, changed: string[] | null): string[] {
  const own = ownPaths(target);
  const rest = (changed || []).filter((f) => !own.has(f));
  const said = `${target.task}\n${target.report}`;
  // 找「提到的檔案」是在主程序上同步做字串搜尋:成員一口氣產生十萬個檔案(例如 clone 一個 repo)
  // 又寫了長回報時,會把介面卡住好幾秒。超過工作量上限就不排序,照路徑順序列。
  if (rest.length * said.length > MENTION_SCAN_BUDGET) return [...own, ...rest];
  const hit = new Set(rest.filter((f) => said.includes(f) || (path.basename(f).length >= 3 && said.includes(path.basename(f)))));
  return [...own, ...rest.filter((f) => hit.has(f)), ...rest.filter((f) => !hit.has(f))];
}

// ---------- 工作目錄快照 ----------
// 審查要看的改動 = 執行階段前後,工作目錄裡大小或修改時間變了的檔案(含新增與刪除)。
// 直接看檔案,不經過 git。前幾版用 git status 前後比對,每一輪 code review 都再找到一個盲點:
// 不是 git repo(預設工作區就不是)、被 .gitignore 忽略、巢狀 repo、成員自己 commit、
// 任務前就改過的檔案、中文路徑被跳脫、工作目錄是子資料夾、改到工作目錄外面……
// 快照只看工作目錄本身,這些情況都不存在。只 stat 不讀內容而且非同步:十萬個檔案約 0.5 秒。
const SNAPSHOT_MAX_FILES = 100000;
// 版本控制、相依套件、框架快取與 app 自己的暫存:量大,也不是審查的對象。
// dist、build、vendor 這類名字不略過:有些專案的原始碼就放在裡面。
const SNAPSHOT_SKIP = new Set(['.git', '.hg', '.svn', 'node_modules', 'bower_components', '.venv', 'venv', '__pycache__', '.tox',
  '.next', '.nuxt', '.gradle', 'Pods', '.DS_Store', RUNTIME_DIR]);
// 依 Cache Directory Tagging 規範標記自己是快取的目錄(例如 Rust 的 target/)也略過
const CACHE_TAG = 'CACHEDIR.TAG';
type Snapshot = Map<string, string>;

// 相對路徑(以 / 分隔)→「大小:修改時間」。超過上限或工作目錄本身讀不到時回 null(拿不到),
// 不回一份不完整的快照假裝完整。讀不到的子資料夾直接略過:成員以同一個使用者身分執行,
// 那裡它一樣讀不到。符號連結不跟隨,避免繞出工作目錄或繞成迴圈。
async function snapshotDir(cwd: string, maxFiles = SNAPSHOT_MAX_FILES): Promise<Snapshot | null> {
  const out: Snapshot = new Map();
  let over = false;
  const walk = async (rel: string): Promise<void> => {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(rel ? path.join(cwd, rel) : cwd, { withFileTypes: true }); }
    catch (e) { if (!rel) throw e; return; }
    if (rel && entries.some((e) => e.name === CACHE_TAG && e.isFile())) return;
    const files: string[] = [];
    const dirs: string[] = [];
    for (const e of entries) {
      if (SNAPSHOT_SKIP.has(e.name)) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) dirs.push(child);
      else if (e.isFile()) files.push(child);
    }
    if (out.size + files.length > maxFiles) { over = true; return; }
    const stats = await Promise.all(files.map((f) => fs.promises.stat(path.join(cwd, f)).catch(() => null)));
    files.forEach((f, i) => { const st = stats[i]; if (st) out.set(f, `${st.size}:${st.mtimeMs}`); });
    for (const d of dirs) { if (over) return; await walk(d); }
  };
  try { await walk(''); } catch { return null; }
  return over ? null : out;
}

// 兩份快照都在才比得出來,任何一份拿不到就是拿不到
function diffSnapshots(before: Snapshot | null, after: Snapshot | null): string[] | null {
  if (!before || !after) return null;
  const out: string[] = [];
  for (const file of new Set([...before.keys(), ...after.keys()])) if (before.get(file) !== after.get(file)) out.push(file);
  return out.sort();
}

// ---------- git 變更 ----------
// 讀工作目錄的 git 變更;不是 git repo、找不到 git、逾時都安靜回 null,絕不影響主流程。
function gitStatus(cwd: string): Promise<GitStatus | null> {
  return new Promise((resolve) => {
    try {
      // --untracked-files=all:預設的 normal 模式會把整個未追蹤目錄收合成「?? dir/」,拿不到檔案清單
      // -z:以 NUL 分隔、完全不加引號或跳脫。預設輸出會把中文檔名轉成 "\345\255\220…" 這種
      // 八進位跳脫碼,拿去讀檔一定失敗;工作目錄是中文資料夾時,show-prefix 輸出的正常中文
      // 還會對不上那些跳脫碼,整批檔案都被丟掉。
      execFile('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        resolve(err ? null : parsePorcelain(stdout));
      });
    } catch { resolve(null); }
  });
}

// -z 格式:每筆是「XY 路徑」,以 NUL 結尾。改名/複製(X 或 Y 是 R、C)時,後面再跟一筆
// 原本的路徑——那一筆不是獨立的變更,要跳過(實測:「RM 新.md\0舊.md\0」)。
function parsePorcelainZ(text: string): GitStatus {
  const out: GitStatus = new Map();
  const fields = text.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const file = entry.slice(3);
    if (file) out.set(file, xy.trim());
    if (/[RC]/.test(xy)) i++; // 跳過緊接著的原路徑
  }
  return out;
}

// 「XY path」→ Map(path → status);rename 取新路徑。
// 兩種格式都收:-z(實際執行時用的,NUL 分隔、路徑原樣)與舊的換行格式(保留給既有呼叫端)。
function parsePorcelain(stdout: unknown): GitStatus {
  const text = String(stdout || '');
  if (text.includes('\0')) return parsePorcelainZ(text);
  const out: GitStatus = new Map();
  for (const line of String(stdout || '').split('\n')) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2).trim();
    let file = line.slice(3).trim();
    const arrow = file.indexOf(' -> ');
    if (arrow >= 0) file = file.slice(arrow + 4).trim();
    file = file.replace(/^"(.*)"$/, '$1');
    if (file) out.set(file, status);
  }
  return out;
}

// 執行前後的「檔名集合差集」不足以歸因:本來就是 M 的檔案再被改,前後仍然都是 M。
// 平行執行下也無法把變更歸給某一位成員。因此只回報執行結束時的工作區狀態,
// 並標出哪些檔案在執行前就已經是變更狀態,讓總結不會過度宣稱。
// 附件暫存目錄是本 app 自己放的,不是成員改的檔案,一定要從變更報告排除,
// 否則使用者上傳的圖會被當成「執行階段產生的變更」。
// 比對路徑的每一段,不只開頭:工作目錄是 repo 的子資料夾時,porcelain 給的是
// 「sub/.roundtable-runtime/…」,只看開頭的話總結會把 app 自己的附件暫存列成成員的改動。
const isRuntimePath = (file: string) => file.split('/').includes(RUNTIME_DIR);

function describeGitChanges(before: GitStatus | null, after: GitStatus | null, locale: TextLocale = 'zh-Hant') {
  if (!after || after.size === 0) return null;
  const visible = [...after].filter(([file]) => !isRuntimePath(file));
  if (visible.length === 0) return null;
  const lines: string[] = [];
  for (const [file, status] of visible) {
    // -uall 展開未追蹤目錄後檔案數可能很多(例如工作目錄沒有 .gitignore),不能讓清單灌爆總結提示
    if (lines.length >= MAX_GIT_FILES) { lines.push(tx(locale, 'git.more', { n: visible.length - MAX_GIT_FILES })); break; }
    const pre = before && before.has(file);
    lines.push(`- \`${status || '??'}\` ${file}${pre ? tx(locale, 'git.preexisting') : ''}`);
  }
  return lines.join('\n');
}

// ---------- JSON 解析 ----------
// 從 start 的「{」往後找到配對的「}」,會正確跳過字串內的括號與跳脫字元
function matchBrace(s: string, start: number) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// 掃描出所有「括號平衡」的候選片段逐一嘗試,模型在 JSON 前後多寫說明文字也不會壞
function extractJson(text: unknown): any {
  if (!text) return null;
  const s = String(text).replace(/```(?:json)?/gi, '');
  const candidates: string[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    const end = matchBrace(s, i);
    if (end > i) candidates.push(s.slice(i, end + 1));
  }
  candidates.sort((a, b) => b.length - a.length); // 外層物件優先
  const parsed: any[] = [];
  for (const c of candidates) {
    try {
      const o = JSON.parse(c);
      if (o && typeof o === 'object' && !Array.isArray(o)) parsed.push(o);
    } catch {}
  }
  return parsed.find((o: any) => Array.isArray(o.assignments)) || parsed[0] || null;
}

// ---------- 成員比對 ----------
const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/\s+/g, '').replace(/[「」『』"'`【】\[\]()()]/g, '');

// 先比對 A1/A2 代號,再退回正規化後的名稱,最後才做寬鬆的包含比對
function resolveAgent(token: unknown, codes: Map<string, AgentConfig>, agents: AgentConfig[]): AgentConfig | null {
  const raw = String(token ?? '').trim();
  if (!raw) return null;
  const byCode = codes.get(raw.toUpperCase());
  if (byCode) return byCode;
  const n = norm(raw);
  if (!n) return null;
  for (const [code, a] of codes) if (norm(code) === n) return a;
  const exact = agents.find((a) => norm(a.name) === n);
  if (exact) return exact;
  if (n.length < 2) return null;
  return agents.find((a) => {
    const an = norm(a.name);
    return an.length >= 2 && (an.includes(n) || n.includes(an));
  }) || null;
}

export { Orchestrator, truncateTranscript, pickReviewPairs, parsePorcelain, describeGitChanges, snapshotDir, diffSnapshots, extractJson, resolveAgent };
