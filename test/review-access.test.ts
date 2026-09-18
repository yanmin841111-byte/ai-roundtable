'use strict';

// 審查者要看得到實際改動,而且方式要符合它的能力。
//
// 以前對每位審查者都說「請實際打開相關檔案確認」,但 API 與本機模型在審查時沒有任何工具,
// 只看得到一行稽核摘要——它們只能審執行者自己寫的報告。這個專案實際遇過的症狀是:
// 成員連續幾輪交不出審查,只把「工具呼叫」當成文字寫出來,假裝讀了檔。
// 這裡走真正的 divide 流程,只把轉接器換成假的,分別驗三種審查者。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const O = require('../src/orchestrator');
const adapters = require('../src/adapters');
const { FileToolSession } = require('../src/adapters/file-tools');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

const EDITED = 'export const answer = 42; // 審查者必須看得到這一行\n';

// 執行者:改 src/a.ts 並回報工具紀錄;審查者:記下收到的提示詞與是否拿到唯讀工具
async function runReview(reviewerAdapter: any) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-review-'));
  fs.mkdirSync(path.join(workDir, 'src'));
  fs.writeFileSync(path.join(workDir, 'src', 'a.ts'), 'export const answer = 0;\n');
  const seen: { prompt?: string; readOnlyFileTools?: boolean; ephemeral?: string } = {};
  const respond = (ctx: any) => {
    if (/【分工】/.test(ctx.prompt)) return JSON.stringify({ summary: '改 a.ts', assignments: [{ agent: 'A1', task: '修改 src/a.ts' }] });
    if (/【總結】/.test(ctx.prompt)) return '完成';
    return '[AGREED]';
  };
  const byId: Record<string, any> = {
    exec: {
      id: 'exec', supportsEdit: true, supportsResume: false,
      run: async (_a: any, ctx: any) => {
        if (/【執行】/.test(ctx.prompt)) {
          fs.writeFileSync(path.join(workDir, 'src', 'a.ts'), EDITED);
          return { text: '已修改 src/a.ts', toolEvents: [{ toolCallId: 'c1', name: 'replace_text', path: 'src/a.ts', ok: true, summary: 'ok', result: { path: 'src/a.ts', added: 1, removed: 1 } }] };
        }
        return { text: respond(ctx) };
      },
    },
    reviewer: {
      id: 'reviewer', supportsResume: false, ...reviewerAdapter,
      run: async (_a: any, ctx: any) => {
        if (/【交叉審查】/.test(ctx.prompt)) { seen.prompt = ctx.prompt; seen.readOnlyFileTools = ctx.readOnlyFileTools; seen.ephemeral = ctx.ephemeral; return { text: '沒問題\n[NO_ISSUES]' }; }
        return { text: respond(ctx) };
      },
    },
  };
  adapters.setRegistry({ get: (id: string) => byId[id] || null });
  const agents = [
    { id: 'e', name: '執行者', cli: 'exec', enabled: true, canEdit: true, color: '#000', persona: '', model: '', effort: '', customCommand: '' },
    { id: 'r', name: '審查者', cli: 'reviewer', enabled: true, canEdit: false, color: '#111', persona: '', model: '', effort: '', customCommand: '' },
  ];
  const settings = { maxTranscriptChars: 0, language: '繁體中文', workDir, maxRounds: 1, mode: 'divide', uiLocale: 'zh-Hant', leadAgentId: 'e' };
  const orc = new O.Orchestrator({ get: () => ({ agents, settings }), userDataDir: os.tmpdir() });
  const done = new Promise<void>((r) => { const f = (s: any) => { if (!s.running && s.phase && s.phase.code === 'idle') { orc.off('state', f); r(); } }; orc.on('state', f); });
  await orc.userMessage('請修改 src/a.ts', 'divide');
  await done;
  fs.rmSync(workDir, { recursive: true, force: true });
  return seen;
}

test('能自己讀檔的審查者(CLI):照舊請它打開檔案,並列出改了哪些檔案', async () => {
  const seen = await runReview({ capabilities: { attachments: ['filePath'] } });
  assert.ok(seen.prompt, '應該有審查回合');
  assert.match(seen.prompt!, /請實際打開相關檔案確認/);
  assert.match(seen.prompt!, /- src\/a\.ts/, '要列出改動的檔案');
  assert.ok(!seen.readOnlyFileTools, '本身就能讀檔,不需要另給工具');
});

test('支援工具呼叫的 API 審查者:給唯讀的 read_file,內容也照樣附上', async () => {
  const seen = await runReview({ type: 'openai', supportsEdit: true, capabilities: { attachments: ['textInline'] } });
  assert.strictEqual(seen.readOnlyFileTools, true);
  assert.match(seen.prompt!, /read_file/);
  assert.match(seen.prompt!, /- src\/a\.ts/);
  assert.ok(seen.prompt!.includes('審查者必須看得到這一行'), '模型不接受工具時會不帶工具重送,內容必須已經在提示詞裡');
});

test('兩者皆否的審查者:明說它打不開檔案,並把實際內容附上', async () => {
  const seen = await runReview({ type: 'openai', supportsEdit: false, capabilities: { attachments: ['textInline'] } });
  assert.doesNotMatch(seen.prompt!, /請實際打開相關檔案確認/, '不可要求它做做不到的事');
  assert.match(seen.prompt!, /你沒有辦法自己打開檔案/);
  assert.ok(seen.prompt!.includes('審查者必須看得到這一行'), '改動後的實際內容必須在提示詞裡');
  assert.ok(!seen.readOnlyFileTools);
  // 附上的內容標成「只給這一回合」,API 成員存記憶時才能換掉,不會之後每回合重送
  assert.ok(seen.ephemeral && seen.ephemeral.includes('審查者必須看得到這一行') && seen.prompt!.includes(seen.ephemeral));
  // 判定規則要在附上的內容之後:寫在前面,本機模型讀完上萬字就忘了,指出錯誤之後照樣寫 [NO_ISSUES]
  assert.ok(seen.prompt!.lastIndexOf('[NO_ISSUES]') > seen.prompt!.indexOf('審查者必須看得到這一行'), '判定規則要放在最後');
});

test('唯讀模式:讀得到,但即使模型自己呼叫寫入工具也會被擋下', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ro-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), '這是一段夠長而且只出現一次的原始文字,用來測試唯讀模式下的替換會被擋下。\n');
  const s = new FileToolSession(dir, { readOnly: true });
  const read = s.execute('read_file', { path: 'a.txt' });
  assert.strictEqual(read.ok, true);
  const w = s.execute('write_file', { path: 'b.txt', content: 'x', createOnly: true, reason: '測試' });
  assert.strictEqual(w.ok, false);
  assert.match(w.error, /只能讀取/);
  // oldText 要超過最短長度(24 字),否則不管是不是唯讀都會被擋下,測不到唯讀這道關
  const r = s.execute('replace_text', { path: 'a.txt', oldText: '這是一段夠長而且只出現一次的原始文字,用來測試唯讀模式', newText: '改掉', expectedSha256: read.sha256 });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /只能讀取/, '要是被唯讀擋下,不是別的原因');
  assert.ok(!fs.existsSync(path.join(dir, 'b.txt')), '檔案不可被建立');
  assert.match(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), /原始文字/, '檔案不可被改動');
  fs.rmSync(dir, { recursive: true, force: true });
});

// CLI 執行者直接改檔、沒有工具紀錄:要改看工作目錄本身。工作目錄設成 repo 的子資料夾,
// 驗路徑相對於工作目錄(不是相對於 repo 根目錄),工作目錄以外的檔案不列入。
test('CLI 執行者改的檔案由工作目錄快照找出,路徑相對於工作目錄、不含工作目錄以外的檔案', async () => {
  const { execFileSync } = require('child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-review-git-'));
  const workDir = path.join(repo, 'pkg');
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'b.ts'), 'export const b = 0;\n');
  fs.writeFileSync(path.join(repo, 'outside.ts'), 'export const o = 0;\n');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@e.com'); git('config', 'user.name', 't');
  git('add', '.'); git('commit', '-qm', 'init');
  let reviewPrompt = '';
  const respond = (ctx: any) => {
    if (/【分工】/.test(ctx.prompt)) return JSON.stringify({ summary: '改 b.ts', assignments: [{ agent: 'A1', task: '修改 b.ts' }] });
    if (/【總結】/.test(ctx.prompt)) return '完成';
    return '[AGREED]';
  };
  adapters.setRegistry({ get: (id: string) => ({
    exec: { id: 'exec', supportsEdit: true, supportsResume: false, capabilities: { attachments: ['filePath'] },
      run: async (_a: any, ctx: any) => {
        if (/【執行】/.test(ctx.prompt)) {
          fs.writeFileSync(path.join(workDir, 'b.ts'), 'export const b = 1;\n');
          fs.writeFileSync(path.join(repo, 'outside.ts'), 'export const o = 1;\n'); // 工作目錄以外
          return { text: '改好了' }; // CLI 自己改檔,沒有工具紀錄
        }
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
  await orc.userMessage('請修改 b.ts', 'divide');
  await done;
  assert.match(reviewPrompt, /^- b\.ts$/m, '路徑要相對於工作目錄(是 b.ts,不是 pkg/b.ts)');
  assert.doesNotMatch(reviewPrompt, /pkg\/b\.ts/);
  assert.doesNotMatch(reviewPrompt, /outside\.ts/, '工作目錄以外的檔案不可列入');
  fs.rmSync(repo, { recursive: true, force: true });
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} review access tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
