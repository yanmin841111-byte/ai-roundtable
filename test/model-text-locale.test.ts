'use strict';

// 給模型看的訊息跟著介面語言。
//
// 以前流程提示已經是英文了,檔案工具的說明、錯誤訊息與記憶裡的佔位文字卻固定是中文:
// 英文會議裡模型收到的是「英文指令 + 中文工具說明」,使用者在工具紀錄裡也會看到中文錯誤。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FileToolSession, fileToolDefinitions, toTranscriptEntry } = require('../src/adapters/file-tools');
const { createOpenAIAdapter } = require('../src/adapters/openai-adapter');
const O = require('../src/orchestrator');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });
const CJK = /[一-鿿]/;

test('檔案工具的錯誤訊息:英文設定是英文,沒指定照舊是中文', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ftloc-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  const en = new FileToolSession(dir, { locale: 'en' });
  assert.strictEqual(en.execute('read_file', { path: '../x' }).error, 'The path is outside the working directory');
  const read = en.execute('read_file', { path: 'a.txt' });
  assert.match(en.execute('replace_text', { path: 'a.txt', oldText: 'short', newText: 'x', expectedSha256: read.sha256 }).error, /^oldText needs at least 24/);
  assert.strictEqual(new FileToolSession(dir, { readOnly: true, locale: 'en' }).execute('write_file', { path: 'b.txt', content: 'x', createOnly: true, reason: 'r' }).error, 'This turn can only read files, not modify them');
  assert.strictEqual(new FileToolSession(dir).execute('read_file', { path: '../x' }).error, '路徑超出工作目錄', '沒指定語言照舊是中文');
  assert.throws(() => new FileToolSession(path.join(dir, 'nope'), { locale: 'en' }), /The working directory does not exist/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('工具說明與紀錄摘要跟著語言', () => {
  assert.ok(!CJK.test(JSON.stringify(fileToolDefinitions('en'))), '英文的工具說明不可混中文');
  assert.ok(CJK.test(JSON.stringify(fileToolDefinitions())), '預設是中文');
  assert.strictEqual(toTranscriptEntry('c', 'write_file', { path: 'a.txt' }, { ok: true, path: 'a.txt', added: 1, removed: 0 }, 'en').summary, 'write_file a.txt done (+1/-0)');
  assert.strictEqual(toTranscriptEntry('c', 'read_file', { path: 'a.txt' }, { ok: false, error: 'nope' }, 'en').summary, 'read_file a.txt failed: nope');
});

// 走真的 adapter:英文設定下,送出的工具說明、記憶裡被收起的讀檔結果都是英文
test('OpenAI adapter:英文設定下送出的工具說明與記憶佔位文字都是英文', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ftloc-api-'));
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(5000));
  const bodies: any[] = [];
  let call = 0;
  const fetchImpl = async (_u: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    const message = call++ === 0
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'c0', type: 'function', function: { name: 'read_file', arguments: '{"path":"big.txt"}' } }] }
      : { role: 'assistant', content: 'ok' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }) };
  };
  const adapter = createOpenAIAdapter({ id: 'x', type: 'openai', baseUrl: 'http://local/v1', models: ['m'], stream: false, supportsEdit: true, fileTools: { enabled: true } }, { fetchImpl });
  const titles: string[] = [];
  const ctx = (prompt: string, sessionId: string | null) => ({ prompt, sessionId, cwd: dir, fileToolsEnabled: true, locale: 'en', onText: () => {}, onThinking: () => {}, onActivity: (a: any) => titles.push(a.title), onSession: () => {}, onProc: () => {} });
  const first = await adapter.run({ name: 'Q', model: 'm', canEdit: true }, ctx('Read big.txt', null));
  assert.ok(!CJK.test(JSON.stringify(bodies[0].tools)), '送出的工具說明是英文');
  assert.ok(titles.includes('read_file big.txt done'), `畫面上的工具活動是英文(${titles.join(' / ')})`);
  await adapter.run({ name: 'Q', model: 'm', canEdit: true }, ctx('Next', first.sessionId));
  const later = JSON.stringify(bodies[bodies.length - 1].messages);
  assert.match(later, /Read 5000 characters; the content was removed from memory/);
  assert.ok(!CJK.test(later), `英文會議的請求裡不該出現中文(${later.match(CJK)})`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('審查時附上的內容:讀不到的原因跟著介面語言', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ftloc-rv-'));
  const settings = { maxTranscriptChars: 0, language: 'English', workDir: dir, maxRounds: 1, mode: 'divide', uiLocale: 'en', leadAgentId: null };
  const orc = new O.Orchestrator({ get: () => ({ agents: [], settings }), userDataDir: os.tmpdir() });
  const { text, unreadable } = orc.inlineReviewContent(['../outside.js'], dir);
  assert.deepStrictEqual(unreadable, ['../outside.js']);
  assert.match(text, /The path is outside the working directory/);
  fs.rmSync(dir, { recursive: true, force: true });
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} model text locale tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
