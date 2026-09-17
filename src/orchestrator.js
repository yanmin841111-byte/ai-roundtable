'use strict';
// 協調器:安排多個 AI 成員輪流發言、達成共識後分工執行、交叉審查、再修復一輪。
const { EventEmitter } = require('events');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { runTurn, getAdapter, effectiveCanEdit } = require('./adapters');
const { hasMarker, stripMarker, findMentions } = require('./shared');
const {
  RUNTIME_DIR, newConversationId, attachmentCapabilities, buildAttachmentPrompt, stageToCwd, clearRuntime, absolutePath,
} = require('./attachments');

const AGREED = 'AGREED';
const NO_ISSUES = 'NO_ISSUES';
const MARK = (t) => `[${t}]`;
const EMIT_INTERVAL = 70; // 串流更新合併發送的間隔(ms),避免每個 token 都走一次 IPC
const SEP = '\n\n';            // 對話紀錄各則之間的分隔
const TRUNCATE_RESERVE = 200;   // 截斷時為省略提示預留的字元空間
const MAX_GIT_FILES = 200;      // 總結提示裡最多列出的變更檔案數
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/; // 與 attachments 的目錄名規則一致
const MESSAGE_KINDS = new Set(['user', 'agent', 'system']);

class Orchestrator extends EventEmitter {
  constructor(store) {
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
    this.phase = 'idle';
    this.taskStartIndex = 0;
    this.taskCwd = null;          // 本次任務開始時的工作目錄;任務中途改設定也不影響暫存與清理
    this.directedQueue = [];      // 進行中用 @ 指定成員的訊息,任務結束前要確保對方有回覆
    this.emitTimers = new Map(); // msgId -> timer,串流更新的節流
  }

  // ---------- 狀態與事件 ----------
  get config() { return this.store.get(); }
  get userDataDir() { return this.store.userDataDir; }
  get agents() { return this.config.agents.filter((a) => a.enabled !== false); }
  get lead() {
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
    };
  }
  setPhase(phase) { this.phase = phase; this.emit('state', { running: this.running, phase }); }

  pushMessage(m) {
    const msg = { id: crypto.randomUUID(), ts: Date.now(), status: 'done', text: '', thinking: '', activities: [], ...m };
    this.messages.push(msg);
    this.emit('message', msg); // 建立節點要立即送出,不節流
    return msg;
  }

  // flush = true 時立刻送出並取消排程中的更新(回合結束、狀態變更時使用)
  updateMessage(msg, patch, flush = false) {
    Object.assign(msg, patch);
    this.emitMessage(msg, flush);
  }

  emitMessage(msg, flush = false) {
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

  system(text, extra = {}) { return this.pushMessage({ kind: 'system', text, ...extra }); }

  // ---------- 對外操作 ----------
  async userMessage(text, mode, attachments = []) {
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
    run.catch((e) => this.system(`發生錯誤:${e.message}`, { level: 'error' }));
    return msg;
  }

  stop() {
    this.stopped = true;
    for (const p of this.procs) { try { p.kill('SIGTERM'); } catch {} }
    // stop / app quit 不必等外部 CLI 真正退出才清附件副本。
    this.staged = [];
    clearRuntime(this.taskCwd || this.config.settings.workDir, this.conversationId);
  }

  reset() {
    this.stop();
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
    this.setPhase('idle');
  }

  // 載入歷史對話繼續討論。CLI 的 session 不會跟著紀錄保存,所以每位成員下一次發言時
  // 會收到(依上限截斷的)完整對話紀錄,而不是只有新訊息。
  loadConversation({ messages, conversationId } = {}) {
    if (this.running) throw new Error('目前仍在進行中,請先停止再載入歷史對話');
    this.clearEmitTimers();
    clearRuntime(this.config.settings.workDir, this.conversationId);
    this.conversationId = CONVERSATION_ID.test(conversationId || '') ? conversationId : newConversationId();
    this.messages = (Array.isArray(messages) ? messages : []).filter((m) => m && typeof m === 'object').map(restoreMessage);
    this.attachments = [];
    this.staged = [];
    this.attachmentsSeen.clear();
    this.sessions = {};
    this.lastSeen = {};
    this.taskStartIndex = 0;
    this.directedQueue = [];
    this.stopped = false;
    this.setPhase('idle');
    return this.snapshot();
  }

  // ---------- 主流程 ----------
  async runTask(task, mode) {
    return this.runExclusive(async (agents, cwd) => {
      const agreed = await this.discussPhase(agents, task);
      if (this.stopped) return;
      if (mode === 'divide') {
        if (!agreed) this.system(`已達最大討論回合(${this.config.settings.maxRounds}),直接進入分工。`);
        const plan = await this.assignPhase(agents, task);
        if (this.stopped || !plan) return;
        const gitBefore = await gitStatus(cwd);
        const { reports, failed } = await this.executePhase(agents, plan);
        if (this.stopped) return;
        const gitChanges = describeGitChanges(gitBefore, await gitStatus(cwd));
        const reviews = await this.reviewPhase(agents, reports);
        if (this.stopped) return;
        const fix = await this.fixPhase(reviews);
        if (this.stopped) return;
        await this.summaryPhase(task, 'divide', { failed, gitChanges, ...fix });
      } else {
        if (!agreed) this.system(`已達最大討論回合(${this.config.settings.maxRounds}),由主持人總結。`);
        await this.summaryPhase(task, 'discuss', {});
      }
    });
  }

  // 任務的共同外殼:檢查成員與工作目錄、暫存附件、結束時一定清理。
  // body(agents, cwd) 是實際流程(完整圓桌或 @ 指定回覆)。
  async runExclusive(body) {
    const agents = this.agents;
    if (agents.length === 0) { this.system('沒有啟用的成員,請先在左側新增或啟用成員。', { level: 'error' }); return; }
    const cwd = this.config.settings.workDir;
    try { fs.mkdirSync(cwd, { recursive: true }); } catch (e) { this.system(`無法建立工作目錄 ${cwd}:${e.message}`, { level: 'error' }); return; }

    this.running = true;
    this.stopped = false;
    this.taskStartIndex = this.messages.length - 1; // user 訊息的位置
    this.taskCwd = cwd;
    this.directedQueue = [];
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
      if (this.stopped) this.system('已停止。');
      this.setPhase('idle');
    }
  }

  // @ 指定:只有被指定的成員回覆;多人時平行執行
  async directedPhase(targets) {
    const names = targets.map((a) => a.name).join('、');
    this.setPhase(`指定 ${names}`);
    const group = targets.length > 1 ? crypto.randomUUID() : null;
    await Promise.all(targets.map((agent) => this.turn(agent, this.directedPrompt(agent, targets), { phase: '指定', hideAgreed: true, group })));
  }

  // 進行中送出的 @ 指定訊息:被指定的成員若在那之後都沒發言過,任務結束前補一次指定回覆
  async answerDirectedQueue() {
    while (this.directedQueue.length && !this.stopped) {
      const { msg, agentIds } = this.directedQueue.shift();
      const at = this.messages.indexOf(msg);
      const spoke = new Set(this.messages.slice(at + 1).filter((m) => m.kind === 'agent').map((m) => m.agentId));
      const targets = this.agents.filter((a) => agentIds.includes(a.id) && !spoke.has(a.id));
      if (targets.length) await this.directedPhase(targets);
    }
  }

  directedPrompt(agent, targets) {
    const others = targets.filter((a) => a.id !== agent.id).map((a) => `「${a.name}」`);
    const cwd = this.taskCwd || this.config.settings.workDir;
    return [
      '【指定回覆】使用者在最新一則訊息中用 @ 指定由你處理,請直接回應或完成使用者的要求。',
      others.length ? `同時被指定的還有 ${others.join('、')},各自處理即可,不需要等待對方。` : '這次只有你被指定,其他成員不會發言。',
      effectiveCanEdit(agent)
        ? `需要時可以直接在工作目錄(${cwd})建立、修改檔案與執行指令。`
        : '你目前沒有修改檔案的權限,需要改動時請寫出完整內容或步驟。',
    ].join('\n');
  }

  // 沙箱型 CLI(capabilities.attachmentsNeedCwd)讀不到 userData 下的絕對路徑,
  // 只好在工作目錄放一份暫存副本。userData 仍是唯一權威來源。
  stageAttachments(agents, cwd, items = this.attachments, reset = true) {
    if (reset) this.staged = [];
    if (!items.length) return;
    const needsCwd = agents.some((a) => attachmentCapabilities(getAdapter(a.cli)).needCwd);
    if (!needsCwd) return;
    const { staged, error } = stageToCwd(this.userDataDir, this.conversationId, cwd, items);
    this.staged = reset ? staged : [...this.staged, ...staged];
    if (error) this.system(`附件無法複製到工作目錄:${error}`, { level: 'warn' });
  }

  unstageAttachments(cwd) {
    this.staged = [];
    const r = clearRuntime(cwd, this.conversationId);
    if (!r.ok) this.system(`無法清除工作目錄的附件暫存(${RUNTIME_DIR}):${r.error}`, { level: 'warn' });
  }

  // 階段一:輪流討論直到全員同意或到達回合上限
  async discussPhase(agents, task) {
    const maxRounds = Math.max(1, Number(this.config.settings.maxRounds) || 3);
    for (let round = 1; round <= maxRounds; round++) {
      this.setPhase(`討論 第 ${round}/${maxRounds} 回合`);
      let agreedCount = 0;
      for (const agent of agents) {
        if (this.stopped) return false;
        const { text } = await this.turn(agent, this.discussPrompt(agent, task, round, maxRounds), { phase: `討論 R${round}` });
        // 只認「最後幾行、單獨成行」的標記,避免成員在內文中提到它就被誤判為同意
        if (hasMarker(text, AGREED)) agreedCount++;
      }
      if (agreedCount === agents.length) { this.system(`第 ${round} 回合全員達成共識。`); return true; }
    }
    return false;
  }

  // 階段二:主持人產生分工 JSON(用 A1/A2 短代號,避免模型抄錯 UUID 或名稱)
  async assignPhase(agents, task) {
    this.setPhase('分工');
    const lead = this.lead;
    const codes = new Map();
    agents.forEach((a, i) => codes.set(`A${i + 1}`, a));
    const roster = [...codes.entries()]
      .map(([code, a]) => `- ${code} =「${a.name}」(${(getAdapter(a.cli) || {}).label || a.cli}${effectiveCanEdit(a) ? '' : ',唯讀,不能修改檔案'})`)
      .join('\n');
    const prompt = [
      '【分工】你是本次的主持人。請根據到目前為止的討論結果,把任務拆解並分配給以下成員:',
      roster,
      '',
      '每位成員負責的檔案或模組盡量不要重疊,以免同時修改造成衝突。可以把某位成員的工作留空(不分配)。',
      `\`agent\` 欄位請填上面的代號(${[...codes.keys()].join('、')}),不要填名稱。`,
      '只輸出一段 JSON,不要加任何說明或 markdown 標記,格式如下:',
      '{"summary":"一句話說明整體方案","assignments":[{"agent":"A1","task":"具體、可直接執行的工作說明,包含要建立或修改的檔案"}]}',
    ].join('\n');

    for (let attempt = 1; attempt <= 2; attempt++) {
      const { text } = await this.turn(lead, prompt, { phase: '分工', hideAgreed: true });
      if (this.stopped) return null;
      const plan = extractJson(text);
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
            `**有工作無法對應到成員**,已跳過:\n${unmatched.map((a) => `- \`${a.agent}\`:${a.task}`).join('\n')}`,
            { level: 'warn' },
          );
        }
        if (matched.length) {
          const lines = matched.map((a) => `- **${a._agentName}**:${a.task}`).join('\n');
          this.system(`**分工結果**${plan.summary ? `:${plan.summary}` : ''}\n\n${lines}`);
          return plan;
        }
        this.system('主持人的分工沒有任何一項能對應到成員,再試一次。', { level: 'warn' });
      } else {
        this.system('主持人輸出的分工格式無法解析,再試一次。', { level: 'warn' });
      }
    }
    this.system('分工失敗,已中止。', { level: 'error' });
    return null;
  }

  // 階段三:各成員平行執行自己的工作
  async executePhase(agents, plan) {
    this.setPhase('執行');
    const cwd = this.taskCwd || this.config.settings.workDir;
    const group = crypto.randomUUID(); // 同一批平行發言,介面會並排顯示
    const jobs = [];
    for (const agent of agents) {
      const mine = plan.assignments.filter((a) => a._agentId === agent.id && a.task);
      if (mine.length === 0) continue;
      const taskText = mine.map((a) => a.task).join('\n');
      const prompt = [
        `【執行】以下是分配給你的工作,請現在實際完成它(工作目錄:${cwd})。`,
        effectiveCanEdit(agent) ? '你可以直接建立、修改檔案與執行指令。' : '注意:你目前沒有修改檔案的權限,請把要做的內容以完整程式碼或步驟寫出來。',
        '完成後請簡潔回報:做了什麼、建立或修改了哪些檔案、有什麼未完成或需要別人配合的地方。',
        '',
        taskText,
      ].join('\n');
      jobs.push(
        this.turn(agent, prompt, { phase: '執行', hideAgreed: true, group })
          .then(({ text, error }) => ({ agent, task: taskText, report: text, error })),
      );
    }
    if (jobs.length === 0) { this.system('沒有任何成員被分配到工作。', { level: 'warn' }); return { reports: [], failed: [] }; }

    const all = await Promise.all(jobs);
    const reports = all.filter((r) => !r.error && (r.report || '').trim());
    const failed = all.filter((r) => r.error || !(r.report || '').trim());
    if (failed.length) {
      this.system(
        `**執行失敗**,這些成員的成果不會進入審查:\n${failed.map((f) => `- **${f.agent.name}**:${f.error || '沒有產生回報'}`).join('\n')}`,
        { level: 'error' },
      );
    }
    return { reports, failed };
  }

  // 階段四:交叉審查
  // 兩份以上成果沿用執行者輪替;只有一份時由其他啟用成員(即使沒被分配到工作)擔任審查者,
  // 避免「一人執行、其他人只討論」的常見分工完全沒有品質關卡。
  async reviewPhase(agents, reports) {
    const pairs = pickReviewPairs(agents, reports);
    if (pairs.length === 0) {
      if (reports.length >= 1) this.system('找不到可以擔任審查者的其他成員(整場只有一名啟用成員),略過交叉審查。', { level: 'warn' });
      return [];
    }
    this.setPhase('交叉審查');
    const group = crypto.randomUUID();
    const jobs = pairs.map(({ reviewer, target }) => {
      const prompt = [
        `【交叉審查】請檢查「${target.agent.name}」剛完成的工作。請實際打開相關檔案確認,不要只看回報。`,
        '指出:明確的錯誤、與討論結論不一致之處、可以改進的地方。請簡潔。',
        `若你確認完全沒有問題,請在回覆的最後單獨一行寫上 ${MARK(NO_ISSUES)};只要有任何一項需要修正就不要寫。`,
        '',
        `他負責的工作:\n${target.task}`,
        '',
        `他的回報:\n${target.report}`,
      ].join('\n');
      return this.turn(reviewer, prompt, { phase: '審查', hideAgreed: true, group })
        .then(({ text, error }) => ({ reviewer, target, text, error }));
    });
    return Promise.all(jobs);
  }

  // 階段五:修復回合(只跑一輪,讓被審查者修掉問題或說明不修的理由)
  // 回傳 { unresolved, reviewFailed, fixFailed },三種未閉環的情況都要讓總結看得到
  async fixPhase(reviews) {
    // 審查本身失敗(CLI 逾時、崩潰、沒有輸出)不能當成「沒問題」
    const reviewFailed = reviews.filter((rv) => rv.error || !(rv.text || '').trim());
    if (reviewFailed.length) {
      this.system(
        `**交叉審查失敗**,這些審查沒有結果,不代表被審查的成果沒有問題:\n${reviewFailed.map((rv) => `- **${rv.reviewer.name}** 審查「${rv.target.agent.name}」:${rv.error || '沒有產生審查意見'}`).join('\n')}`,
        { level: 'error' },
      );
    }

    const issues = new Map(); // agentId -> { agent, task, notes }
    for (const rv of reviews) {
      if (rv.error || !(rv.text || '').trim()) continue;
      if (hasMarker(rv.text, NO_ISSUES)) continue; // 審查者明確表示沒問題
      const t = rv.target;
      if (!issues.has(t.agent.id)) issues.set(t.agent.id, { agent: t.agent, task: t.task, notes: [] });
      issues.get(t.agent.id).notes.push(`[${rv.reviewer.name}]:\n${stripMarker(rv.text, NO_ISSUES)}`);
    }
    if (issues.size === 0) {
      if (reviewFailed.length) this.system('沒有任何成功的審查意見,略過修復回合。', { level: 'warn' });
      else if (reviews.length) this.system('交叉審查沒有發現問題,略過修復回合。');
      return { unresolved: [], reviewFailed, fixFailed: [] };
    }

    const unresolved = [];
    const jobs = [];
    const group = crypto.randomUUID();
    for (const it of issues.values()) {
      if (!effectiveCanEdit(it.agent)) { unresolved.push(it); continue; }
      const prompt = [
        '【修復】以下是其他成員對你剛才成果的審查意見。請現在就處理:能修的直接改檔案,不打算修的要明確說明理由。',
        '這是最後一輪修改,之後不會再審查。請簡潔回報你改了什麼、哪些沒改以及為什麼。',
        '',
        `你負責的工作:\n${it.task}`,
        '',
        `審查意見:\n${it.notes.join('\n\n')}`,
      ].join('\n');
      jobs.push(this.turn(it.agent, prompt, { phase: '修復', hideAgreed: true, group }).then(({ error }) => ({ item: it, error })));
    }

    if (unresolved.length) {
      this.system(
        `「${unresolved.map((u) => u.agent.name).join('」、「')}」沒有修改檔案的權限,審查意見將直接帶入總結。`,
        { level: 'warn' },
      );
    }

    let fixFailed = [];
    if (jobs.length) {
      this.setPhase('修復');
      const results = await Promise.all(jobs);
      // 修復本身也可能失敗(逾時、崩潰),那些問題等於沒修掉
      fixFailed = results.filter((r) => r.error);
      if (fixFailed.length) {
        this.system(
          `**修復失敗**,以下成員的審查意見仍未處理:\n${fixFailed.map((r) => `- **${r.item.agent.name}**:${r.error}`).join('\n')}`,
          { level: 'error' },
        );
      }
    }
    return { unresolved, reviewFailed, fixFailed };
  }

  // 階段六:主持人總結
  async summaryPhase(task, mode, { failed = [], unresolved = [], reviewFailed = [], fixFailed = [], gitChanges = null } = {}) {
    this.setPhase('總結');
    const notes = [];
    if (failed.length) {
      notes.push(`以下成員的執行失敗,成果未納入審查,請在總結中明確指出:\n${failed.map((f) => `- ${f.agent.name}:${f.error || '沒有產生回報'}`).join('\n')}`);
    }
    if (reviewFailed.length) {
      notes.push(`以下交叉審查沒有完成,對應的成果等於沒有被檢查過,請在總結中明確標示為「未經審查」,不要說成沒有問題:\n${reviewFailed.map((rv) => `- ${rv.reviewer.name} 審查 ${rv.target.agent.name}:${rv.error || '沒有產生審查意見'}`).join('\n')}`);
    }
    if (fixFailed.length) {
      notes.push(`以下成員的修復回合失敗,審查指出的問題仍然存在,請在總結中列為未解決:\n${fixFailed.map((r) => `- ${r.item.agent.name}:${r.error}\n  未處理的審查意見:\n${r.item.notes.join('\n')}`).join('\n\n')}`);
    }
    if (unresolved.length) {
      notes.push(`以下成員沒有修改檔案的權限,審查意見尚未處理,請在總結中列出並說明需要使用者做什麼:\n${unresolved.map((u) => `- ${u.agent.name}:\n${u.notes.join('\n')}`).join('\n\n')}`);
    }
    if (gitChanges) {
      notes.push(`執行結束時,工作目錄的 git 變更如下。這是**當下的工作區狀態**,可能包含本次任務開始前就已存在的變更,請據實轉述、不要宣稱這些變更全部由本次任務產生:\n${gitChanges}`);
    }
    const prompt = [
      mode === 'divide'
        ? '【總結】請以主持人身分,根據執行回報、交叉審查與修復結果,簡潔總結:完成了什麼、審查發現並修掉了什麼、還有哪些未解決或需要使用者決定的事項。'
        : '【總結】請以主持人身分,簡潔總結這次討論的結論、分歧點,以及建議的下一步。',
      ...notes,
    ].join('\n\n');
    await this.turn(this.lead, prompt, { phase: '總結', hideAgreed: true });
  }

  // ---------- 提示詞 ----------
  // showAgreed:只有討論階段才需要共識標記的規則,其他階段提到它只會汙染提示詞
  systemPrompt(agent, { showAgreed = true } = {}) {
    const others = this.agents.filter((a) => a.id !== agent.id).map((a) => `「${a.name}」`).join('、') || '(目前沒有其他成員)';
    const lang = this.config.settings.language || '繁體中文';
    const rules = [
      `- 使用${lang}回覆,簡潔、有重點,不要重複別人已經說過的內容。`,
      '- 對其他成員的看法要具體回應:同意、反對(附理由)或補充。有分歧時要明確說出自己的立場。',
      '- 訊息中以「[名稱]:」開頭的段落是其他成員或使用者說的話。你自己的回覆不要加名稱前綴,直接寫內容。',
    ];
    if (showAgreed) {
      rules.push(`- 討論階段中,若你認為已有足夠共識、可以進入分工執行,請在回覆最後單獨一行寫上 ${MARK(AGREED)}。尚未有共識就不要寫。只有單獨成行才算數,在句子裡提到它不會被視為同意。`);
    }
    rules.push('- 執行與審查階段請根據指示實際操作,不要只給建議。');
    return [
      `你是名為「${agent.name}」的 AI 助理,正在一個多 AI 圓桌會議中與其他 AI 助理(${others})協作,由使用者主持。`,
      `你的角色與個性:${agent.persona || '(未設定)'}`,
      '規則:',
      ...rules,
    ].join('\n');
  }

  discussPrompt(agent, task, round, maxRounds) {
    const first = this.lastSeen[agent.id] == null;
    const header = first ? `【任務】\n${task}\n` : '';
    const tail = round === maxRounds
      ? `這是最後一回合討論,請收斂並給出你的最終立場。若同意進入分工請在最後單獨一行寫 ${MARK(AGREED)}。`
      : `請發表你的看法(第 ${round}/${maxRounds} 回合)。若你認為已可進入分工執行,請在最後單獨一行寫 ${MARK(AGREED)}。`;
    return [header, tail].filter(Boolean).join('\n');
  }

  // 這位成員這回合實際拿得到的附件(沙箱 CLI 用工作目錄副本,其餘用 userData 權威路徑)
  attachmentsFor(agent, adapter) {
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
  attachmentPrompt(agent, adapter, resumable) {
    if (!this.attachments.length) return '';
    const seen = this.attachmentsSeen.has(agent.id);
    if (seen && resumable) return '';
    this.attachmentsSeen.add(agent.id);
    const { needCwd } = attachmentCapabilities(adapter);
    return buildAttachmentPrompt(this.userDataDir, this.attachments, adapter, { staged: needCwd ? this.staged : [] });
  }

  // 收集該成員尚未看到的訊息,組成「[名稱]: 內容」的紀錄
  // 不支援 resume 的成員(自訂 CLI、所有 OpenAI 相容 API)每回合都要重送全部紀錄,
  // 這裡要加上字元上限,否則長討論會直接撞上模型的 context 上限。
  unseenTranscript(agent, current) {
    const seen = this.lastSeen[agent.id];
    const resumable = !!getAdapter(agent.cli)?.supportsResume;
    // 可續接且發言過的成員只需要新訊息;第一次發言(含剛載入的歷史對話)要從頭看起
    const incremental = resumable && seen != null;
    const from = incremental ? seen : 0;
    const entries = [];
    // 整段對話的第一個任務(載入歷史對話時就是原始任務)也要保留
    const firstUser = this.messages.findIndex((m) => m.kind === 'user');
    for (let i = from; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m === current || m.status === 'running') continue;
      // 任務敘述與分工結果是後面每一句話的前提,截斷時一定要保留
      if (m.kind === 'user') entries.push({ text: `[使用者${mentionLabel(m)}]:\n${m.text}`, pinned: i === this.taskStartIndex || i === firstUser });
      else if (m.kind === 'agent' && m.agentId !== agent.id && m.text) entries.push({ text: `[${m.agentName}]:\n${m.text}` });
      else if (m.kind === 'system' && m.level !== 'error' && m.text.startsWith('**分工結果**')) entries.push({ text: `[系統]:\n${m.text}`, pinned: true });
    }
    if (entries.length === 0) return '';
    if (incremental) return entries.map((e) => e.text).join(SEP); // 只送新訊息,量本來就小
    return truncateTranscript(entries, Number(this.config.settings.maxTranscriptChars) || 0);
  }

  // ---------- 執行一次發言 ----------
  // 回傳 { text, error };錯誤不再被吞掉,由上層決定是否影響流程
  async turn(agent, instruction, { phase, hideAgreed = false, group = null } = {}) {
    const startIdx = this.messages.length;
    const msg = this.pushMessage({ kind: 'agent', agentId: agent.id, agentName: agent.name, color: agent.color, cli: agent.cli, model: agent.model, phase, status: 'running', ...(group ? { group } : {}) });
    const transcript = this.unseenTranscript(agent, msg);
    const adapter = getAdapter(agent.cli);
    const resumable = adapter?.supportsResume && this.sessions[agent.id];
    const attachmentBlock = this.attachmentPrompt(agent, adapter, !!resumable);
    const prompt = [
      transcript ? (resumable ? '【新訊息】' : '【目前為止的對話紀錄】') + '\n' + transcript : '',
      attachmentBlock,
      instruction,
    ].filter(Boolean).join('\n\n');

    let text = '';
    const result = await runTurn(agent, {
      prompt,
      systemPrompt: this.systemPrompt(agent, { showAgreed: !hideAgreed }),
      sessionId: this.sessions[agent.id] || null,
      cwd: this.taskCwd || this.config.settings.workDir,
      // imageInline 型的 adapter 從這裡取實際影像;其餘 adapter 忽略即可
      attachments: attachmentBlock ? this.attachmentsFor(agent, adapter) : [],
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
    this.lastSeen[agent.id] = startIdx;
    const error = result.error || null;
    this.updateMessage(msg, {
      text,
      thinking: result.thinking || msg.thinking,
      usage: result.usage,
      status: error ? 'error' : 'done',
      error,
    }, true); // 回合結束一定要 flush,不能讓最後一次更新卡在節流裡
    return { text, error };
  }
}

// 「[使用者 → @Codex]」:讓每位成員都看得出這則訊息指定給誰
function mentionLabel(m) {
  const names = Array.isArray(m.mentions) ? m.mentions.map((x) => x && x.name).filter(Boolean) : [];
  return names.length ? ` → ${names.map((n) => `@${n}`).join('、')}` : '';
}

// 從紀錄還原訊息:補齊欄位;存檔時還在輸出中的訊息不可能再完成,標成中斷
function restoreMessage(m) {
  const kind = MESSAGE_KINDS.has(m.kind) ? m.kind : 'system';
  const msg = {
    ...m,
    id: typeof m.id === 'string' && m.id ? m.id : crypto.randomUUID(),
    kind,
    text: typeof m.text === 'string' ? m.text : String(m.text ?? ''),
    thinking: typeof m.thinking === 'string' ? m.thinking : '',
    activities: Array.isArray(m.activities) ? m.activities : [],
    status: m.status === 'error' ? 'error' : 'done',
  };
  if (m.status === 'running') { msg.status = 'error'; msg.error = m.error || '這則訊息在儲存時尚未完成'; }
  return msg;
}

// ---------- 對話紀錄截斷 ----------
const omitNotice = (n) => `…(已省略中間 ${n} 則訊息)…`;
const CLIP_NOTICE = '\n…(此則訊息過長,已截斷)…';

// 單則訊息本身就超過預算時就地裁尾,避免一則訊息吃掉整個額度
function clipEntry(text, max) {
  if (text.length <= max) return text;
  if (max <= CLIP_NOTICE.length) return CLIP_NOTICE.slice(0, Math.max(0, max));
  return text.slice(0, max - CLIP_NOTICE.length) + CLIP_NOTICE;
}

// 把對話紀錄壓到 limit 字元以內。
// pinned(任務敘述、分工結果)與最新一則一定保留,其餘從新到舊盡量保留;
// 被裁掉的位置就地插入「已省略中間 N 則訊息」,不做靜默裁切。
// limit <= 0 視為不限制。
function truncateTranscript(entries, limit) {
  const texts = entries.map((e) => e.text);
  const full = texts.join(SEP);
  if (!Number.isFinite(limit) || limit <= 0 || full.length <= limit) return full;

  const budget = Math.max(0, limit - TRUNCATE_RESERVE);
  const last = entries.length - 1;
  // 最新一則等同釘選:成員至少要看得到上一位說了什麼
  const items = entries.map((e, i) => ({ pinned: !!e.pinned || i === last, text: e.text }));
  const cost = (t) => t.length + SEP.length;

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
  const shown = new Map();
  kept.forEach((i, k) => shown.set(i, clipEntry(items[i].text, Math.max(0, allowance[k] - SEP.length))));

  const out = [];
  let dropped = 0;
  for (let i = 0; i < items.length; i++) {
    if (!keep[i]) { dropped++; continue; }
    if (dropped) { out.push(omitNotice(dropped)); dropped = 0; }
    out.push(shown.get(i));
  }
  if (dropped) out.push(omitNotice(dropped));

  const text = out.join(SEP);
  return text.length <= limit ? text : text.slice(0, limit); // 最後保險:絕不超過上限
}

// max-min 公平分配:需求小的先拿滿,省下來的額度再平分給還不夠的,
// 所以沒有任何一項會被歸零,總和也不會超過 budget。
function allocateBudget(costs, budget) {
  const out = new Array(costs.length).fill(0);
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
function pickReviewPairs(agents, reports) {
  if (!Array.isArray(reports) || reports.length === 0) return [];
  if (reports.length >= 2) {
    return reports.map((r, i) => ({ reviewer: r.agent, target: reports[(i + 1) % reports.length] }));
  }
  const target = reports[0];
  const executed = new Set(reports.map((r) => r.agent.id));
  const candidates = (agents || []).filter((a) => a && a.id !== target.agent.id);
  const reviewer = candidates.find((a) => executed.has(a.id)) || candidates[0];
  return reviewer ? [{ reviewer, target }] : [];
}

// ---------- git 變更 ----------
// 讀工作目錄的 git 變更;不是 git repo、找不到 git、逾時都安靜回 null,絕不影響主流程。
function gitStatus(cwd) {
  return new Promise((resolve) => {
    try {
      // --untracked-files=all:預設的 normal 模式會把整個未追蹤目錄收合成「?? dir/」,拿不到檔案清單
      execFile('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        resolve(err ? null : parsePorcelain(stdout));
      });
    } catch { resolve(null); }
  });
}

// 「XY path」→ Map(path → status);rename 的「old -> new」取新路徑
function parsePorcelain(stdout) {
  const out = new Map();
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
const isRuntimePath = (file) => file === RUNTIME_DIR || file.startsWith(`${RUNTIME_DIR}/`);

function describeGitChanges(before, after) {
  if (!after || after.size === 0) return null;
  const visible = [...after].filter(([file]) => !isRuntimePath(file));
  if (visible.length === 0) return null;
  const lines = [];
  for (const [file, status] of visible) {
    // -uall 展開未追蹤目錄後檔案數可能很多(例如工作目錄沒有 .gitignore),不能讓清單灌爆總結提示
    if (lines.length >= MAX_GIT_FILES) { lines.push(`- (另有 ${visible.length - MAX_GIT_FILES} 個變更檔案未列出)`); break; }
    const pre = before && before.has(file);
    lines.push(`- \`${status || '??'}\` ${file}${pre ? '(執行前就已是變更狀態)' : ''}`);
  }
  return lines.join('\n');
}

// ---------- JSON 解析 ----------
// 從 start 的「{」往後找到配對的「}」,會正確跳過字串內的括號與跳脫字元
function matchBrace(s, start) {
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
function extractJson(text) {
  if (!text) return null;
  const s = String(text).replace(/```(?:json)?/gi, '');
  const candidates = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    const end = matchBrace(s, i);
    if (end > i) candidates.push(s.slice(i, end + 1));
  }
  candidates.sort((a, b) => b.length - a.length); // 外層物件優先
  const parsed = [];
  for (const c of candidates) {
    try {
      const o = JSON.parse(c);
      if (o && typeof o === 'object' && !Array.isArray(o)) parsed.push(o);
    } catch {}
  }
  return parsed.find((o) => Array.isArray(o.assignments)) || parsed[0] || null;
}

// ---------- 成員比對 ----------
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '').replace(/[「」『』"'`【】\[\]()()]/g, '');

// 先比對 A1/A2 代號,再退回正規化後的名稱,最後才做寬鬆的包含比對
function resolveAgent(token, codes, agents) {
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

module.exports = { Orchestrator, truncateTranscript, pickReviewPairs, parsePorcelain, describeGitChanges, extractJson, resolveAgent };
