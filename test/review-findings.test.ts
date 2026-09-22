'use strict';

// code review 找到的三個問題,各自的回歸測試。
//
// 1. 中文檔名:git status 預設把非 ASCII 字元轉成八進位跳脫碼,拿去讀檔一定失敗;
//    工作目錄是中文資料夾時,show-prefix 的正常中文對不上跳脫碼,整批檔案都被丟掉。
// 2. app 自己的附件暫存(.roundtable-runtime/)被當成成員的改動交給審查者。
// 3. 依則數裁切歷史會留下孤立的 tool 訊息(嚴格的端點會以 400 拒絕),而且讀檔內容
//    存在歷史裡,之後每回合整包重送。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const O = require('../src/orchestrator');
const { createOpenAIAdapter } = require('../src/adapters/openai-adapter');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

function cjkRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cjk-'));
  fs.mkdirSync(path.join(repo, '子資料夾'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@e.com'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, '文件.md'), 'a\n');
  fs.writeFileSync(path.join(repo, '子資料夾', '程式.ts'), 'b\n');
  fs.writeFileSync(path.join(repo, '有 空格.txt'), 'c\n');
  git('add', '-A'); git('commit', '-qm', 'init');
  return { repo, git };
}

test('1a. 中文、空格、改名的檔案都解析成真實存在的路徑', () => {
  const { repo, git } = cjkRepo();
  fs.appendFileSync(path.join(repo, '子資料夾', '程式.ts'), 'x\n');
  fs.appendFileSync(path.join(repo, '有 空格.txt'), 'y\n');
  git('mv', '文件.md', '改名後.md');
  const m = O.parsePorcelain(git('status', '--porcelain', '-z', '--untracked-files=all'));
  for (const f of m.keys()) assert.ok(fs.existsSync(path.join(repo, f)), `「${f}」必須是真實存在的路徑,不是跳脫碼`);
  assert.ok(m.has('子資料夾/程式.ts') && m.has('改名後.md') && m.has('有 空格.txt'));
  assert.ok(!m.has('文件.md'), '改名的原路徑不是獨立變更');
  fs.rmSync(repo, { recursive: true, force: true });
});

// 審查要看的改動改由工作目錄快照找出(不經過 git),路徑直接相對於工作目錄
test('1b. 快照:中文資料夾與檔名、修改、新增、刪除都找得出來', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-snap-'));
  const work = path.join(dir, '工作區');
  fs.mkdirSync(path.join(work, '子資料夾'), { recursive: true });
  fs.writeFileSync(path.join(work, '子資料夾', '程式.ts'), 'a\n');
  fs.writeFileSync(path.join(work, '要刪的.md'), 'b\n');
  fs.writeFileSync(path.join(work, '不動.txt'), 'c\n');
  const before = await O.snapshotDir(work);
  fs.appendFileSync(path.join(work, '子資料夾', '程式.ts'), 'x\n');
  fs.writeFileSync(path.join(work, '新 檔案.ts'), 'n\n');
  fs.rmSync(path.join(work, '要刪的.md'));
  assert.deepStrictEqual(O.diffSnapshots(before, await O.snapshotDir(work)), ['子資料夾/程式.ts', '新 檔案.ts', '要刪的.md'].sort());
  assert.strictEqual(O.diffSnapshots(before, null), null, '任何一份拿不到就是拿不到');
  assert.strictEqual(await O.snapshotDir(path.join(dir, '不存在')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('1c. 舊的換行格式仍然可以解析(既有呼叫端不受影響)', () => {
  const m = O.parsePorcelain(' M src/a.js\nR  old.js -> new.js\n');
  assert.ok(m.has('src/a.js') && m.has('new.js') && !m.has('old.js'));
});

test('2. app 自己的附件暫存、.git、node_modules、標記為快取的目錄不算成員的改動', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-snap-skip-'));
  fs.mkdirSync(path.join(dir, 'src'));
  const before = await O.snapshotDir(dir);
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'x\n');
  for (const d of ['.roundtable-runtime/conv', 'sub/.roundtable-runtime/conv', '.git', 'node_modules/pkg', 'target/debug']) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
    fs.writeFileSync(path.join(dir, d, 'f.txt'), 'x\n');
  }
  // Rust 的 target/ 這類快取目錄會放 CACHEDIR.TAG 標明自己是快取
  fs.writeFileSync(path.join(dir, 'target', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
  assert.deepStrictEqual(O.diffSnapshots(before, await O.snapshotDir(dir)), ['src/a.ts']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 太大的工作目錄(例如把家目錄設成工作目錄):回 null,讓審查者照實知道拿不到,
// 而不是回一份只掃了一部分的快照,再把「沒掃到」說成「沒改」
test('2b. 快照超過檔案數上限時回 null,不回不完整的快照', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-snap-big-'));
  fs.mkdirSync(path.join(dir, 'a'));
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(dir, `f${i}`), '');
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(dir, 'a', `g${i}`), '');
  assert.strictEqual(await O.snapshotDir(dir, 100), null, '跨目錄累計超過上限');
  assert.strictEqual((await O.snapshotDir(dir, 120))!.size, 120);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 走完整的 divide 流程,驗的是產品實際的那條路:工作目錄是 repo 裡的中文子資料夾。
test('1d. 端到端:中文工作目錄裡改了中文檔名,審查者收到正確的檔案清單', async () => {
  const adapters = require('../src/adapters');
  const { repo, git } = cjkRepo();
  const workDir = path.join(repo, '子資料夾');
  let reviewPrompt = '';
  let summaryPrompt = '';
  const respond = (ctx: any) => {
    if (/【分工】/.test(ctx.prompt)) return JSON.stringify({ summary: '改程式', assignments: [{ agent: 'A1', task: '修改 程式.ts' }] });
    if (/【總結】/.test(ctx.prompt)) { summaryPrompt = ctx.prompt; return '完成'; }
    return '[AGREED]';
  };
  adapters.setRegistry({ get: (id: string) => ({
    exec: { id: 'exec', supportsEdit: true, supportsResume: false, capabilities: { attachments: ['filePath'] },
      run: async (_a: any, ctx: any) => {
        if (/【執行】/.test(ctx.prompt)) { fs.appendFileSync(path.join(workDir, '程式.ts'), 'changed\n'); return { text: '改好了' }; }
        return { text: respond(ctx) };
      } },
    reviewer: { id: 'reviewer', supportsResume: false, capabilities: { attachments: ['filePath'] },
      run: async (_a: any, ctx: any) => {
        if (/【交叉審查】/.test(ctx.prompt)) { reviewPrompt = ctx.prompt; return { text: '[NO_ISSUES]' }; }
        return { text: respond(ctx) };
      } },
  } as any)[id] || null });
  const agents = [
    { id: 'e', name: '執行者', cli: 'exec', enabled: true, canEdit: true, color: '#000', persona: '', model: '', effort: '', customCommand: '' },
    { id: 'r', name: '審查者', cli: 'reviewer', enabled: true, canEdit: false, color: '#111', persona: '', model: '', effort: '', customCommand: '' },
  ];
  const settings = { maxTranscriptChars: 0, language: '繁體中文', workDir, maxRounds: 1, mode: 'divide', uiLocale: 'zh-Hant', leadAgentId: 'e' };
  const orc = new O.Orchestrator({ get: () => ({ agents, settings }), userDataDir: os.tmpdir() });
  const done = new Promise<void>((r) => { const f = (st: any) => { if (!st.running && st.phase && st.phase.code === 'idle') { orc.off('state', f); r(); } }; orc.on('state', f); });
  await orc.userMessage('請修改 程式.ts', 'divide');
  await done;
  assert.match(reviewPrompt, /^- 程式\.ts$/m, `審查者要收到「程式.ts」,不是跳脫碼或空清單`);
  assert.doesNotMatch(reviewPrompt, /\\\d{3}/, '不可出現八進位跳脫碼');
  // 總結裡的 git 變更清單走產品的 gitStatus:沒有 -z 的話,中文檔名會變成 "\345\255\220…"
  assert.match(summaryPrompt, /子資料夾\/程式\.ts/, '總結的 git 變更要列出真實的中文路徑');
  assert.doesNotMatch(summaryPrompt, /\\\d{3}/);
  void git;
  fs.rmSync(repo, { recursive: true, force: true });
});

// 走真的 adapter:執行者(會改檔的回合)第一回合讀三個大檔,之後再聊幾回合,檢查送出的歷史。
// 執行者的工具往返會留在記憶裡(修復回合要看得到自己寫了什麼),所以要靠裁切與壓縮守住。
test('3. 歷史不會以孤立的 tool 訊息開頭,也不會一直重送讀過的檔案內容', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-hist-'));
  for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(dir, `${n}.txt`), `${n}`.repeat(30000));
  const sent: any[] = [];
  const bodies: any[] = [];
  let call = 0;
  const reply = (message: any) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message }] }) });
  const fetchImpl = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    sent.push(body.messages);
    bodies.push(body);
    call++;
    if (call === 1) return reply({ role: 'assistant', content: null, tool_calls: ['a', 'b', 'c'].map((n, i) => ({ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `${n}.txt` }) } })) });
    return reply({ role: 'assistant', content: `回覆 ${call}` });
  };
  const adapter = createOpenAIAdapter({ id: 'x', type: 'openai', baseUrl: 'http://local/v1', models: ['m'], stream: false, supportsEdit: true, fileTools: { enabled: true }, maxHistoryMessages: 8 }, { fetchImpl });
  const ctx = (prompt: string, sessionId: string | null) => ({
    prompt, sessionId, cwd: dir, fileToolsEnabled: true,
    onText: () => {}, onThinking: () => {}, onActivity: () => {}, onSession: () => {}, onProc: () => {},
  });
  let session: string | null = null;
  const first = await adapter.run({ name: 'Q', model: 'm', canEdit: true }, ctx('請修改', null));
  session = first.sessionId;
  // 前提:工具真的有送出、而且真的執行了。否則工具呼叫被忽略,歷史裡本來就沒有 tool 訊息,下面兩個檢查會空轉通過
  assert.ok((bodies[0].tools || []).length > 0, '要送出工具');
  assert.strictEqual((first.toolEvents || []).length, 3, '三次讀檔都要真的執行');
  for (let i = 0; i < 8; i++) {
    const r = await adapter.run({ name: 'Q', model: 'm', canEdit: true }, ctx(`後續 ${i}`, session));
    session = r.sessionId || session;
    const msgs = sent[sent.length - 1].filter((m: any) => m.role !== 'system');
    assert.notStrictEqual(msgs[0].role, 'tool', `第 ${i + 1} 輪後續:歷史開頭不可是孤立的 tool 訊息`);
    const size = JSON.stringify(msgs).length;
    assert.ok(size < 20000, `第 ${i + 1} 輪後續:不該重送讀過的檔案內容(實際 ${size} 字元)`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 第二輪 code review 的三個問題 ----------

const inlineCaps = { type: 'openai', supportsEdit: false, capabilities: { attachments: ['textInline'] } };

// 共用:跑一次 divide,執行者是沒有工具紀錄的 CLI,回傳審查者收到的提示詞
// reviewerCaps.canEdit 是成員設定(是否已開改檔),其餘是審查者轉接器的能力
async function reviewOnce(workDir: string, { canEdit: reviewerCanEdit = false, ...reviewerCaps }: any, execEdit: () => void): Promise<string> {
  const adapters = require('../src/adapters');
  let reviewPrompt = '';
  const respond = (ctx: any) => /【分工】/.test(ctx.prompt)
    ? JSON.stringify({ summary: 's', assignments: [{ agent: 'A1', task: '修改 b.ts' }] })
    : /【總結】/.test(ctx.prompt) ? '完成' : '[AGREED]';
  adapters.setRegistry({ get: (id: string) => ({
    exec: { id: 'exec', supportsEdit: true, supportsResume: false, capabilities: { attachments: ['filePath'] },
      run: async (_a: any, ctx: any) => { if (/【執行】/.test(ctx.prompt)) { execEdit(); return { text: '改好了' }; } return { text: respond(ctx) }; } },
    reviewer: { id: 'reviewer', supportsResume: false, ...reviewerCaps,
      run: async (_a: any, ctx: any) => { if (/【交叉審查】/.test(ctx.prompt)) { reviewPrompt = ctx.prompt; return { text: '[NO_ISSUES]' }; } return { text: respond(ctx) }; } },
  } as any)[id] || null });
  const agents = [
    { id: 'e', name: '執行者', cli: 'exec', enabled: true, canEdit: true, color: '#000', persona: '', model: '', effort: '', customCommand: '' },
    { id: 'r', name: '審查者', cli: 'reviewer', enabled: true, canEdit: reviewerCanEdit, color: '#111', persona: '', model: '', effort: '', customCommand: '' },
  ];
  const settings = { maxTranscriptChars: 0, language: '繁體中文', workDir, maxRounds: 1, mode: 'divide', uiLocale: 'zh-Hant', leadAgentId: 'e' };
  const orc = new O.Orchestrator({ get: () => ({ agents, settings }), userDataDir: os.tmpdir() });
  const done = new Promise<void>((r) => { const f = (st: any) => { if (!st.running && st.phase && st.phase.code === 'idle') { orc.off('state', f); r(); } }; orc.on('state', f); });
  await orc.userMessage('請修改 b.ts', 'divide');
  await done;
  return reviewPrompt;
}

// 拿不到改動清單(快照失敗:工作目錄太大或讀不到),被審者又是沒有工具紀錄的 CLI。
// 以前照樣說「下面附上了內容」,後面卻什麼都沒有。快照很少失敗,直接用 null 呼叫審查階段。
async function reviewUnknown(reviewerCaps: any): Promise<string> {
  const adapters = require('../src/adapters');
  let reviewPrompt = '';
  adapters.setRegistry({ get: (id: string) => ({
    exec: { id: 'exec', supportsEdit: true, supportsResume: false, capabilities: { attachments: ['filePath'] }, run: async () => ({ text: '' }) },
    reviewer: { id: 'reviewer', supportsResume: false, ...reviewerCaps, run: async (_a: any, ctx: any) => { reviewPrompt = ctx.prompt; return { text: '好' }; } },
  } as any)[id] || null });
  const agents = [
    { id: 'e', name: '執行者', cli: 'exec', enabled: true, canEdit: true, color: '#000', persona: '', model: '', effort: '', customCommand: '' },
    { id: 'r', name: '審查者', cli: 'reviewer', enabled: true, canEdit: false, color: '#111', persona: '', model: '', effort: '', customCommand: '' },
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-nolist-'));
  const settings = { maxTranscriptChars: 0, language: '繁體中文', workDir: dir, maxRounds: 1, mode: 'divide', uiLocale: 'zh-Hant', leadAgentId: 'e' };
  const orc = new O.Orchestrator({ get: () => ({ agents, settings }), userDataDir: os.tmpdir() });
  await orc.reviewPhase(agents, [{ agent: agents[0], task: '修改 b.ts', report: '改好了', error: null, toolEvents: [] }], null);
  fs.rmSync(dir, { recursive: true, force: true });
  return reviewPrompt;
}

test('4. 拿不到改動清單時,提示詞不可宣稱附上了內容,並要求不要只憑報告放行', async () => {
  const p = await reviewUnknown({ type: 'openai', supportsEdit: false, capabilities: { attachments: ['textInline'] } });
  assert.doesNotMatch(p, /下面附上了改動檔案目前的實際內容/, '後面沒有內容,不可這樣宣稱');
  assert.match(p, /你看不到實際的改動/);
  assert.match(p, /不要寫 \[NO_ISSUES\]/);
  // 有工具的審查者:要改成「自己依任務找檔案讀」,不能說「讀取下面列出的檔案」
  const t = await reviewUnknown({ type: 'openai', supportsEdit: true, capabilities: { attachments: ['textInline'] } });
  assert.doesNotMatch(t, /下面附上了/);
  assert.match(t, /無法自動確定改了哪些檔案/);
  // 工具可能被端點拒絕(adapter 會不帶工具重送),那時它什麼都讀不到:同樣不可放行
  assert.match(t, /不要寫 \[NO_ISSUES\]/);
});

// 任務前就已經是 M 的檔案,成員又改了它:git 狀態碼前後都是 M,快照看的是檔案本身才看得出來。
test('5. 任務開始前就已修改的檔案,成員又改了它,審查者仍會收到', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-dirty-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  fs.writeFileSync(path.join(repo, 'b.ts'), 'v0\n');
  fs.writeFileSync(path.join(repo, 'untouched.ts'), 'u0\n');
  git('init', '-q'); git('config', 'user.email', 't@e.com'); git('config', 'user.name', 't'); git('add', '.'); git('commit', '-qm', 'i');
  fs.writeFileSync(path.join(repo, 'b.ts'), 'v1 任務前\n');          // 任務前就是 M
  fs.writeFileSync(path.join(repo, 'untouched.ts'), 'u1 任務前\n');  // 任務前就是 M,但成員沒碰
  const p = await reviewOnce(repo, { capabilities: { attachments: ['filePath'] } },
    () => fs.writeFileSync(path.join(repo, 'b.ts'), 'v2 任務後\n')); // 與任務前等長:只有修改時間能分辨
  assert.match(p, /^- b\.ts$/m, '成員又改了它,必須列出');
  assert.doesNotMatch(p, /untouched\.ts/, '任務前就改了、成員沒碰的檔案不該列入');
  fs.rmSync(repo, { recursive: true, force: true });
});

// ---------- 第三輪 code review ----------

// 只做分析、沒改任何檔案的任務:快照確定「沒改」,不是「拿不到」。
// 以前兩者混在一起,審查者被告知看不到改動、而且不可寫 [NO_ISSUES]——分析任務永遠過不了審查。
test('7. git repo 裡沒改任何檔案:不說成「拿不到改動」,也不禁止宣告沒問題', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-nochange-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  fs.writeFileSync(path.join(repo, 'b.ts'), 'v0\n');
  git('init', '-q'); git('config', 'user.email', 't@e.com'); git('config', 'user.name', 't'); git('add', '.'); git('commit', '-qm', 'i');
  const noop = () => {};
  const inline = await reviewOnce(repo, { type: 'openai', supportsEdit: false, capabilities: { attachments: ['textInline'] } }, noop);
  assert.doesNotMatch(inline, /你看不到實際的改動/);
  assert.doesNotMatch(inline, /不要寫 \[NO_ISSUES\]/);
  assert.match(inline, /工作目錄裡沒有偵測到檔案改動/);
  const tool = await reviewOnce(repo, { type: 'openai', supportsEdit: true, canEdit: true, capabilities: { attachments: ['textInline'] } }, noop);
  assert.doesNotMatch(tool, /無法自動確定改了哪些檔案/);
  assert.doesNotMatch(tool, /下面沒附上的檔案/, '沒有附上任何檔案,不可這樣說');
  assert.match(tool, /read_file/, '仍可用工具核對回報');
  assert.match(tool, /工作目錄裡沒有偵測到檔案改動/);
  const cli = await reviewOnce(repo, { capabilities: { attachments: ['filePath'] } }, noop);
  assert.match(cli, /工作目錄裡沒有偵測到檔案改動/);
  fs.rmSync(repo, { recursive: true, force: true });
});

// 預設工作區不是 git repo。以前用 git 找改動,這裡永遠是「拿不到」:只做分析的任務過不了審查,
// 會改檔的 CLI 成員每次都被逼進修復回合。
test('8. 不是 git repo:沒改就說沒偵測到改動,改了就列出來', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-nogit-'));
  fs.writeFileSync(path.join(dir, 'b.ts'), 'v0\n');
  const quiet = await reviewOnce(dir, inlineCaps, () => {});
  assert.doesNotMatch(quiet, /你看不到實際的改動/);
  assert.doesNotMatch(quiet, /不要寫 \[NO_ISSUES\]/);
  assert.match(quiet, /工作目錄裡沒有偵測到檔案改動/);
  const edited = await reviewOnce(dir, inlineCaps, () => fs.writeFileSync(path.join(dir, 'b.ts'), 'export const b = 1 - 1;\n'));
  assert.match(edited, /^- b\.ts$/m);
  assert.ok(edited.includes('export const b = 1 - 1;'), '改動後的內容要附上');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 第四輪以後的 code review:空的 git 差異不等於「沒改」 ----------

function gitRepo(files: Record<string, string>) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-r4-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), body); }
  git('init', '-q'); git('config', 'user.email', 't@e.com'); git('config', 'user.name', 't'); git('add', '-A'); git('commit', '-qm', 'i');
  return { repo, git };
}

// 任務前就是變更狀態、任務後回到乾淨:只出現在 before。以前只看 after,
// 使用者沒提交的改動被還原、未追蹤的筆記被刪掉,都被說成「沒改」。
test('9. 被還原的修改與被刪掉的未追蹤檔,都算改動', async () => {
  const { repo } = gitRepo({ 'b.ts': 'v0\n' });
  fs.writeFileSync(path.join(repo, 'b.ts'), 'v1 使用者沒提交的改動\n');
  fs.writeFileSync(path.join(repo, 'notes.txt'), '使用者的筆記\n');
  const p = await reviewOnce(repo, inlineCaps, () => {
    fs.writeFileSync(path.join(repo, 'b.ts'), 'v0\n'); // 還原成 HEAD
    fs.rmSync(path.join(repo, 'notes.txt'));
  });
  assert.doesNotMatch(p, /工作目錄裡沒有偵測到檔案改動/);
  assert.match(p, /^- b\.ts$/m);
  assert.match(p, /^- notes\.txt$/m);
  fs.rmSync(repo, { recursive: true, force: true });
});

// 工作目錄本身被 .gitignore 忽略:git status 看不到裡面任何東西,快照看得到。
test('10. 工作目錄被 .gitignore 忽略時,改動照樣列得出來', async () => {
  const { repo } = gitRepo({ '.gitignore': 'scratch/\n', 'README.md': 'x\n' });
  const work = path.join(repo, 'scratch', 'sub');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'b.ts'), 'v0\n');
  const p = await reviewOnce(work, inlineCaps, () => fs.writeFileSync(path.join(work, 'b.ts'), 'export const b = 1 - 1;\n'));
  assert.match(p, /^- b\.ts$/m);
  assert.ok(p.includes('export const b = 1 - 1;'));
  fs.rmSync(repo, { recursive: true, force: true });
});

// 以前 git show-prefix 的輸出被 trim(),資料夾名稱開頭的空白被吃掉,整批路徑對不上。
test('11. 工作目錄名稱以空白開頭,改動仍然列得出來', async () => {
  const { repo } = gitRepo({ ' sp/b.ts': 'v0\n' });
  const work = path.join(repo, ' sp');
  const p = await reviewOnce(work, { capabilities: { attachments: ['filePath'] } }, () => fs.writeFileSync(path.join(work, 'b.ts'), 'v1\n'));
  assert.match(p, /^- b\.ts$/m);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('12. 改動檔案超過上限時,註明還有幾個沒列出', async () => {
  const { repo } = gitRepo({ 'README.md': 'x\n' });
  const p = await reviewOnce(repo, { capabilities: { attachments: ['filePath'] } },
    () => { for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(repo, `f${String(i).padStart(2, '0')}.ts`), `${i}\n`); });
  assert.strictEqual((p.match(/^- f\d\d\.ts$/gm) || []).length, 20);
  assert.match(p, /另有 5 個變更檔案未列出/);
  fs.rmSync(repo, { recursive: true, force: true });
});

// ---------- 第五輪 code review ----------

// 成員自己 commit:前後的 git status 都是空的。改到工作目錄外面:不在審查範圍,
// 提示詞只能說「工作目錄裡」沒偵測到,不能說成整體沒有改動。
test('13. 成員自己 commit 的改動照樣列出;工作目錄外面的改動不列,措辭只談工作目錄', async () => {
  const { repo, git } = gitRepo({ 'package.json': '{}\n', 'app/b.ts': 'v0\n' });
  const work = path.join(repo, 'app');
  const committed = await reviewOnce(work, inlineCaps, () => {
    fs.writeFileSync(path.join(work, 'b.ts'), 'v1 已提交\n');
    git('commit', '-qam', 'member');
  });
  assert.match(committed, /^- b\.ts$/m, '被 commit 的檔案要列出來');
  assert.ok(committed.includes('v1 已提交'), '並附上內容');
  const outside = await reviewOnce(work, inlineCaps, () => fs.writeFileSync(path.join(repo, 'package.json'), '{"x":1}\n'));
  assert.doesNotMatch(outside, /package\.json/);
  assert.match(outside, /這次工作目錄裡沒有偵測到檔案改動/);
  fs.rmSync(repo, { recursive: true, force: true });
});

// 工作目錄裡有未追蹤的巢狀 git 專案:git status 只有一行「?? nested/」,快照看得到裡面
test('14. 巢狀 git 專案裡的改動照樣列出', async () => {
  const { repo } = gitRepo({ 'README.md': 'x\n' });
  const nested = path.join(repo, 'nested');
  fs.mkdirSync(nested);
  execFileSync('git', ['init', '-q'], { cwd: nested });
  fs.writeFileSync(path.join(nested, 'n.ts'), 'v0\n');
  const p = await reviewOnce(repo, inlineCaps, () => fs.writeFileSync(path.join(nested, 'n.ts'), 'v1\n'));
  assert.match(p, /^- nested\/n\.ts$/m);
  fs.rmSync(repo, { recursive: true, force: true });
});

// 一次只讀一個檔案的模型:清單上有十幾個檔案時,以前第 10 輪就被截斷,審查整個丟掉
test('15. 唯讀審查回合逐一讀 12 個檔案,仍然交得出結論', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-rounds-'));
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, `f${i}.ts`), `export const v${i} = ${i};\n`);
  let call = 0;
  const fetchImpl = async () => {
    const i = call++;
    const message = i < 12
      ? { role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `f${i}.ts` }) } }] }
      : { role: 'assistant', content: '全部讀過了,沒問題\n[NO_ISSUES]' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }) };
  };
  const adapter = createOpenAIAdapter({ id: 'x', type: 'openai', baseUrl: 'http://local/v1', models: ['m'], stream: false, supportsEdit: true, fileTools: { enabled: true } }, { fetchImpl });
  const r = await adapter.run({ name: 'Q', model: 'm', canEdit: false }, {
    prompt: '請審查', sessionId: null, cwd: dir, readOnlyFileTools: true,
    onText: () => {}, onThinking: () => {}, onActivity: () => {}, onSession: () => {}, onProc: () => {},
  });
  assert.strictEqual(r.error || null, null);
  assert.match(r.text, /\[NO_ISSUES\]/);
  assert.strictEqual((r.toolEvents || []).length, 12);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 範本支援工具,不代表成員選的模型支援(例如 Ollama 上的 gemma3):帶了 tools 的請求被 400 拒絕時,
// 不帶工具重送一次,並告訴模型這次沒有工具,而不是讓整個審查失敗。
// Ollama 回 400;OpenRouter 對不支援工具的模型回 404「No endpoints found that support tool use」
// 有些端點(例如開了思考模式的 DeepSeek)是讀過檔之後的下一個請求才被拒:讀檔沒有副作用,一樣整個重來
for (const [rejectStatus, afterRead] of [[400, false], [404, false], [400, true]] as Array<[number, boolean]>) test(`17. 模型不接受工具呼叫時(HTTP ${rejectStatus}${afterRead ? ',讀過檔之後' : ''}),唯讀回合改成不帶工具重送`, async () => {
  const bodies: any[] = [];
  const fetchImpl = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.tools && afterRead && bodies.length === 1) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c0', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] } }] }) };
    if (body.tools) return { ok: false, status: rejectStatus, json: async () => ({ error: { message: 'model does not support tools' } }), text: async () => '{"error":"model does not support tools"}' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: '看過附上的內容,沒問題\n[NO_ISSUES]' } }] }) };
  };
  const adapter = createOpenAIAdapter({ id: 'x', type: 'openai', baseUrl: 'http://local/v1', models: ['m'], stream: false, supportsEdit: true, fileTools: { enabled: true } }, { fetchImpl });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-notools-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  const r = await adapter.run({ name: 'G', model: 'm', canEdit: false }, {
    prompt: '請審查', sessionId: null, cwd: dir, readOnlyFileTools: true, locale: 'zh-Hant',
    onText: () => {}, onThinking: () => {}, onActivity: () => {}, onSession: () => {}, onProc: () => {},
  });
  assert.strictEqual(r.error || null, null, '重送後要成功');
  assert.match(r.text, /\[NO_ISSUES\]/);
  const last = bodies[bodies.length - 1];
  assert.deepStrictEqual(bodies[0].tools.map((t: any) => t.function.name), ['read_file'], '審查回合只給 read_file');
  assert.strictEqual(bodies.length, afterRead ? 3 : 2);
  assert.ok(bodies[0].tools && !last.tools, '重送時不帶工具');
  assert.match(JSON.stringify(last.messages), /無法使用 read_file/, '要告訴模型這次沒有工具');
  assert.ok(!last.messages.some((m: any) => m.role === 'tool'), '重來的請求不帶上一次的工具往返');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 第六、七輪 code review:多位成員時,改動算誰的 ----------

// kind:cli 直接動檔案、沒有工具紀錄(當審查者時是 inline);api 只能透過檔案工具改檔(當審查者時是 tool)
type TeamMember = { id: string; name: string; kind: 'cli' | 'api'; canEdit: boolean; task: string; writes?: Record<string, string>; events?: string[]; report?: string; error?: string };
// 跑一次 divide,回傳「被審者名字 → 審查它的提示詞」
async function runTeam(dir: string, team: TeamMember[]): Promise<Record<string, string>> {
  const adapters = require('../src/adapters');
  const prompts: Record<string, string> = {};
  const plan = { summary: 's', assignments: team.map((m, i) => ({ agent: `A${i + 1}`, task: m.task })) };
  const adapterOf = (m: TeamMember) => ({
    id: m.id, supportsEdit: true, supportsResume: false, capabilities: { attachments: ['textInline'] }, ...(m.kind === 'api' ? { type: 'openai' } : {}),
    run: async (_a: any, ctx: any) => {
      if (/【分工】/.test(ctx.prompt)) return { text: JSON.stringify(plan) };
      if (/【執行】/.test(ctx.prompt)) {
        for (const [f, c] of Object.entries(m.writes || {})) fs.writeFileSync(path.join(ctx.cwd, f), c);
        if (m.error) return { text: '', error: m.error };
        return { text: m.report || '完成', toolEvents: (m.events || []).map((f, i) => ({ toolCallId: `c${i}`, name: 'write_file', path: f, ok: true, summary: 'ok', result: { path: f } })) };
      }
      if (/【交叉審查】/.test(ctx.prompt)) { const t = /請檢查「(.+?)」/.exec(ctx.prompt); if (t) prompts[t[1]] = ctx.prompt; return { text: '[NO_ISSUES]' }; }
      if (/【總結】/.test(ctx.prompt)) return { text: '完成' };
      return { text: '[AGREED]' };
    },
  });
  adapters.setRegistry({ get: (id: string) => { const m = team.find((x) => x.id === id); return m ? adapterOf(m) : null; } });
  const agents = team.map((m) => ({ id: m.id, name: m.name, cli: m.id, enabled: true, canEdit: m.canEdit, color: '#000', persona: '', model: '', effort: '', customCommand: '' }));
  const settings = { maxTranscriptChars: 0, language: '繁體中文', workDir: dir, maxRounds: 1, mode: 'divide', uiLocale: 'zh-Hant', leadAgentId: team[0].id };
  const orc = new O.Orchestrator({ get: () => ({ agents, settings }), userDataDir: os.tmpdir() });
  const done = new Promise<void>((r) => { const f = (st: any) => { if (!st.running && st.phase && st.phase.code === 'idle') { orc.off('state', f); r(); } }; orc.on('state', f); });
  await orc.userMessage('分工', 'divide');
  await done;
  for (const message of orc.messages.filter((message: any) => message.tag === 'conflict')) {
    const root = /`([^`]*ai-roundtable-lanes-[^`]*)`/.exec(message.text)?.[1];
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
  return prompts;
}

// 兩位 CLI 成員同時執行:工作目錄的差異是兩個人的改動,分不出誰改了哪個。
// 以前 Bob 審 Alice 時,附上的六個檔案全是 Bob 自己的,Alice 的檔案只有名字、沒有內容。
test('隔離檔案清單仍優先排列任務與回報提到的檔案', () => {
  const { reviewFiles } = require('../src/flow/review');
  assert.deepStrictEqual(reviewFiles({
    task: 'write a.js', report: 'completed a.js', changedPaths: ['README.md', 'a.js', 'docs/README.md'],
  }, ['README.md', 'a.js', 'b.js', 'docs/README.md']), ['a.js', 'README.md', 'docs/README.md']);
});

test('16. 多位 CLI 成員:隔離後只附上各自的實際改動;沒有改檔權限的只審回報', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-multi-'));
  const bob: Record<string, string> = {};
  for (let i = 1; i <= 9; i++) bob[`b${i}.ts`] = `export const b${i} = ${i};\n`;
  const p = await runTeam(dir, [
    { id: 'alice', name: 'Alice', kind: 'cli', canEdit: true, task: '寫 z_a.ts', writes: { 'z_a.ts': 'export const alice = 1 - 1; // Alice 的內容\n' }, report: '已完成 z_a.ts' },
    { id: 'bob', name: 'Bob', kind: 'cli', canEdit: true, task: '寫 b1 到 b9', writes: bob, report: '已完成 b1 到 b9' },
    { id: 'carol', name: 'Carol', kind: 'api', canEdit: false, task: '分析架構並回報', report: '架構分析:沒有問題' },
  ]);
  assert.ok(p.Alice, '要有人審 Alice');
  assert.ok(p.Alice.includes('Alice 的內容'), 'Alice 回報提到的檔案要排前面、附上內容(z_a.ts 按字母排在第 10 個)');
  assert.doesNotMatch(p.Alice, /不一定都是「Alice」改的/, '隔離後已能精確歸屬');
  assert.doesNotMatch(p.Alice, /^- b1\.ts$/m, '不附上別人的檔案');
  assert.match(p.Carol, /沒有修改檔案的權限/);
  assert.doesNotMatch(p.Carol, /^- b1\.ts$/m, '沒有改檔權限的成員,不列別人的改動');
  assert.doesNotMatch(p.Carol, /你看不到實際的改動/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// API 成員只能透過工具改檔,工具紀錄就是它的全部改動;CLI 成員看工作目錄差異。
// 以前把「其他成員工具紀錄裡的檔案」一律從 CLI 被審者的清單排除,兩人都改了同一個檔案時,
// CLI 成員的改動就被藏起來,還被說成「工作目錄裡沒有偵測到檔案改動」。
test('18. CLI 與 API 成員改了同一個檔案:兩邊的審查都看得到;API 成員只列它自己改的', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-mixed-'));
  const p = await runTeam(dir, [
    { id: 'claude', name: 'Claude', kind: 'cli', canEdit: true, task: '改 api.ts 並新增 cli.ts', writes: { 'api.ts': 'cli 版\n', 'cli.ts': 'x\n' } },
    { id: 'deepseek', name: 'DeepSeek', kind: 'api', canEdit: true, task: '改 api.ts', writes: { 'api.ts': 'api 版\n' }, events: ['api.ts'] },
  ]);
  assert.match(p.Claude, /^- api\.ts$/m, 'CLI 成員也改了 api.ts,不可因為 API 成員的工具紀錄就排除');
  assert.match(p.Claude, /^- cli\.ts$/m);
  assert.doesNotMatch(p.Claude, /沒有偵測到檔案改動/);
  assert.match(p.DeepSeek, /^- api\.ts$/m);
  assert.doesNotMatch(p.DeepSeek, /^- cli\.ts$/m, 'API 成員的改動只看它自己的工具紀錄');
  assert.doesNotMatch(p.DeepSeek, /不一定都是/, '清單就是它自己的改動,不需要標明');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('19. API 成員沒有用工具改任何檔案:依工具紀錄照實說,不說成工作目錄沒有改動', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-untouched-'));
  const p = await runTeam(dir, [
    { id: 'claude', name: 'Claude', kind: 'cli', canEdit: true, task: '新增 cli.ts', writes: { 'cli.ts': 'x\n' } },
    { id: 'deepseek', name: 'DeepSeek', kind: 'api', canEdit: true, task: '改 api.ts' },
  ]);
  assert.match(p.DeepSeek, /依檔案工具的紀錄,「DeepSeek」這次沒有修改任何檔案/);
  assert.doesNotMatch(p.DeepSeek, /工作目錄裡沒有偵測到檔案改動/, '工作目錄其實有改動(Claude 改的)');
  assert.doesNotMatch(p.DeepSeek, /^- cli\.ts$/m, '別人的改動不列進它的清單');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 執行失敗的成員可能改到一半。以前只看成功的回報,Bob 改壞的 legacy.ts 被當成 Alice 的改動,
// 清單也沒標明「不一定是 Alice 改的」。
test('20. 執行失敗的成員:依隔離目錄歸屬改動並送審', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-failed-'));
  const p = await runTeam(dir, [
    { id: 'alice', name: 'Alice', kind: 'cli', canEdit: true, task: '寫 a.ts', writes: { 'a.ts': 'ok\n' }, report: '完成 a.ts' },
    { id: 'bob', name: 'Bob', kind: 'cli', canEdit: true, task: '改 legacy.ts', writes: { 'legacy.ts': 'HALF-DONE BROKEN\n' }, error: '逾時' },
  ]);
  assert.ok(p.Alice, '要有人審 Alice');
  assert.doesNotMatch(p.Alice, /不一定都是「Alice」改的/);
  assert.doesNotMatch(p.Alice, /HALF-DONE BROKEN/);
  assert.match(p.Bob, /HALF-DONE BROKEN/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 附上的檔案內容只給那一回合用。以前它留在 API 成員的對話記憶裡,之後每回合都重送,
// 連跑三個任務,送出的請求就從兩萬字長到六萬字。
test('21. 審查時附上的內容不留在 API 成員的記憶裡', async () => {
  const sent: any[] = [];
  const fetchImpl = async (_url: string, init: any) => {
    sent.push(JSON.parse(init.body).messages);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: '好' } }] }) };
  };
  const adapter = createOpenAIAdapter({ id: 'x', type: 'openai', baseUrl: 'http://local/v1', models: ['m'], stream: false }, { fetchImpl });
  const big = `改動檔案目前的內容:\n${'檔案內容'.repeat(5000)}`;
  const ctx = (prompt: string, sessionId: string | null, ephemeral?: string) => ({
    prompt, sessionId, cwd: os.tmpdir(), ephemeral, locale: 'zh-Hant',
    onText: () => {}, onThinking: () => {}, onActivity: () => {}, onSession: () => {}, onProc: () => {},
  });
  const first = await adapter.run({ name: 'Q', model: 'm' }, ctx(`請審查\n${big}\n判定規則`, null, big));
  assert.ok(JSON.stringify(sent[0]).includes('檔案內容檔案內容'), '那一回合要照常送出');
  await adapter.run({ name: 'Q', model: 'm' }, ctx('下一個任務', first.sessionId));
  const later = JSON.stringify(sent[1]);
  assert.ok(!later.includes('檔案內容檔案內容'), '之後的回合不可重送');
  assert.match(later, /只用於那一回合/, '換成一行說明');
  assert.match(later, /請審查/, '其餘部分照樣保留');
  assert.match(later, /判定規則/);
});

// ---------- 第八輪 code review ----------

// 只有自己能改檔:沒有改檔權限的成員、沒用工具改檔的 API 成員都不可能動到工作目錄,
// 不該讓清單標成「不一定都是 Alice 改的」
test('22. 其他成員都不可能改檔時,清單不標成所有人的改動', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-solo-'));
  const p = await runTeam(dir, [
    { id: 'alice', name: 'Alice', kind: 'cli', canEdit: true, task: '寫 a.ts', writes: { 'a.ts': 'x\n' } },
    { id: 'carol', name: 'Carol', kind: 'api', canEdit: false, task: '分析' },
    { id: 'dave', name: 'Dave', kind: 'api', canEdit: true, task: '檢查設定,不需要改檔' },
  ]);
  assert.match(p.Alice, /^- a\.ts$/m);
  assert.doesNotMatch(p.Alice, /不一定都是/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 清單最多 20 個,附內容只有 6 個:沒附上的要點名。以前第 7 個之後的檔案只有名字,
// 審查者以為看到了全部,bug 藏在第 10 個檔案裡也照樣放行。
test('23. 超過附內容上限的檔案要點名,並要求說明無法驗證的部分', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-omit-'));
  const p = await reviewOnce(dir, inlineCaps, () => { for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(dir, `m${i}.ts`), `export const m${i} = ${i};\n`); });
  const tail = p.slice(p.indexOf('沒有附上內容'));
  assert.ok(p.includes('沒有附上內容'), '要說明哪些檔案沒附上');
  for (let i = 6; i < 10; i++) assert.match(tail, new RegExp(`^- m${i}\\.ts$`, 'm'));
  assert.doesNotMatch(tail, /^- m0\.ts$/m, '有附上的不列');
  assert.match(p, /說明哪些部分因此無法驗證/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 第九輪 code review ----------

// 快照在大的工作目錄要花上一秒。以前這段時間按下停止,執行者照樣被啟動、照樣改檔。
// 用 readdir 在快照讀工作目錄的那一刻按下停止,確保時機是確定的。
test('24. 快照期間按下停止:不再啟動執行者,也不再啟動審查', async () => {
  const adapters = require('../src/adapters');
  for (const stopAt of [1, 2]) { // 第 1 次讀工作目錄是執行前的快照,第 2 次是執行後的
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-stop-'));
    const ran: string[] = [];
    const respond = (ctx: any) => /【分工】/.test(ctx.prompt) ? JSON.stringify({ summary: 's', assignments: [{ agent: 'A1', task: '寫 a.ts' }] })
      : /【總結】/.test(ctx.prompt) ? '完成' : '[AGREED]';
    adapters.setRegistry({ get: (id: string) => ({
      exec: { id: 'exec', supportsEdit: true, supportsResume: false, capabilities: { attachments: ['filePath'] },
        run: async (_a: any, ctx: any) => { if (/【執行】/.test(ctx.prompt)) { ran.push('execute'); fs.writeFileSync(path.join(dir, 'a.ts'), 'x\n'); return { text: '好了' }; } return { text: respond(ctx) }; } },
      reviewer: { id: 'reviewer', supportsResume: false, capabilities: { attachments: ['filePath'] },
        run: async (_a: any, ctx: any) => { if (/【交叉審查】/.test(ctx.prompt)) ran.push('review'); return { text: respond(ctx) }; } },
    } as any)[id] || null });
    const agents = [
      { id: 'e', name: '執行者', cli: 'exec', enabled: true, canEdit: true, color: '#000', persona: '', model: '', effort: '', customCommand: '' },
      { id: 'r', name: '審查者', cli: 'reviewer', enabled: true, canEdit: false, color: '#111', persona: '', model: '', effort: '', customCommand: '' },
    ];
    const settings = { maxTranscriptChars: 0, language: '繁體中文', workDir: dir, maxRounds: 1, mode: 'divide', uiLocale: 'zh-Hant', leadAgentId: 'e' };
    const orc = new O.Orchestrator({ get: () => ({ agents, settings }), userDataDir: os.tmpdir() });
    const realReaddir = fs.promises.readdir;
    let reads = 0;
    fs.promises.readdir = async (p: any, ...rest: any[]) => {
      if (path.resolve(String(p)) === path.resolve(dir) && ++reads === stopAt) orc.stop();
      return realReaddir.call(fs.promises, p, ...rest);
    };
    try {
      const done = new Promise<void>((r) => { const f = (st: any) => { if (!st.running) { orc.off('state', f); r(); } }; orc.on('state', f); });
      await orc.userMessage('寫 a.ts', 'divide');
      await done;
    } finally { fs.promises.readdir = realReaddir; }
    if (stopAt === 1) assert.deepStrictEqual(ran, [], '執行前的快照期間停止:執行者不可被啟動');
    else assert.deepStrictEqual(ran, ['execute'], '執行後的快照期間停止:不可再啟動審查');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 讀檔的往返會塞滿依則數裁切的記憶。以前 Ollama 範本(只留 16 則)的成員審查時一口氣讀七個檔,
// 之前的討論就整個被擠掉,而它之後只會收到沒看過的新訊息,等於永久失去前情。
test('25. 讀了很多檔案的回合不會把之前的討論擠出記憶', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-mem-'));
  for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(dir, `f${i}.ts`), `export const v${i} = ${i};\n`);
  const sent: any[] = [];
  let reads = 0;
  const fetchImpl = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    sent.push(body.messages);
    const reviewing = JSON.stringify(body.messages[body.messages.length - 1]).includes('請審查') || body.messages[body.messages.length - 1].role === 'tool';
    const message = reviewing && reads < 7
      ? { role: 'assistant', content: null, tool_calls: [{ id: `c${reads}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `f${reads++}.ts` }) } }] }
      : { role: 'assistant', content: '好' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }) };
  };
  const adapter = createOpenAIAdapter({ id: 'x', type: 'openai', baseUrl: 'http://local/v1', models: ['m'], stream: false, supportsEdit: true, fileTools: { enabled: true }, maxHistoryMessages: 16 }, { fetchImpl });
  const ctx = (prompt: string, sessionId: string | null, readOnlyFileTools = false) => ({
    prompt, sessionId, cwd: dir, readOnlyFileTools, onText: () => {}, onThinking: () => {}, onActivity: () => {}, onSession: () => {}, onProc: () => {},
  });
  const a = await adapter.run({ name: 'Q', model: 'm' }, ctx('討論:我們決定用 BANANA 方案', null));
  const b = await adapter.run({ name: 'Q', model: 'm' }, ctx('請審查', a.sessionId, true));
  assert.strictEqual((b.toolEvents || []).length, 7, '前提:審查回合真的讀了七個檔案');
  await adapter.run({ name: 'Q', model: 'm' }, ctx('下一個任務', b.sessionId));
  const later = sent[sent.length - 1];
  assert.ok(JSON.stringify(later).includes('BANANA'), '之前的討論要還在記憶裡');
  assert.ok(!later.some((m: any) => m.role === 'tool'), '工具往返不進記憶');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 成員一口氣產生十萬個檔案又寫了長回報時,找「提到的檔案」的字串搜尋以前會把主程序卡住好幾秒
test('26. 改動檔案極多時,整理審查清單不會卡住主程序', async () => {
  const adapters = require('../src/adapters');
  adapters.setRegistry({ get: (id: string) => ({
    exec: { id: 'exec', supportsEdit: true, supportsResume: false, capabilities: { attachments: ['filePath'] }, run: async () => ({ text: '' }) },
    reviewer: { id: 'reviewer', supportsResume: false, capabilities: { attachments: ['filePath'] }, run: async () => ({ text: '好' }) },
  } as any)[id] || null });
  const agents = [
    { id: 'e', name: '執行者', cli: 'exec', enabled: true, canEdit: true, color: '#000', persona: '', model: '', effort: '', customCommand: '' },
    { id: 'r', name: '審查者', cli: 'reviewer', enabled: true, canEdit: false, color: '#111', persona: '', model: '', effort: '', customCommand: '' },
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-many-'));
  const settings = { maxTranscriptChars: 0, language: '繁體中文', workDir: dir, maxRounds: 1, mode: 'divide', uiLocale: 'zh-Hant', leadAgentId: 'e' };
  const orc = new O.Orchestrator({ get: () => ({ agents, settings }), userDataDir: os.tmpdir() });
  const changed = Array.from({ length: 100000 }, (_, i) => `vendor/pkg${i % 300}/file${i}.js`);
  // 回報要真的提到路徑:字串搜尋遇到部分符合才會逐字比對(純中文的回報幾乎瞬間掃完,測不出來)
  const report = '改了 vendor/pkg1/file 與 vendor/pkg2/fil 等,'.repeat(1600);
  const t0 = Date.now();
  await orc.reviewPhase(agents, [{ agent: agents[0], task: '產生資料', report, error: null, toolEvents: [] }], changed);
  assert.ok(Date.now() - t0 < 800, `整理審查清單花了 ${Date.now() - t0} ms`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 第十輪 code review ----------

// 修復回合沒有工具可以重讀檔案,API 執行者只能從記憶裡看到自己寫了什麼。
// 記憶只收掉審查回合的讀檔往返,寫入的呼叫(成員自己寫的程式碼)要留著。
test('27. API 執行者之後的回合仍看得到自己寫過的程式碼', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-exec-mem-'));
  const sent: any[] = [];
  let call = 0;
  const code = 'function avg(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; } // AVG_MARK';
  const fetchImpl = async (_url: string, init: any) => {
    sent.push(JSON.parse(init.body).messages);
    const i = call++;
    const message = i === 0
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'w0', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'calc.js', content: code, createOnly: true, reason: '新增計算機' }) } }] }
      : { role: 'assistant', content: '好' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }) };
  };
  const adapter = createOpenAIAdapter({ id: 'x', type: 'openai', baseUrl: 'http://local/v1', models: ['m'], stream: false, supportsEdit: true, fileTools: { enabled: true } }, { fetchImpl });
  const ctx = (prompt: string, sessionId: string | null, fileToolsEnabled = false) => ({
    prompt, sessionId, cwd: dir, fileToolsEnabled, onText: () => {}, onThinking: () => {}, onActivity: () => {}, onSession: () => {}, onProc: () => {},
  });
  const first = await adapter.run({ name: 'Q', model: 'm', canEdit: true }, ctx('建立 calc.js', null, true));
  assert.ok(fs.existsSync(path.join(dir, 'calc.js')), '前提:檔案真的寫了');
  await adapter.run({ name: 'Q', model: 'm', canEdit: true }, ctx('審查說 avg 在空陣列會除以零,請回應', first.sessionId));
  assert.ok(JSON.stringify(sent[sent.length - 1]).includes('AVG_MARK'), '修復回合的請求裡要有它自己寫的程式碼');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 能看圖、但不支援工具的模型(例如 Ollama 上的 llava):審查回合被拒時要先拿掉工具,不是先丟掉圖片
test('28. 帶圖的審查回合被拒時,先拿掉工具、保留圖片', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-img-'));
  const png = path.join(dir, 'p.png');
  fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
  const bodies: any[] = [];
  const notes: string[] = [];
  const fetchImpl = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.tools) return { ok: false, status: 400, json: async () => ({ error: { message: 'does not support tools' } }), text: async () => 'does not support tools' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: '看過了' } }] }) };
  };
  const adapter = createOpenAIAdapter({ id: 'x', type: 'openai', baseUrl: 'http://local/v1', models: ['m'], stream: false, supportsEdit: true, fileTools: { enabled: true }, capabilities: { attachments: ['textInline', 'imageInline'] } }, { fetchImpl });
  const r = await adapter.run({ name: 'Q', model: 'm' }, {
    prompt: '請審查', sessionId: null, cwd: dir, readOnlyFileTools: true, attachments: [{ kind: 'image', mime: 'image/png', path: png }],
    onText: () => {}, onThinking: () => {}, onActivity: (a: any) => notes.push(a.id), onSession: () => {}, onProc: () => {},
  });
  assert.strictEqual(r.error || null, null);
  assert.strictEqual(bodies.length, 2, '拿掉工具之後就成功,不需要再拿掉圖片');
  assert.match(JSON.stringify(bodies[1].messages), /image_url/, '圖片要保留');
  assert.ok(!notes.includes('image-fallback'), '不可說成模型不收圖片');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 第一次嘗試說了半句話、讀了檔之後被拒;重送的結果是空的。以前 orchestrator 會把那半句話
// 當成這回合的審查結果——被放棄的嘗試,不能變成審查意見。
test('29. 重送前清掉被放棄那次嘗試已經顯示的文字', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-stale-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  let call = 0;
  const fetchImpl = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const i = call++;
    if (i === 0) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: '讓我先打開 a.txt。', reasoning_content: '先讀檔', tool_calls: [{ id: 'c0', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] } }] }) };
    if (body.tools) return { ok: false, status: 400, json: async () => ({ error: { message: 'bad request' } }), text: async () => 'bad request' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: '' } }] }) };
  };
  const adapter = createOpenAIAdapter({ id: 'x', type: 'openai', baseUrl: 'http://local/v1', models: ['m'], stream: false, supportsEdit: true, fileTools: { enabled: true } }, { fetchImpl });
  const shown: string[] = [];
  const thought: string[] = [];
  const r = await adapter.run({ name: 'Q', model: 'm' }, {
    prompt: '請審查', sessionId: null, cwd: dir, readOnlyFileTools: true,
    onText: (t: string) => shown.push(t), onThinking: (t: string) => thought.push(t), onActivity: () => {}, onSession: () => {}, onProc: () => {},
  });
  assert.ok(shown.includes('讓我先打開 a.txt。'), '前提:第一次嘗試的文字有顯示過');
  assert.strictEqual(shown[shown.length - 1], '', '重送前要清掉');
  assert.ok(thought.includes('先讀檔') && thought[thought.length - 1] === '', '思考也要清掉');
  assert.strictEqual(r.text, '');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 第十一輪 code review:重送的邊界 ----------

// 共用:假的 OpenAI 相容端點。respond(第幾次請求, 請求內容) 回傳 { status, message }
function fakeEndpoint(respond: (i: number, body: any) => { status?: number; message?: any }) {
  const bodies: any[] = [];
  const fetchImpl = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const { status = 200, message } = respond(bodies.length - 1, body);
    if (status !== 200) return { ok: false, status, json: async () => ({ error: { message: 'rejected' } }), text: async () => 'rejected' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }) };
  };
  return { bodies, fetchImpl };
}
const toolCall = (id: string, name: string, args: any) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const png = (dir: string) => { const f = path.join(dir, 'p.png'); fs.writeFileSync(f, Buffer.from('89504e470d0a1a0a', 'hex')); return { kind: 'image', mime: 'image/png', path: f }; };

// 會改檔的回合寫完檔之後被拒:不可以走「拿掉工具重來」——那條路只給唯讀回合
test('30. 會改檔的回合寫過檔之後被拒:不重來,寫入的稽核紀錄保留', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-w400-'));
  const { bodies, fetchImpl } = fakeEndpoint((i) => i === 0
    ? { message: toolCall('w0', 'write_file', { path: 'n.js', content: 'x', createOnly: true, reason: '新增' }) }
    : { status: 400 });
  const adapter = createOpenAIAdapter({ id: 'x', type: 'openai', baseUrl: 'http://local/v1', models: ['m'], stream: false, supportsEdit: true, fileTools: { enabled: true } }, { fetchImpl });
  const r = await adapter.run({ name: 'Q', model: 'm', canEdit: true }, { prompt: '建立 n.js', sessionId: null, cwd: dir, fileToolsEnabled: true, onText: () => {}, onThinking: () => {}, onActivity: () => {}, onSession: () => {}, onProc: () => {} });
  assert.ok(r.error, '照實回報失敗');
  assert.strictEqual(bodies.length, 2, '不可重來');
  assert.ok((r.toolEvents || []).some((e: any) => e.name === 'write_file' && e.ok), '檔案已經寫了,稽核紀錄不能消失');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 帶圖的回合改過檔之後才被拒:4xx 不一定是圖片造成的,整個重跑會把同一段修改再套用一次
test('31. 帶圖的回合改過檔之後被拒:不拿掉圖片重來,修改不會套用兩次', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-imgw-'));
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1; // 這一行是原本就有的內容,夠長才能替換\n');
  let sha = '';
  const { bodies, fetchImpl } = fakeEndpoint((i, body) => {
    const last = body.messages[body.messages.length - 1];
    if (last.role === 'user') return { message: toolCall(`r${i}`, 'read_file', { path: 'a.ts' }) };
    const res = JSON.parse(last.content);
    if (res.sha256 && res.content !== undefined) { sha = res.sha256; return { message: toolCall(`e${i}`, 'replace_text', { path: 'a.ts', oldText: 'export const a = 1; // 這一行是原本就有的內容,夠長才能替換', newText: 'export const a = 1; // 這一行是原本就有的內容,夠長才能替換 added();', expectedSha256: sha }) }; }
    return { status: 400 };
  });
  const adapter = createOpenAIAdapter({ id: 'x', type: 'openai', baseUrl: 'http://local/v1', models: ['m'], stream: false, supportsEdit: true, fileTools: { enabled: true }, capabilities: { attachments: ['textInline', 'imageInline'] } }, { fetchImpl });
  const r = await adapter.run({ name: 'Q', model: 'm', canEdit: true }, { prompt: '照圖修改', sessionId: null, cwd: dir, fileToolsEnabled: true, attachments: [png(dir)], onText: () => {}, onThinking: () => {}, onActivity: () => {}, onSession: () => {}, onProc: () => {} });
  assert.ok(r.error);
  assert.ok((r.toolEvents || []).some((e: any) => e.name === 'replace_text' && e.ok), '前提:修改真的套用了');
  assert.strictEqual((fs.readFileSync(path.join(dir, 'a.ts'), 'utf8').match(/added\(\);/g) || []).length, 1, '修改只能套用一次');
  assert.strictEqual(bodies.length, 3, '讀、改、被拒,不重來');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 工具與圖片都不收的模型:兩次重送之後,「這次沒有工具」的說明要還在
test('32. 工具與圖片都被拒時,最後一次請求仍告訴模型沒有工具', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-both-'));
  const { bodies, fetchImpl } = fakeEndpoint((_i, body) => {
    if (body.tools || JSON.stringify(body.messages).includes('image_url')) return { status: 400 };
    return { message: { role: 'assistant', content: '看過了' } };
  });
  const adapter = createOpenAIAdapter({ id: 'x', type: 'openai', baseUrl: 'http://local/v1', models: ['m'], stream: false, supportsEdit: true, fileTools: { enabled: true }, capabilities: { attachments: ['textInline', 'imageInline'] } }, { fetchImpl });
  const r = await adapter.run({ name: 'Q', model: 'm' }, { prompt: '請審查', sessionId: null, cwd: dir, readOnlyFileTools: true, attachments: [png(dir)], onText: () => {}, onThinking: () => {}, onActivity: () => {}, onSession: () => {}, onProc: () => {} });
  assert.strictEqual(r.error || null, null);
  const last = bodies[bodies.length - 1];
  assert.strictEqual(bodies.length, 3);
  assert.ok(!last.tools && !JSON.stringify(last.messages).includes('image_url'));
  assert.match(JSON.stringify(last.messages), /無法使用 read_file/, '說明不可在拿掉圖片時弄丟');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 拿掉圖片重送之前,一樣要清掉被放棄那次嘗試已經顯示的文字與思考
test('33. 拿掉圖片重送前,清掉已經顯示的文字與思考', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-imgstale-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  const { fetchImpl } = fakeEndpoint((i, body) => {
    if (i === 0) return { message: { ...toolCall('r0', 'read_file', { path: 'a.txt' }), content: '讓我先看看 a.txt。', reasoning_content: '先讀檔' } };
    if (JSON.stringify(body.messages).includes('image_url')) return { status: 400 };
    return { message: { role: 'assistant', content: '' } };
  });
  const adapter = createOpenAIAdapter({ id: 'x', type: 'openai', baseUrl: 'http://local/v1', models: ['m'], stream: false, supportsEdit: true, fileTools: { enabled: true }, capabilities: { attachments: ['textInline', 'imageInline'] } }, { fetchImpl });
  const shown: string[] = [];
  const thought: string[] = [];
  await adapter.run({ name: 'Q', model: 'm', canEdit: true }, { prompt: '照圖修改', sessionId: null, cwd: dir, fileToolsEnabled: true, attachments: [png(dir)], onText: (t: string) => shown.push(t), onThinking: (t: string) => thought.push(t), onActivity: () => {}, onSession: () => {}, onProc: () => {} });
  assert.ok(shown.includes('讓我先看看 a.txt。') && thought.includes('先讀檔'), '前提:第一次嘗試的文字與思考有顯示過');
  assert.strictEqual(shown[shown.length - 1], '');
  assert.strictEqual(thought[thought.length - 1], '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('6. 工作目錄在子資料夾時,總結不把 app 的附件暫存列成成員的改動', () => {
  const after = new Map([['sub/src/a.ts', 'M'], ['sub/.roundtable-runtime/conv/pic.png', '??']]);
  const summary = O.describeGitChanges(new Map(), after, 'zh-Hant') || '';
  assert.match(summary, /sub\/src\/a\.ts/);
  assert.doesNotMatch(summary, /roundtable-runtime/);
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} review finding tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
