'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SecretStore } = require('../src/secrets');
const { validateCommon, normalizeCapabilities } = require('../src/adapters/spec');
const { validateOpenAISpec, createOpenAIAdapter } = require('../src/adapters/openai-adapter');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-roundtable-secrets-'));
const fakeSafeStorage = {
  available: true,
  isEncryptionAvailable() { return this.available; },
  encryptString(value: any) { return Buffer.from(`encrypted:${[...value].reverse().join('')}`); },
  decryptString(value: any) { return [...value.toString().replace(/^encrypted:/, '')].reverse().join(''); },
};

(async () => {
  const store = new SecretStore(dir, fakeSafeStorage);
  const status = store.set('adapter:test', 'sk-secret-1234');
  assert.deepStrictEqual(status, { configured: true, source: 'safeStorage', hint: 'sk-…1234' });
  assert.strictEqual(store.get('adapter:test'), 'sk-secret-1234');
  assert.ok(!fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8').includes('sk-secret-1234'));

  const reloaded = new SecretStore(dir, fakeSafeStorage);
  assert.strictEqual(reloaded.get('adapter:test'), 'sk-secret-1234');
  assert.deepStrictEqual(reloaded.clear('adapter:test'), { configured: false, source: null, hint: '' });

  fakeSafeStorage.available = false;
  assert.throws(() => store.set('adapter:nope', 'secret'), /環境變數/);
  fakeSafeStorage.available = true;
  assert.throws(() => store.set('../bad', 'secret'), /secretRef/);

  // secretRef 恰好是 Object.prototype 上的名稱時,沒存過就是未設定,存了也要能正常讀寫
  for (const ref of ['toString', 'constructor', 'valueOf']) {
    assert.deepStrictEqual(store.status(ref), { configured: false, source: null, hint: '' });
    assert.strictEqual(store.get(ref), '');
  }
  store.set('toString', 'sk-proto-5678');
  assert.strictEqual(new SecretStore(dir, fakeSafeStorage).get('toString'), 'sk-proto-5678');
  store.clear('toString');

  const errors: any[] = [];
  validateCommon({ id: 'x', capabilities: { attachments: ['filePath', 'bad'], attachmentsNeedCwd: 'yes' } }, errors);
  assert.ok(errors.some((e: any) => e.includes('只接受')));
  assert.ok(errors.some((e: any) => e.includes('布林值')));
  assert.deepStrictEqual(normalizeCapabilities(null, ['filePath']), { attachments: ['filePath'], attachmentsNeedCwd: false });

  const legacyErrors: any[] = [];
  validateOpenAISpec({ baseUrl: 'https://example.com', apiKey: 'plain' }, legacyErrors);
  assert.ok(legacyErrors.some((e: any) => e.includes('明文')));

  process.env.SECRET_FALLBACK = 'env-key';
  const seen: any[] = [];
  const adapter = createOpenAIAdapter({
    id: 'api', baseUrl: 'https://example.com/v1', secretRef: 'adapter:api', apiKeyEnv: 'SECRET_FALLBACK', models: ['m'],
  }, {
    getSecret: () => 'stored-key',
    fetchImpl: async (_url: any, options: any) => {
      seen.push(options.headers.Authorization);
      return { ok: true, text: async () => '', json: async () => ({ data: [] }) };
    },
  });
  assert.deepStrictEqual(adapter.capabilities.attachments, ['textInline']);
  assert.strictEqual((await adapter.testConnection()).ok, true);
  assert.strictEqual(seen[0], 'Bearer stored-key');
  delete process.env.SECRET_FALLBACK;

  // secrets.json 損壞:原檔改名備份,下一次 set 不會把舊 key 一起蓋掉
  const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-roundtable-secrets-corrupt-'));
  fs.writeFileSync(path.join(corruptDir, 'secrets.json'), '{ 壞掉');
  const corrupt = new SecretStore(corruptDir, fakeSafeStorage);
  assert.ok(corrupt.backupFile && fs.readFileSync(corrupt.backupFile, 'utf8') === '{ 壞掉');
  corrupt.set('adapter:new', 'sk-new-key-0000');
  assert.strictEqual(new SecretStore(corruptDir, fakeSafeStorage).get('adapter:new'), 'sk-new-key-0000');
  fs.rmSync(corruptDir, { recursive: true, force: true });

  // 端點拒收圖片時略過圖片改用純文字重送,記憶裡只留最近一則的影像
  const imagePath = path.join(dir, 'pic.png');
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const bodies: any[] = [];
  const notes: any[] = [];
  const visionless = createOpenAIAdapter({
    id: 'nov', baseUrl: 'https://example.com/v1', models: ['m'], stream: false, capabilities: { attachments: ['imageInline', 'textInline'] },
  }, {
    fetchImpl: async (_url: any, options: any) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      const last = body.messages[body.messages.length - 1];
      if (Array.isArray(last.content)) return { ok: false, status: 400, text: async () => '{"error":{"message":"image_url is not supported"}}' };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '好' } }] }) };
    },
  });
  const ctx = (sessionId: any) => ({
    prompt: '看圖', sessionId, attachments: [{ kind: 'image', mime: 'image/png', path: imagePath }],
    onProc: () => {}, onText: () => {}, onThinking: () => {}, onActivity: (a: any) => notes.push(a), onSession: () => {},
  });
  const first = await visionless.run({ model: 'm' }, ctx(null));
  assert.strictEqual(first.error, null);
  assert.strictEqual(first.text, '好');
  assert.strictEqual(bodies.length, 2, '被拒後重送一次');
  assert.strictEqual(typeof bodies[1].messages.at(-1).content, 'string');
  assert.ok(notes.some((n: any) => n.id === 'image-fallback'));

  const { compactHistoryImages } = require('../src/adapters/openai-adapter');
  const img = (t: any) => [{ type: 'text', text: t }, { type: 'image_url', image_url: { url: 'data:x' } }];
  const compacted = compactHistoryImages([{ role: 'user', content: img('舊') }, { role: 'assistant', content: 'a' }, { role: 'user', content: img('新') }]);
  assert.ok(typeof compacted[0].content === 'string' && compacted[0].content.includes('舊') && compacted[0].content.includes('1 張圖片'));
  assert.ok(Array.isArray(compacted[2].content), '最近一則帶圖訊息保留影像');

  // 測試連線用獨立實例,不重建 registry(進行中 API 成員的對話記憶不能被清掉)
  const { Registry } = require('../src/adapters/registry');
  const extDir = path.join(dir, 'ext');
  fs.mkdirSync(extDir);
  fs.writeFileSync(path.join(extDir, 'api.json'), JSON.stringify({ id: 'api', type: 'openai', baseUrl: 'https://a.example/v1', models: ['m'] }));
  fs.writeFileSync(path.join(extDir, 'plug.js'), "module.exports = { id: 'plug', supportsEdit: true, run: async () => ({ text: '' }) };");
  const reg = new Registry({ userDir: extDir });
  const registered = reg.get('api');
  fs.writeFileSync(path.join(extDir, 'api.json'), JSON.stringify({ id: 'api', type: 'openai', baseUrl: 'https://b.example/v1', models: ['m'] }));
  const fresh = reg.loadFresh('api');
  assert.notStrictEqual(fresh, registered);
  assert.strictEqual(reg.get('api'), registered, '登錄中的實例不變');
  assert.strictEqual((await fresh.check()).version, 'API https://b.example/v1');
  assert.strictEqual(reg.loadFresh('claude'), reg.get('claude'), '內建轉接器直接回傳');

  // JS 外掛沒宣告 capabilities 時套用退路,而不是「完全不能讀附件」
  const { attachmentCapabilities } = require('../src/attachments');
  assert.strictEqual(reg.get('plug').capabilities, undefined);
  assert.ok(attachmentCapabilities(reg.get('plug')).modes.has('filePath'));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok - secrets 安全儲存、key 優先序與 capabilities 驗證');
})().catch((error: any) => {
  console.error(error);
  process.exitCode = 1;
});
