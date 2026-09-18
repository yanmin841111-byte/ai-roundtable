// 協調器:安排多個 AI 成員輪流發言、達成共識後分工執行、交叉審查、再修復一輪。
import { EventEmitter } from 'events';
import fs from 'fs';
import crypto from 'crypto';
import { runTurn, getAdapter, effectiveCanEdit, knownCapability } from './adapters';
import { hasMarker, stripMarker, findMentions, parseAsk, stripAsk } from './shared';
import type { ParsedAsk } from './shared';
import { isPhaseInfo } from './ipc-types';
import type { AgentConfig, AttachmentMeta, ChatMessage, ChatState, PendingQuestion, PhaseInfo, QuestionAnswer, ReviewInfo, TaskOutcome, TaskSummary, ToolAuditEntry } from './ipc-types';
import type { Adapter, RunAttachment, Stoppable } from './adapters/types';
import type { Store } from './store';
import { tx, resolveTextLocale, joinNames, quoteName } from './text';
import type { TextLocale } from './text';
import { RUNTIME_DIR, newConversationId, attachmentCapabilities, buildAttachmentPrompt, stageToCwd, clearRuntime, absolutePath } from './attachments';
import { FileToolSession } from './adapters/file-tools';
import { snapshotDir, diffSnapshots } from './snapshot';
import { captureBaseline, changesSince } from './task-changes';
import type { TaskBaseline } from './task-changes';
import type { LiveMessage, StagedAttachment, TurnOptions, TurnOutcome, Plan, ExecReport, Review, Issue, FixFailure, FixOutcome, SummaryInput, TranscriptEntry } from './flow/types';
import { SEP, truncateTranscript } from './flow/transcript';
import { NO_ISSUES, hasQualifiedReviewer, pickReviewPairs, REVIEW_FILES_MAX, REVIEW_INLINE_FILES, REVIEW_INLINE_FILE_CHARS, REVIEW_INLINE_TOTAL_CHARS, reviewAccess, withoutImages, reviewVerdict, ownPaths, reviewFiles } from './flow/review';
import { TASK_SUMMARY_FILES, taskSummaryText } from './flow/task-summary';
import { toAuditEntries, mentionLabel, restoreMessage } from './flow/messages';
import { gitStatus, parsePorcelain, describeGitChanges } from './flow/git';
import { extractJson, resolveAgent } from './flow/plan';

const AGREED = 'AGREED';
const ASK = 'ASK';
const MARK = (t: string) => `[${t}]`;
const EMIT_INTERVAL = 70; // 串流更新合併發送的間隔(ms),避免每個 token 都走一次 IPC
const ASK_TIMEOUT_MS = 5 * 60 * 1000; // 提問等多久算使用者不回答(結算成 defer,流程繼續)
const ASK_MAX_PER_SESSION = 3;  // 整個對話最多打斷使用者幾次;被節流掉的問題不計入
const ASK_MAX_ANSWER_CHARS = 2000; // 自由輸入的回答上限
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/; // 與 attachments 的目錄名規則一致

class Orchestrator extends EventEmitter {
  store: Store;
  conversationId: string;
  attachments: AttachmentMeta[];
  staged: StagedAttachment[];
  attachmentsSeen: Set<string>;
  messages: LiveMessage[];
  sessions: Record<string, string>;
  // 工作目錄不是 git repo 時,最近一次任務開始前的檔案內容。「檔案改動」拿它比對;只在記憶體,不寫檔
  taskBaseline: TaskBaseline | null;
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
    this.taskBaseline = null;
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

  // 結果卡:誰做完了、審查結論、改了哪些檔案、花了多少時間與 token。
  // 這些資料原本散在整條對話裡;任務結束時整理成一張卡。只給人看,不進給模型的會議紀錄。
  async pushTaskSummary({ startedAt, startIndex, reports, failed, reviews, fix, baseline }: {
    startedAt: number; startIndex: number; reports: ExecReport[]; failed: ExecReport[]; reviews: Review[]; fix: FixOutcome; baseline: TaskBaseline | null;
  }) {
    const unresolved = new Set([...fix.unresolved.map((u) => u.agent.id), ...fix.fixFailed.map((f) => f.item.agent.id)]);
    const outcomeOf = (report: ExecReport): TaskOutcome => {
      if (failed.includes(report)) return 'failed';
      const verdicts = reviews.filter((rv) => rv.target.agent.id === report.agent.id).map((rv) => reviewVerdict(rv.text, rv.error));
      if (verdicts.includes('issues')) return unresolved.has(report.agent.id) ? 'unresolved' : 'repaired';
      return verdicts.includes('pass') ? 'approved' : 'unreviewed';
    };
    const members = [...reports, ...failed].map((r) => ({
      name: r.agent.name,
      color: r.agent.color,
      outcome: outcomeOf(r),
      reviewers: reviews.filter((rv) => rv.target.agent.id === r.agent.id).map((rv) => rv.reviewer.name),
    }));
    let files: TaskSummary['files'] = [];
    let moreFiles = 0;
    if (baseline) {
      const diff = await changesSince(baseline);
      if (diff.ok) {
        files = diff.files.slice(0, TASK_SUMMARY_FILES).map((f) => ({ path: f.path, status: f.status, added: f.added, removed: f.removed }));
        moreFiles = diff.totalFiles - files.length;
      }
    }
    const turns = this.messages.slice(startIndex).filter((m) => m.kind === 'agent' && m.status !== 'running');
    const measured = turns.filter((m) => m.usage);
    const sum = (key: 'inputTokens' | 'outputTokens' | 'costUsd') => measured.reduce((n, m) => n + (Number(m.usage?.[key]) || 0), 0);
    const hasCost = measured.some((m) => typeof m.usage?.costUsd === 'number');
    const summary: TaskSummary = {
      startedAt,
      endedAt: Date.now(),
      members,
      files,
      moreFiles,
      usage: { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), costUsd: hasCost ? sum('costUsd') : null, turns: turns.length, turnsWithUsage: measured.length },
    };
    this.system(taskSummaryText(summary, this.locale), { tag: 'task-summary', taskSummary: summary });
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
        const startedAt = Date.now();
        const startIndex = this.messages.length;
        const gitBefore = await gitStatus(cwd);
        // 審查要看的改動:工作目錄在執行前後的快照差異(見 snapshotDir)
        const snapBefore = await snapshotDir(cwd);
        // 記下任務開始前的檔案內容(見 task-changes.ts):結果卡用它列出「這次任務」改了什麼。
        // 不是 git repo 時,「檔案改動」也靠它比對;是 git repo 的話,那邊照舊相對上一次 commit。
        const baseline = snapBefore ? await captureBaseline(cwd, snapBefore) : null;
        if (!gitBefore) this.taskBaseline = baseline;
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
        if (this.stopped) return;
        await this.pushTaskSummary({ startedAt, startIndex, reports, failed, reviews, fix, baseline });
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
      const { text, error, id } = await this.turn(lead, prompt, { phase: { code: 'divide' }, hideAgreed: true });
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
          // 分工結果已經以卡片呈現,主持人那則原文(JSON)在介面上收起來
          const source = this.messages.find((m) => m.id === id);
          if (source) this.updateMessage(source, { rawPlan: true }, true);
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
      const access = reviewAccess(getAdapter(reviewer.cli), reviewer);
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
      const { text: content, omitted, unreadable } = access !== 'open' && files.length ? this.inlineReviewContent(files, cwd) : { text: '', omitted: [] as string[], unreadable: [] as string[] };
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
      const review: ReviewInfo = { target: target.agent.name, access, scope: state, files, more, omitted, unreadable };
      return this.turn(reviewer, prompt, { phase: { code: 'review' }, hideAgreed: true, group, readOnlyFileTools: access === 'tool', ephemeral: content || undefined, review })
        .then(({ text, error }) => ({ reviewer, target, text, error }));
    });
    return Promise.all(jobs);
  }

  // 無法自行讀檔的審查者:用唯讀的檔案工具把內容讀出來附上。沿用同一層沙箱——
  // 不能讀 .git、不能經由符號連結逃出工作目錄、只收 UTF-8 文字、有大小上限——不另寫一套讀檔。
  // 回傳附上的內容、因為數量或長度上限而沒附上的檔案,以及讀不到的檔案
  inlineReviewContent(files: string[], cwd: string): { text: string; omitted: string[]; unreadable: string[] } {
    let session: FileToolSession;
    try { session = new FileToolSession(cwd, { readOnly: true, locale: this.locale }); } catch { return { text: '', omitted: files, unreadable: [] }; }
    let budget = REVIEW_INLINE_TOTAL_CHARS;
    const blocks: string[] = [];
    const omitted: string[] = [];
    const unreadable: string[] = [];
    for (const [i, file] of files.entries()) {
      if (i >= REVIEW_INLINE_FILES || budget <= 0) { omitted.push(file); continue; }
      const r = session.execute('read_file', { path: file, limit: Math.min(REVIEW_INLINE_FILE_CHARS, budget) });
      if (r.ok) {
        const content = r.content || '';
        budget -= content.length;
        blocks.push(this.text('prompt.reviewFileBlock', { path: file, content: r.truncated ? content + this.text('prompt.reviewTruncated') : content }));
      } else {
        // 刪掉的檔案也會落在這裡;讀不到的原因照實交給審查者,介面也另外標出來
        unreadable.push(file);
        blocks.push(this.text('prompt.reviewFileUnreadable', { path: file, error: r.error || '' }));
      }
    }
    return { text: blocks.length ? `${this.text('prompt.reviewContent')}\n${blocks.join('\n\n')}` : '', omitted, unreadable };
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
        // 審查失敗(逾時、崩潰、沒有輸出)不算審查過;與 fixPhase、介面的結論徽章用同一個判斷
        .filter((rv) => reviewVerdict(rv.text, rv.error) !== 'failed' && rv.reviewer.id !== rv.target.agent.id)
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
    const reviewFailed = reviews.filter((rv) => reviewVerdict(rv.text, rv.error) === 'failed');
    if (reviewFailed.length) {
      this.system(
        this.text('sys.reviewFailed', { list: reviewFailed.map((rv) => this.text('sys.reviewFailedItem', { reviewer: rv.reviewer.name, target: rv.target.agent.name, error: rv.error || this.text('sys.noReviewText') })).join('\n') }),
        { level: 'error' },
      );
    }

    const issues = new Map<string, Issue>(); // agentId -> { agent, task, notes }
    for (const rv of reviews) {
      // failed 已在上面回報;pass 是審查者明確表示沒問題
      if (reviewVerdict(rv.text, rv.error) !== 'issues') continue;
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
  async turn(agent: AgentConfig, instruction: string, { phase, hideAgreed = false, group = null, fileToolsEnabled = false, readOnlyFileTools = false, ephemeral, review }: TurnOptions = {}): Promise<TurnOutcome> {
    const startIdx = this.messages.length;
    const msg = this.pushMessage({ kind: 'agent', agentId: agent.id, agentName: agent.name, color: agent.color, cli: agent.cli, model: agent.model, phase, status: 'running', ...(group ? { group } : {}), ...(review ? { review } : {}) });
    const transcript = this.unseenTranscript(agent, msg);
    const adapter = getAdapter(agent.cli);
    const resumable = !!(adapter?.supportsResume && this.sessions[agent.id]);
    // 已知這位成員的模型不能看圖:附件照「不收圖片」的成員處理,區塊裡照實說它看不到,圖片也不送
    const noImages = knownCapability(agent)?.images === false;
    const attachmentBlock = this.attachmentPrompt(agent, noImages ? withoutImages(adapter) : adapter, resumable);
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
      attachments: attachmentBlock ? this.attachmentsFor(adapter).filter((a) => !(noImages && a.kind === 'image')) : [],
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
      ...(review ? { review: { ...review, verdict: reviewVerdict(display, error) } } : {}),
    }, true); // 回合結束一定要 flush,不能讓最後一次更新卡在節流裡
    return { text: display, raw: text, error, toolEvents: toAuditEntries((result as { toolEvents?: unknown }).toolEvents), id: msg.id };
  }
}

export { Orchestrator, truncateTranscript, pickReviewPairs, parsePorcelain, describeGitChanges, snapshotDir, diffSnapshots, extractJson, resolveAgent, restoreMessage };
