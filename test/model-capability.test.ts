'use strict';

// 模型能力:API 成員選的模型會不會呼叫工具、能不能看圖。
//
// 最重要的一條:付費端點在使用者沒按「測試」之前,一個對話請求都不能送。
// 其餘:Ollama 的回報、端點的模型資料、實際測試各自判讀正確;結果存檔;
// 已知不能呼叫工具的模型當唯讀成員,審查時直接附上內容。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOpenAIAdapter } = require('../src/adapters/openai-adapter');
const { Registry } = require('../src/adapters/registry');
const adapters = require('../src/adapters');
const { CapabilityStore, setCapabilityStore, capabilityKey } = require('../src/capabilities');
const O = require('../src/orchestrator');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

// 假端點:依路徑回應,並記下每一個請求
function endpoint(routes: Record<string, (body: any) => { status?: number; json?: any }>) {
  const calls: Array<{ path: string; body: any }> = [];
  const fetchImpl = async (url: string, init: any = {}) => {
    const p = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: p, body });
    const route = routes[p];
    const { status = 200, json = {} } = route ? route(body) : { status: 404, json: { error: 'not found' } };
    return { ok: status < 300, status, json: async () => json, text: async () => JSON.stringify(json) };
  };
  return { calls, fetchImpl, chats: () => calls.filter((c) => c.path.endsWith('/chat/completions')) };
}

const OLLAMA_SHOW = (b: any) => ({ json: { capabilities: ({ 'gemma3:latest': ['completion', 'vision'], 'qwen3:8b': ['completion', 'tools'] } as any)[b.model] || ['completion'] } });

test('Ollama:用 /api/show 的回報,不送任何對話請求', async () => {
  const e = endpoint({ '/v1/models': () => ({ json: { data: [{ id: 'gemma3:latest' }, { id: 'qwen3:8b' }] } }), '/api/show': OLLAMA_SHOW });
  const a = createOpenAIAdapter({ id: 'ollama', type: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', models: 'auto', supportsEdit: true, fileTools: { enabled: true } }, { fetchImpl: e.fetchImpl });
  const gemma = await a.modelCapability('gemma3:latest');
  assert.deepStrictEqual([gemma.tools, gemma.images, gemma.source], [false, true, 'ollama']);
  const qwen = await a.modelCapability('qwen3:8b');
  assert.deepStrictEqual([qwen.tools, qwen.images], [true, false]);
  assert.strictEqual(e.chats().length, 0);
});

test('模型清單附了能力資料(OpenRouter):直接採用,不送對話請求,也不去打 /api/show', async () => {
  process.env.RT_TEST_KEY = 'k';
  const e = endpoint({ '/api/v1/models': () => ({ json: { data: [
    { id: 'deepseek/deepseek-r1', supported_parameters: ['max_tokens', 'temperature'], architecture: { input_modalities: ['text'] } },
    { id: 'google/gemini-x', supported_parameters: ['tools', 'tool_choice'], architecture: { input_modalities: ['text', 'image'] } },
  ] } }) });
  const a = createOpenAIAdapter({ id: 'openrouter', type: 'openai', baseUrl: 'https://openrouter.test/api/v1', models: 'auto', apiKeyEnv: 'RT_TEST_KEY' }, { fetchImpl: e.fetchImpl });
  const r1 = await a.modelCapability('deepseek/deepseek-r1');
  assert.deepStrictEqual([r1.tools, r1.images, r1.source], [false, false, 'metadata']);
  const g = await a.modelCapability('google/gemini-x');
  assert.deepStrictEqual([g.tools, g.images], [true, true]);
  assert.strictEqual(e.chats().length, 0);
  assert.ok(!e.calls.some((c) => c.path === '/api/show'), '需要 key 的端點不是本機 Ollama');
});

test('付費端點、沒有能力資料:不知道就回 null,一個對話請求都不送', async () => {
  process.env.RT_TEST_KEY = 'k';
  const e = endpoint({ '/v1/models': () => ({ json: { data: [{ id: 'deepseek-chat' }] } }), '/v1/chat/completions': () => ({ json: { choices: [] } }) });
  const a = createOpenAIAdapter({ id: 'deepseek', type: 'openai', baseUrl: 'https://api.test/v1', models: 'auto', apiKeyEnv: 'RT_TEST_KEY' }, { fetchImpl: e.fetchImpl });
  assert.strictEqual(await a.modelCapability('deepseek-chat'), null);
  assert.strictEqual(e.chats().length, 0, '沒按「測試」就不能花使用者的錢');
});

test('實際測試:先確認基準請求,再分別帶工具、帶圖片', async () => {
  process.env.RT_TEST_KEY = 'k';
  const chat = (b: any) => {
    if (b.tools) return { status: 400, json: { error: 'tools not supported' } };
    return { json: { choices: [{ message: { role: 'assistant', content: 'OK' } }] } };
  };
  const e = endpoint({ '/v1/models': () => ({ json: { data: [{ id: 'm' }] } }), '/v1/chat/completions': chat });
  const a = createOpenAIAdapter({ id: 'x', type: 'openai', baseUrl: 'https://api.test/v1', models: 'auto', apiKeyEnv: 'RT_TEST_KEY', body: { reasoning_effort: 'none' } }, { fetchImpl: e.fetchImpl });
  const cap = await a.modelCapability('m', { live: true });
  assert.deepStrictEqual([cap.tools, cap.images, cap.source], [false, true, 'probe']);
  assert.strictEqual(e.chats().length, 3);
  assert.ok(e.chats().every((c) => c.body.reasoning_effort === 'none' && c.body.stream === false), '要帶範本的 body,否則測到的不是實際會送的請求');

  // 基準請求就失敗(例如 key 無效):不能把任何一項判成「不支援」
  const bad = endpoint({ '/v1/models': () => ({ json: { data: [] } }), '/v1/chat/completions': () => ({ status: 401, json: { error: 'bad key' } }) });
  const b = createOpenAIAdapter({ id: 'y', type: 'openai', baseUrl: 'https://api.test/v1', models: 'auto', apiKeyEnv: 'RT_TEST_KEY' }, { fetchImpl: bad.fetchImpl });
  const failed = await b.modelCapability('m', { live: true });
  assert.ok(failed.error && /401/.test(failed.error));
  assert.ok(failed.tools === undefined && failed.images === undefined);
  assert.strictEqual(bad.chats().length, 1, '基準失敗就停,不再多花錢');
});

test('端點收下 tools 卻從來不呼叫:說「不確定」,不說「可以呼叫工具」', async () => {
  process.env.RT_TEST_KEY = 'k';
  // 代理層、轉送層與部分 LM Studio 設定會把 tools 參數照單全收回 200,然後只回一段文字。
  // 只看狀態碼的話會斬釘截鐵說「可以」,使用者就把改檔的工作派給一個不會呼叫工具的成員。
  const silent = endpoint({
    '/v1/models': () => ({ json: { data: [{ id: 'm' }] } }),
    '/v1/chat/completions': () => ({ json: { choices: [{ message: { role: 'assistant', content: 'OK' } }] } }),
  });
  const a = createOpenAIAdapter({ id: 'x', type: 'openai', baseUrl: 'https://api.test/v1', models: 'auto', apiKeyEnv: 'RT_TEST_KEY' }, { fetchImpl: silent.fetchImpl });
  const quiet = await a.modelCapability('m', { live: true });
  assert.strictEqual(quiet.tools, undefined, '收下了但沒呼叫,就是不確定');

  // 真的回了一顆 tool_call:這時才算數
  const real = endpoint({
    '/v1/models': () => ({ json: { data: [{ id: 'm' }] } }),
    '/v1/chat/completions': (b: any) => (b.tools
      ? { json: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{}' } }] } }] } }
      : { json: { choices: [{ message: { role: 'assistant', content: 'OK' } }] } }),
  });
  const b = createOpenAIAdapter({ id: 'y', type: 'openai', baseUrl: 'https://api.test/v1', models: 'auto', apiKeyEnv: 'RT_TEST_KEY' }, { fetchImpl: real.fetchImpl });
  assert.strictEqual((await b.modelCapability('m', { live: true })).tools, true);
});

test('能力快取:實際測試與模型資料存檔;Ollama 的回報不存;換端點就是另一筆', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-caps-')), 'caps.json');
  const s = new CapabilityStore(file);
  s.set(capabilityKey('deepseek', 'https://a/v1', 'm'), { model: 'm', tools: true, source: 'probe', at: 1 });
  s.set(capabilityKey('ollama', 'http://l/v1', 'g'), { model: 'g', tools: false, source: 'ollama', at: 1 });
  const again = new CapabilityStore(file);
  assert.strictEqual(again.get(capabilityKey('deepseek', 'https://a/v1', 'm')).tools, true);
  assert.strictEqual(again.get(capabilityKey('ollama', 'http://l/v1', 'g')), undefined, 'Ollama 每次開 app 重新查');
  assert.strictEqual(again.get(capabilityKey('deepseek', 'https://b/v1', 'm')), undefined);
  fs.writeFileSync(file, '{ 壞掉的檔案');
  assert.strictEqual(new CapabilityStore(file).get(capabilityKey('deepseek', 'https://a/v1', 'm')), undefined, '壞掉的檔案當成什麼都不知道');
});

test('registry:先看快取;按「測試」一定重測', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-capreg-'));
  fs.writeFileSync(path.join(dir, 'local.json'), JSON.stringify({ id: 'local', type: 'openai', label: 'Local', baseUrl: 'http://127.0.0.1:11434/v1', models: 'auto', supportsEdit: true, fileTools: { enabled: true } }));
  const e = endpoint({
    '/v1/models': () => ({ json: { data: [{ id: 'gemma3:latest' }] } }),
    '/api/show': OLLAMA_SHOW,
    '/v1/chat/completions': (b: any) => (b.tools ? { status: 400, json: {} } : { json: { choices: [{ message: { content: 'OK' } }] } }),
  });
  setCapabilityStore(new CapabilityStore());
  const reg = new Registry({ userDir: dir, fetchImpl: e.fetchImpl });
  const first = await reg.modelCapability('local', 'gemma3:latest');
  assert.strictEqual(first.tools, false);
  const shows = e.calls.filter((c) => c.path === '/api/show').length;
  await reg.modelCapability('local', 'gemma3:latest');
  assert.strictEqual(e.calls.filter((c) => c.path === '/api/show').length, shows, '第二次用快取');
  const live = await reg.modelCapability('local', 'gemma3:latest', true);
  assert.strictEqual(live.source, 'probe');
  assert.strictEqual(e.chats().length, 3);
  assert.strictEqual(await reg.modelCapability('claude', ''), null, 'CLI 成員沒有這份資料');
});

// ---------- code review 找到的:快取的邊界 ----------

function localRegistry(chat: (b: any) => { status?: number; json?: any }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-capmerge-'));
  fs.writeFileSync(path.join(dir, 'local.json'), JSON.stringify({ id: 'local', type: 'openai', label: 'Local', baseUrl: 'http://127.0.0.1:11434/v1', models: 'auto', supportsEdit: true, fileTools: { enabled: true } }));
  const e = endpoint({ '/v1/models': () => ({ json: { data: [{ id: 'gemma3:latest' }] } }), '/api/show': OLLAMA_SHOW, '/v1/chat/completions': chat });
  return { reg: new Registry({ userDir: dir, fetchImpl: e.fetchImpl }), e };
}
const gemmaMember = (model: string) => ({ id: 'g', name: 'Gemma', cli: 'local', model, enabled: true, canEdit: true, color: '#000', persona: '', effort: '', customCommand: '' });

// 以前一次失敗的測試會把「不能呼叫工具」洗成「不知道」並存檔:成員又拿到寫入工具、又被拒絕,重開 app 也一樣
test('測試整個沒完成:保留之前知道的,不存這次的失敗', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-capfile-')), 'caps.json');
  setCapabilityStore(new CapabilityStore(file));
  const { reg } = localRegistry(() => ({ status: 503, json: { error: 'busy' } }));
  adapters.setRegistry(reg);
  assert.strictEqual((await reg.modelCapability('local', 'gemma3:latest')).tools, false, '前提:Ollama 說不能呼叫工具');
  const live = await reg.modelCapability('local', 'gemma3:latest', true);
  assert.ok(live.error && /503/.test(live.error), '這次的失敗要帶回給介面顯示');
  assert.strictEqual(live.tools, false, '之前知道的照樣回傳');
  assert.strictEqual(adapters.effectiveCanEdit(gemmaMember('gemma3:latest')), false, '仍然當唯讀成員');
  assert.ok(!fs.existsSync(file) || !/busy|503/.test(fs.readFileSync(file, 'utf8')), '失敗不存檔');
});

test('測試只有部分下結論:沒結論的項目保留之前知道的', async () => {
  setCapabilityStore(new CapabilityStore());
  // 基準成功、帶工具的請求 503(不下結論)、帶圖片的成功
  const { reg } = localRegistry((b: any) => (b.tools ? { status: 503, json: {} } : { json: { choices: [{ message: { content: 'OK' } }] } }));
  await reg.modelCapability('local', 'gemma3:latest');
  const live = await reg.modelCapability('local', 'gemma3:latest', true);
  assert.deepStrictEqual([live.tools, live.images, live.source], [false, true, 'probe']);
});

// 清單還沒載入時,gemma3 不會被對應成 gemma3:latest,結果存在一個流程之後查不到的名字下
test('成員寫的是別名:先載入清單再對應,流程查得到', async () => {
  const store = new CapabilityStore();
  setCapabilityStore(store);
  const { reg } = localRegistry(() => ({ json: {} }));
  adapters.setRegistry(reg);
  await reg.modelCapability('local', 'gemma3');
  assert.ok(store.get(capabilityKey('local', 'http://127.0.0.1:11434/v1', 'gemma3:latest')), '存在完整名稱下');
  assert.strictEqual(adapters.effectiveCanEdit(gemmaMember('gemma3')), false);
});

test('結果只存在原本的寫法下:流程照樣查得到', async () => {
  const store = new CapabilityStore();
  setCapabilityStore(store);
  const { reg } = localRegistry(() => ({ json: {} }));
  adapters.setRegistry(reg);
  await reg.get('local').refreshModels();
  store.set(capabilityKey('local', 'http://127.0.0.1:11434/v1', 'gemma3'), { model: 'gemma3', tools: false, source: 'probe', at: 1 });
  assert.strictEqual(adapters.effectiveCanEdit(gemmaMember('gemma3')), false);
});

// 已知不能呼叫工具:給它寫入工具只會換來一個被拒絕的請求,審查時的唯讀工具也一樣
test('已知不能呼叫工具的模型:當唯讀成員,審查時直接附上內容', async () => {
  const store = new CapabilityStore();
  setCapabilityStore(store);
  store.set(capabilityKey('api', 'http://x/v1', 'gemma3'), { model: 'gemma3', tools: false, source: 'ollama', at: 1 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-captool-'));
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  let seen: any = null;
  adapters.setRegistry({ get: (id: string) => ({
    exec: { id: 'exec', supportsEdit: true, supportsResume: false, capabilities: { attachments: ['filePath'] }, run: async () => ({ text: '' }) },
    api: { id: 'api', type: 'openai', supportsEdit: true, supportsResume: false, endpoint: 'http://x/v1', capabilities: { attachments: ['textInline'] },
      resolveModel: (m: string) => m || 'gemma3', run: async (_a: any, ctx: any) => { seen = ctx; return { text: '[NO_ISSUES]' }; } },
  } as any)[id] || null });
  const gemma = { id: 'g', name: 'Gemma', cli: 'api', model: 'gemma3', enabled: true, canEdit: true, color: '#000', persona: '', effort: '', customCommand: '' };
  const qwen = { ...gemma, id: 'q', name: 'Qwen', model: 'qwen3' };
  assert.strictEqual(adapters.effectiveCanEdit(gemma), false, '不能呼叫工具就改不了檔');
  assert.strictEqual(adapters.effectiveCanEdit(qwen), true, '不知道的照舊');
  const exec = { id: 'e', name: '執行者', cli: 'exec', enabled: true, canEdit: true, color: '#000', persona: '', model: '', effort: '', customCommand: '' };
  const settings = { maxTranscriptChars: 0, language: '繁體中文', workDir: dir, maxRounds: 1, mode: 'divide', uiLocale: 'zh-Hant', leadAgentId: 'e' };
  const orc = new O.Orchestrator({ get: () => ({ agents: [exec, gemma], settings }), userDataDir: os.tmpdir() });
  await orc.reviewPhase([exec, gemma], [{ agent: exec, task: '改 a.ts', report: '改好了', error: null, toolEvents: [] }], ['a.ts']);
  assert.ok(seen && !seen.readOnlyFileTools, '不送工具');
  assert.ok(seen.prompt.includes('export const a = 1;'), '改為附上內容');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 已知不能看圖:以前圖片照樣送出、被端點拒絕,再靠重送拿掉——每次多等一輪,
// 附件區塊還跟它說「影像已隨訊息附上」。現在直接照「不收圖片」的成員處理。
test('已知不能看圖的模型:不送圖片,附件區塊照實說它看不到;不知道的照舊送', async () => {
  const A = require('../src/attachments');
  const store = new CapabilityStore();
  setCapabilityStore(store);
  store.set(capabilityKey('api', 'http://x/v1', 'gemma3'), { model: 'gemma3', images: false, source: 'ollama', at: 1 });
  const seen: Record<string, any> = {};
  adapters.setRegistry({ get: (id: string) => (id === 'api' ? {
    id: 'api', type: 'openai', supportsEdit: false, supportsResume: false, endpoint: 'http://x/v1',
    capabilities: { attachments: ['textInline', 'imageInline'] }, resolveModel: (m: string) => m || 'gemma3',
    run: async (agent: any, ctx: any) => { seen[agent.name] = ctx; return { text: '看了' }; },
  } : null) });
  const member = (id: string, name: string, model: string) => ({ id, name, cli: 'api', model, enabled: true, canEdit: false, color: '#000', persona: '', effort: '', customCommand: '' });
  const agents = [member('g', 'Gemma', 'gemma3'), member('q', 'Qwen', 'qwen3')];
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-capimg-ud-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-capimg-wd-'));
  const settings = { maxTranscriptChars: 0, language: '繁體中文', workDir: work, maxRounds: 1, mode: 'divide', uiLocale: 'zh-Hant', leadAgentId: 'g' };
  const orc = new O.Orchestrator({ get: () => ({ agents, settings }), userDataDir: userData });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
  const { added } = A.addAttachments(userData, orc.conversationId, [{ name: 'shot.png', data: png }]);
  assert.strictEqual(added.length, 1, '前提:圖片附件建立成功');
  const done = new Promise<void>((r) => { const f = (st: any) => { if (!st.running && st.phase && st.phase.code === 'idle') { orc.off('state', f); r(); } }; orc.on('state', f); });
  await orc.userMessage('@Gemma @Qwen 看這張圖', 'divide', added);
  await done;
  assert.ok(seen.Gemma && seen.Qwen, '兩位都有回覆');
  assert.ok(!seen.Gemma.attachments.some((a: any) => a.kind === 'image'), '不能看圖的不送圖片');
  assert.match(seen.Gemma.prompt, /你無法讀取 shot\.png/, '附件區塊照實說它看不到');
  assert.doesNotMatch(seen.Gemma.prompt, /影像已隨訊息附上/);
  assert.ok(seen.Qwen.attachments.some((a: any) => a.kind === 'image'), '不知道的照舊送');
  assert.match(seen.Qwen.prompt, /影像已隨訊息附上/);
  for (const d of [userData, work]) fs.rmSync(d, { recursive: true, force: true });
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} model capability tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
