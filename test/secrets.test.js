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
  encryptString(value) { return Buffer.from(`encrypted:${[...value].reverse().join('')}`); },
  decryptString(value) { return [...value.toString().replace(/^encrypted:/, '')].reverse().join(''); },
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

  const errors = [];
  validateCommon({ id: 'x', capabilities: { attachments: ['filePath', 'bad'], attachmentsNeedCwd: 'yes' } }, errors);
  assert.ok(errors.some((e) => e.includes('只接受')));
  assert.ok(errors.some((e) => e.includes('布林值')));
  assert.deepStrictEqual(normalizeCapabilities(null, ['filePath']), { attachments: ['filePath'], attachmentsNeedCwd: false });

  const legacyErrors = [];
  validateOpenAISpec({ baseUrl: 'https://example.com', apiKey: 'plain' }, legacyErrors);
  assert.ok(legacyErrors.some((e) => e.includes('明文')));

  process.env.SECRET_FALLBACK = 'env-key';
  const seen = [];
  const adapter = createOpenAIAdapter({
    id: 'api', baseUrl: 'https://example.com/v1', secretRef: 'adapter:api', apiKeyEnv: 'SECRET_FALLBACK', models: ['m'],
  }, {
    getSecret: () => 'stored-key',
    fetchImpl: async (_url, options) => {
      seen.push(options.headers.Authorization);
      return { ok: true, text: async () => '', json: async () => ({ data: [] }) };
    },
  });
  assert.deepStrictEqual(adapter.capabilities.attachments, ['imageInline', 'textInline']);
  assert.strictEqual((await adapter.testConnection()).ok, true);
  assert.strictEqual(seen[0], 'Bearer stored-key');
  delete process.env.SECRET_FALLBACK;

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok - secrets 安全儲存、key 優先序與 capabilities 驗證');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
