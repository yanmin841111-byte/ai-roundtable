// 主程序端的文案:orchestrator 的系統訊息、給成員的提示詞、附件提示、匯出的 Markdown。
// 介面文案在 renderer/i18n.ts;這裡只放 renderer 看不到、由主程序組出的字串。
// 繁體中文是原始文案,英文是對應翻譯。AGREED / NO_ISSUES 這類標記是協定,不翻譯。

export type TextLocale = 'zh-Hant' | 'en';
type Params = Record<string, string | number>;
type Entry = string | ((p: Params) => string);

// 作業系統語系。Electron 主程序的 Intl 預設是 en-US、不看系統語言,所以 main.ts 啟動時
// 用 app.getLocale() 設定這個值;測試環境沒有 Electron,退回 Intl。
let systemLocaleTag = '';
export function setSystemLocale(tag: string): void { systemLocaleTag = tag || ''; }

// 設定值 'system'(或沒設定)時跟著作業系統
export function resolveTextLocale(setting: string | null | undefined): TextLocale {
  if (setting === 'zh-Hant' || setting === 'en') return setting;
  let system = systemLocaleTag;
  if (!system) { try { system = Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch {} }
  return system.toLowerCase().startsWith('zh') ? 'zh-Hant' : 'en';
}

const ZH: Record<string, Entry> = {
  // ---------- 系統訊息 ----------
  'sys.error': '發生錯誤:{message}',
  'sys.noAgents': '沒有啟用的成員,請先在左側新增或啟用成員。',
  'sys.cwdFailed': '無法建立工作目錄 {cwd}:{message}',
  'sys.stopped': '已停止。',
  'sys.stageFailed': '附件無法複製到工作目錄:{error}',
  'sys.unstageFailed': '無法清除工作目錄的附件暫存({dir}):{error}',
  'sys.agreed': '第 {round} 回合全員達成共識。',
  'sys.maxRoundsDivide': '已達最大討論回合({max}),直接進入分工。',
  'sys.maxRoundsSummary': '已達最大討論回合({max}),由主持人總結。',
  'sys.unmatched': '**有工作無法對應到成員**,已跳過:\n{list}',
  'sys.plan': (p) => `**分工結果**${p.summary ? `:${p.summary}` : ''}\n\n${p.lines}`,
  'sys.planNoMatch': '主持人的分工沒有任何一項能對應到成員,再試一次。',
  'sys.planUnparsable': '主持人輸出的分工格式無法解析,再試一次。',
  'sys.planFailed': '分工失敗,已中止。',
  'sys.nobodyAssigned': '沒有任何成員被分配到工作。',
  'sys.execFailed': '**執行失敗**,這些成員的成果不會進入審查:\n{list}',
  'sys.noReport': '沒有產生回報',
  'sys.noReviewer': '找不到可以擔任審查者的其他成員(整場只有一名啟用成員),略過交叉審查。',
  'sys.reviewFailed': '**交叉審查失敗**,這些審查沒有結果,不代表被審查的成果沒有問題:\n{list}',
  'sys.reviewFailedItem': '- **{reviewer}** 審查「{target}」:{error}',
  'sys.noReviewText': '沒有產生審查意見',
  'sys.noSuccessfulReview': '沒有任何成功的審查意見,略過修復回合。',
  'sys.noIssues': '交叉審查沒有發現問題,略過修復回合。',
  'sys.unresolved': '「{names}」沒有修改檔案的權限,審查意見將直接帶入總結。',
  'sys.fixFailed': '**修復失敗**,以下成員的審查意見仍未處理:\n{list}',

  // ---------- 對話紀錄 ----------
  'transcript.new': '【新訊息】',
  'transcript.sofar': '【目前為止的對話紀錄】',
  'transcript.user': '使用者',
  'transcript.system': '系統',
  'transcript.omitted': '…(已省略中間 {n} 則訊息)…',
  'transcript.clipped': '\n…(此則訊息過長,已截斷)…',

  // ---------- 提示詞 ----------
  'prompt.system.intro': '你是名為「{name}」的 AI 助理,正在一個多 AI 圓桌會議中與其他 AI 助理({others})協作,由使用者主持。',
  'prompt.system.noOthers': '(目前沒有其他成員)',
  'prompt.system.persona': '你的角色與個性:{persona}',
  'prompt.system.noPersona': '(未設定)',
  'prompt.system.rules': '規則:',
  'prompt.system.rule1': '- 使用{lang}回覆,簡潔、有重點,不要重複別人已經說過的內容。',
  'prompt.system.rule2': '- 對其他成員的看法要具體回應:同意、反對(附理由)或補充。有分歧時要明確說出自己的立場。',
  'prompt.system.rule3': '- 訊息中以「[名稱]:」開頭的段落是其他成員或使用者說的話。你自己的回覆不要加名稱前綴,直接寫內容。',
  'prompt.system.agreed': '- 討論階段中,若你認為已有足夠共識、可以進入分工執行,請在回覆最後單獨一行寫上 {mark}。尚未有共識就不要寫。只有單獨成行才算數,在句子裡提到它不會被視為同意。',
  'prompt.system.act': '- 執行與審查階段請根據指示實際操作,不要只給建議。',

  'prompt.task': '【任務】\n{task}\n',
  'prompt.discussLast': '這是最後一回合討論,請收斂並給出你的最終立場。若同意進入分工請在最後單獨一行寫 {mark}。',
  'prompt.discuss': '請發表你的看法(第 {round}/{max} 回合)。若你認為已可進入分工執行,請在最後單獨一行寫 {mark}。',

  'prompt.directed': '【指定回覆】使用者在最新一則訊息中用 @ 指定由你處理,請直接回應或完成使用者的要求。',
  'prompt.directedOthers': '同時被指定的還有 {others},各自處理即可,不需要等待對方。',
  'prompt.directedAlone': '這次只有你被指定,其他成員不會發言。',
  'prompt.directedCanEdit': '需要時可以直接在工作目錄({cwd})建立、修改檔案與執行指令。',
  'prompt.directedReadOnly': '你目前沒有修改檔案的權限,需要改動時請寫出完整內容或步驟。',

  'prompt.assign': '【分工】你是本次的主持人。請根據到目前為止的討論結果,把任務拆解並分配給以下成員:',
  'prompt.rosterItem': '- {code} =「{name}」({label}{readonly})',
  'prompt.rosterReadOnly': ',唯讀,不能修改檔案',
  'prompt.assignNoOverlap': '每位成員負責的檔案或模組盡量不要重疊,以免同時修改造成衝突。可以把某位成員的工作留空(不分配)。',
  'prompt.assignCodes': '`agent` 欄位請填上面的代號({codes}),不要填名稱。',
  'prompt.assignJson': '只輸出一段 JSON,不要加任何說明或 markdown 標記,格式如下:',
  'prompt.assignExample': '{"summary":"一句話說明整體方案","assignments":[{"agent":"A1","task":"具體、可直接執行的工作說明,包含要建立或修改的檔案"}]}',
  'prompt.unmatchedItem': '- `{agent}`:{task}',
  'prompt.planItem': '- **{name}**:{task}',

  'prompt.execute': '【執行】以下是分配給你的工作,請現在實際完成它(工作目錄:{cwd})。',
  'prompt.executeCanEdit': '你可以直接建立、修改檔案與執行指令。',
  'prompt.executeReadOnly': '注意:你目前沒有修改檔案的權限,請把要做的內容以完整程式碼或步驟寫出來。',
  'prompt.executeReport': '完成後請簡潔回報:做了什麼、建立或修改了哪些檔案、有什麼未完成或需要別人配合的地方。',
  'prompt.failedItem': '- **{name}**:{error}',

  'prompt.review': '【交叉審查】請檢查「{name}」剛完成的工作。請實際打開相關檔案確認,不要只看回報。',
  'prompt.reviewWhat': '指出:明確的錯誤、與討論結論不一致之處、可以改進的地方。請簡潔。',
  'prompt.reviewMark': '若你確認完全沒有問題,請在回覆的最後單獨一行寫上 {mark};只要有任何一項需要修正就不要寫。',
  'prompt.reviewTask': '他負責的工作:\n{task}',
  'prompt.reviewReport': '他的回報:\n{report}',
  'prompt.reviewNote': '[{reviewer}]:\n{text}',

  'prompt.fix': '【修復】以下是其他成員對你剛才成果的審查意見。請現在就處理:能修的直接改檔案,不打算修的要明確說明理由。',
  'prompt.fixLast': '這是最後一輪修改,之後不會再審查。請簡潔回報你改了什麼、哪些沒改以及為什麼。',
  'prompt.fixTask': '你負責的工作:\n{task}',
  'prompt.fixNotes': '審查意見:\n{notes}',
  'prompt.fixFailedItem': '- **{name}**:{error}',

  'prompt.summary.failed': '以下成員的執行失敗,成果未納入審查,請在總結中明確指出:\n{list}',
  'prompt.summary.failedItem': '- {name}:{error}',
  'prompt.summary.reviewFailed': '以下交叉審查沒有完成,對應的成果等於沒有被檢查過,請在總結中明確標示為「未經審查」,不要說成沒有問題:\n{list}',
  'prompt.summary.reviewFailedItem': '- {reviewer} 審查 {target}:{error}',
  'prompt.summary.fixFailed': '以下成員的修復回合失敗,審查指出的問題仍然存在,請在總結中列為未解決:\n{list}',
  'prompt.summary.fixFailedItem': '- {name}:{error}\n  未處理的審查意見:\n{notes}',
  'prompt.summary.unresolved': '以下成員沒有修改檔案的權限,審查意見尚未處理,請在總結中列出並說明需要使用者做什麼:\n{list}',
  'prompt.summary.unresolvedItem': '- {name}:\n{notes}',
  'prompt.summary.git': '執行結束時,工作目錄的 git 變更如下。這是**當下的工作區狀態**,可能包含本次任務開始前就已存在的變更,請據實轉述、不要宣稱這些變更全部由本次任務產生:\n{changes}',
  'prompt.summary.divide': '【總結】請以主持人身分,根據執行回報、交叉審查與修復結果,簡潔總結:完成了什麼、審查發現並修掉了什麼、還有哪些未解決或需要使用者決定的事項。',
  'prompt.summary.discuss': '【總結】請以主持人身分,簡潔總結這次討論的結論、分歧點,以及建議的下一步。',
  'git.more': '- (另有 {n} 個變更檔案未列出)',
  'git.preexisting': '(執行前就已是變更狀態)',

  // ---------- 附件提示 ----------
  'attach.header': '【附件】使用者提供了 {n} 個附件:',
  'attach.path': '- {label}\n  路徑:{path}',
  'attach.imageInline': '- {label}(影像已隨訊息附上)',
  'attach.textInline': '- {label}(內容如下)',
  'attach.inlineCap': '- {label}(已達文字附件總內嵌上限,內容省略)',
  'attach.truncated': '\n…(檔案過長或已達附件總量上限,已截斷;完整內容見原始檔案)…',
  'attach.unreadable': '注意:你無法讀取 {names} 的內容,請不要憑檔名臆測,必要時請在回覆中說明。',

  // ---------- 匯出 ----------
  'export.title': '# AI Roundtable 對話',
  'export.user': '使用者',
  'export.agent': 'AI 成員',
  'export.system': '系統',
  'export.systemError': '系統錯誤',
  'export.systemWarn': '系統警告',
  'export.timeUnknown': '時間不明',
  'export.rawUsage': '> 原始用量：{fields}',
  'export.noFields': '無欄位',
  'export.usage': '> 用量：{fields}',
  'export.input': '輸入: {n}',
  'export.cached': '其中快取 {n}',
  'export.cacheWrite': '寫入快取 {n}',
  'export.cachedInput': '快取輸入: {n}',
  'export.output': '輸出: {n}',
  'export.cost': '成本: ${n}',
  'export.attachments': '> 附件：{list}',
  'export.error': '> 錯誤：{text}',
  'export.empty': '_(無文字內容)_',
  'phase.idle': '閒置', 'phase.direct': '指定', 'phase.discuss': '討論', 'phase.divide': '分工',
  'phase.execute': '執行', 'phase.review': '審查', 'phase.repair': '修復', 'phase.summary': '總結',

  // ---------- 主程序 ----------
  'main.extNotFound': '找不到此 API 擴充，請先儲存設定',
  'main.extNoTest': '此擴充不支援 API 連線測試',
  'main.nothingToExport': '目前沒有可匯出的對話',
  'main.exportTitle': '匯出本次對話',
  'main.stillRunning': '目前仍在進行中,請先停止再載入歷史對話',
  'main.attachFilter': '可用附件',
  'adapter.missing': '找不到 CLI「{cli}」:對應的擴充可能已刪除或載入失敗,請到「設定 → CLI 與擴充」檢查',
  'adapter.failed': '{label} 執行失敗:{message}',
};

const EN: Record<string, Entry> = {
  'sys.error': 'Error: {message}',
  'sys.noAgents': 'No members are enabled. Add or enable a member in the sidebar first.',
  'sys.cwdFailed': 'Could not create the working directory {cwd}: {message}',
  'sys.stopped': 'Stopped.',
  'sys.stageFailed': 'Could not copy attachments into the working directory: {error}',
  'sys.unstageFailed': 'Could not remove the attachment staging folder ({dir}): {error}',
  'sys.agreed': 'Everyone agreed in round {round}.',
  'sys.maxRoundsDivide': 'Reached the round limit ({max}). Moving on to dividing the work.',
  'sys.maxRoundsSummary': 'Reached the round limit ({max}). The lead will summarize.',
  'sys.unmatched': '**Some work could not be matched to a member** and was skipped:\n{list}',
  'sys.plan': (p) => `**Work plan**${p.summary ? `: ${p.summary}` : ''}\n\n${p.lines}`,
  'sys.planNoMatch': "None of the lead's assignments matched a member. Trying again.",
  'sys.planUnparsable': "Could not parse the lead's work plan. Trying again.",
  'sys.planFailed': 'Dividing the work failed. Stopping.',
  'sys.nobodyAssigned': 'No member was assigned any work.',
  'sys.execFailed': '**Execution failed** for these members. Their work will not be reviewed:\n{list}',
  'sys.noReport': 'no report produced',
  'sys.noReviewer': 'No other member can act as reviewer (only one member is enabled). Skipping cross-review.',
  'sys.reviewFailed': '**Cross-review failed.** These reviews produced no result, which does not mean the work is fine:\n{list}',
  'sys.reviewFailedItem': '- **{reviewer}** reviewing "{target}": {error}',
  'sys.noReviewText': 'no review produced',
  'sys.noSuccessfulReview': 'No review succeeded. Skipping the repair round.',
  'sys.noIssues': 'Cross-review found no issues. Skipping the repair round.',
  'sys.unresolved': '{names} cannot edit files. The review comments go straight into the summary.',
  'sys.fixFailed': '**Repair failed.** Review comments for these members remain unaddressed:\n{list}',

  'transcript.new': '[New messages]',
  'transcript.sofar': '[Conversation so far]',
  'transcript.user': 'User',
  'transcript.system': 'System',
  'transcript.omitted': '…({n} messages in the middle omitted)…',
  'transcript.clipped': '\n…(this message was too long and has been truncated)…',

  'prompt.system.intro': 'You are an AI assistant named "{name}" taking part in a multi-AI roundtable with other AI assistants ({others}), moderated by the user.',
  'prompt.system.noOthers': '(no other members right now)',
  'prompt.system.persona': 'Your role and personality: {persona}',
  'prompt.system.noPersona': '(not set)',
  'prompt.system.rules': 'Rules:',
  'prompt.system.rule1': '- Reply in {lang}. Be concise and focused; do not repeat what others have already said.',
  'prompt.system.rule2': '- Respond concretely to the other members: agree, disagree (with reasons) or add to their points. When there is disagreement, state your own position clearly.',
  'prompt.system.rule3': '- Paragraphs starting with "[Name]:" are what other members or the user said. Do not prefix your own reply with a name; just write the content.',
  'prompt.system.agreed': '- During discussion, if you believe there is enough agreement to move on to dividing and executing the work, end your reply with {mark} on a line by itself. Do not write it before there is agreement. Only a line by itself counts; mentioning it inside a sentence is not agreement.',
  'prompt.system.act': '- In the execution and review phases, actually do the work as instructed instead of only giving advice.',

  'prompt.task': '[Task]\n{task}\n',
  'prompt.discussLast': 'This is the final round of discussion. Converge and give your final position. If you agree to move on to dividing the work, end with {mark} on a line by itself.',
  'prompt.discuss': 'Share your view (round {round}/{max}). If you think the group can move on to dividing and executing the work, end with {mark} on a line by itself.',

  'prompt.directed': '[Direct reply] The user addressed you with @ in the latest message. Respond directly or carry out the request.',
  'prompt.directedOthers': '{others} were addressed at the same time. Handle your part; there is no need to wait for them.',
  'prompt.directedAlone': 'Only you were addressed this time. The other members will not speak.',
  'prompt.directedCanEdit': 'If needed, you can create and edit files and run commands directly in the working directory ({cwd}).',
  'prompt.directedReadOnly': 'You currently cannot edit files. When changes are needed, write out the full content or the steps.',

  'prompt.assign': '[Divide the work] You are the lead this time. Based on the discussion so far, break the task down and assign it to these members:',
  'prompt.rosterItem': '- {code} = "{name}" ({label}{readonly})',
  'prompt.rosterReadOnly': ', read-only, cannot edit files',
  'prompt.assignNoOverlap': 'Keep the files or modules each member owns from overlapping, so concurrent edits do not conflict. A member may be left without work.',
  'prompt.assignCodes': 'Fill the `agent` field with the codes above ({codes}), not names.',
  'prompt.assignJson': 'Output a single JSON object with no explanation or markdown fences, in this format:',
  'prompt.assignExample': '{"summary":"one sentence describing the overall approach","assignments":[{"agent":"A1","task":"a concrete, directly executable description of the work, including the files to create or change"}]}',
  'prompt.unmatchedItem': '- `{agent}`: {task}',
  'prompt.planItem': '- **{name}**: {task}',

  'prompt.execute': '[Execute] Below is the work assigned to you. Complete it now (working directory: {cwd}).',
  'prompt.executeCanEdit': 'You can create and edit files and run commands directly.',
  'prompt.executeReadOnly': 'Note: you currently cannot edit files. Write out the full code or the steps for what needs to be done.',
  'prompt.executeReport': 'When done, report briefly: what you did, which files you created or changed, and anything unfinished or needing someone else.',
  'prompt.failedItem': '- **{name}**: {error}',

  'prompt.review': '[Cross-review] Check the work "{name}" just completed. Open the relevant files and verify; do not rely on the report alone.',
  'prompt.reviewWhat': 'Point out: clear mistakes, anything inconsistent with the discussion, and possible improvements. Be concise.',
  'prompt.reviewMark': 'If you confirm there are no issues at all, end your reply with {mark} on a line by itself. Leave it out if anything needs fixing.',
  'prompt.reviewTask': 'Their assigned work:\n{task}',
  'prompt.reviewReport': 'Their report:\n{report}',
  'prompt.reviewNote': '[{reviewer}]:\n{text}',

  'prompt.fix': '[Repair] Below are review comments from other members on your work. Handle them now: fix what you can directly in the files, and give a clear reason for anything you choose not to fix.',
  'prompt.fixLast': 'This is the final round of changes; there will be no further review. Report briefly what you changed, what you did not, and why.',
  'prompt.fixTask': 'Your assigned work:\n{task}',
  'prompt.fixNotes': 'Review comments:\n{notes}',
  'prompt.fixFailedItem': '- **{name}**: {error}',

  'prompt.summary.failed': 'Execution failed for these members and their work was not reviewed. State this clearly in the summary:\n{list}',
  'prompt.summary.failedItem': '- {name}: {error}',
  'prompt.summary.reviewFailed': 'These cross-reviews did not complete, so the corresponding work was effectively unchecked. Mark it as "not reviewed" in the summary; do not describe it as problem-free:\n{list}',
  'prompt.summary.reviewFailedItem': '- {reviewer} reviewing {target}: {error}',
  'prompt.summary.fixFailed': 'The repair round failed for these members, so the issues the reviews raised still exist. List them as unresolved in the summary:\n{list}',
  'prompt.summary.fixFailedItem': '- {name}: {error}\n  Unaddressed review comments:\n{notes}',
  'prompt.summary.unresolved': 'These members cannot edit files, so their review comments are still unaddressed. List them in the summary and say what the user needs to do:\n{list}',
  'prompt.summary.unresolvedItem': '- {name}:\n{notes}',
  'prompt.summary.git': 'At the end of execution the git changes in the working directory were as follows. This is the **current state of the working tree** and may include changes that existed before this task started. Report it as is; do not claim all of these changes came from this task:\n{changes}',
  'prompt.summary.divide': '[Summary] As the lead, briefly summarize based on the execution reports, cross-reviews and repairs: what was completed, what the reviews found and fixed, and what remains unresolved or needs a decision from the user.',
  'prompt.summary.discuss': '[Summary] As the lead, briefly summarize the conclusions of this discussion, the points of disagreement, and the recommended next steps.',
  'git.more': '- ({n} more changed files not listed)',
  'git.preexisting': ' (already modified before execution)',

  'attach.header': (p) => `[Attachments] The user provided ${p.n} ${Number(p.n) === 1 ? 'attachment' : 'attachments'}:`,
  'attach.path': '- {label}\n  Path: {path}',
  'attach.imageInline': '- {label} (image attached to this message)',
  'attach.textInline': '- {label} (content below)',
  'attach.inlineCap': '- {label} (inline text limit reached, content omitted)',
  'attach.truncated': '\n…(file too long or attachment limit reached; truncated. See the original file for the full content)…',
  'attach.unreadable': 'Note: you cannot read the content of {names}. Do not guess from the file names; say so in your reply if needed.',

  'export.title': '# AI Roundtable conversation',
  'export.user': 'User',
  'export.agent': 'AI member',
  'export.system': 'System',
  'export.systemError': 'System error',
  'export.systemWarn': 'System warning',
  'export.timeUnknown': 'unknown time',
  'export.rawUsage': '> Raw usage: {fields}',
  'export.noFields': 'no fields',
  'export.usage': '> Usage: {fields}',
  'export.input': 'input: {n}',
  'export.cached': '{n} cached',
  'export.cacheWrite': '{n} cache write',
  'export.cachedInput': 'cached input: {n}',
  'export.output': 'output: {n}',
  'export.cost': 'cost: ${n}',
  'export.attachments': '> Attachments: {list}',
  'export.error': '> Error: {text}',
  'export.empty': '_(no text)_',
  'phase.idle': 'Idle', 'phase.direct': 'Direct', 'phase.discuss': 'Discuss', 'phase.divide': 'Divide',
  'phase.execute': 'Execute', 'phase.review': 'Review', 'phase.repair': 'Repair', 'phase.summary': 'Summary',

  'main.extNotFound': 'This API extension was not found. Save its settings first',
  'main.extNoTest': 'This extension does not support an API connection test',
  'main.nothingToExport': 'There is no conversation to export',
  'main.exportTitle': 'Export this conversation',
  'main.stillRunning': 'A task is still running. Stop it before loading a saved conversation',
  'main.attachFilter': 'Supported attachments',
  'adapter.missing': 'CLI "{cli}" not found: its extension may have been deleted or failed to load. Check Settings → CLIs & extensions',
  'adapter.failed': '{label} failed: {message}',
};

const DICTS: Record<TextLocale, Record<string, Entry>> = { 'zh-Hant': ZH, en: EN };

export function tx(locale: TextLocale, key: string, params: Params = {}): string {
  const entry = DICTS[locale][key] ?? ZH[key];
  if (entry == null) return key;
  const text = typeof entry === 'function' ? entry(params) : entry;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

// 名稱清單的分隔符:中文用頓號,英文用逗號
export function joinNames(locale: TextLocale, names: readonly string[]): string {
  return names.join(locale === 'en' ? ', ' : '、');
}

// 中文用全形引號包名稱,英文用雙引號
export function quoteName(locale: TextLocale, name: string): string {
  return locale === 'en' ? `"${name}"` : `「${name}」`;
}
