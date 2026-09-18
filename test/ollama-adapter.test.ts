'use strict';

const assert = require('assert');
const { createOpenAIAdapter, validateOpenAISpec } = require('../src/adapters/openai-adapter');
const { Registry } = require('../src/adapters/registry');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

function makeCtx(extra: any = {}) {
  return {
    prompt: 'hello',
    systemPrompt: 'SYS',
    sessionId: null,
    cwd: process.cwd(),
    timeoutMs: 5000,
    onText: () => {},
    onThinking: () => {},
    onActivity: () => {},
    onSession: () => {},
    onProc: () => {},
    ...extra,
  };
}

test('spec 逾時優先於 ctx', async () => {
  const adapter = createOpenAIAdapter({
    id: 'timed', type: 'openai', baseUrl: 'http://local.test/v1', models: ['qwen3:8b'], timeoutMs: 20,
  }, {
    fetchImpl: (_url: any, options: any) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error: any = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });
  const result = await adapter.run({ model: 'qwen3:8b' }, makeCtx());
  assert.ok(/逾時/.test(result.error), result.error);
});

test('maxHistoryMessages 會裁切較舊回合', async () => {
  const bodies: any[] = [];
  const adapter = createOpenAIAdapter({
    id: 'capped', type: 'openai', baseUrl: 'http://local.test/v1', models: ['qwen3:8b'],
    stream: false, maxHistoryMessages: 2,
  }, {
    fetchImpl: async (_url: any, options: any) => {
      bodies.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: `回答 ${bodies.length}` } }] }) };
    },
  });
  const first = await adapter.run({ model: 'qwen3:8b' }, makeCtx({ prompt: '第一題' }));
  const second = await adapter.run({ model: 'qwen3:8b' }, makeCtx({ prompt: '第二題', sessionId: first.sessionId }));
  await adapter.run({ model: 'qwen3:8b' }, makeCtx({ prompt: '第三題', sessionId: second.sessionId }));
  assert.deepStrictEqual(bodies[2].messages.map((message: any) => `${message.role}:${message.content}`), [
    'system:SYS', 'user:第二題', 'assistant:回答 2', 'user:第三題',
  ]);
});

test('maxHistoryMessages 為 0 或負數時防禦性退回 80，不會保留全部歷史', async () => {
  for (const invalid of [0, -1]) {
    const bodies: any[] = [];
    const adapter = createOpenAIAdapter({
      id: `fallback-${invalid}`, type: 'openai', baseUrl: 'http://local.test/v1', models: ['qwen3:8b'],
      stream: false, maxHistoryMessages: invalid,
    }, {
      fetchImpl: async (_url: any, options: any) => {
        bodies.push(JSON.parse(options.body));
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: `回答 ${bodies.length}` } }] }) };
      },
    });
    let sessionId: string | null = null;
    for (let i = 1; i <= 42; i++) {
      const result: any = await adapter.run({ model: 'qwen3:8b' }, makeCtx({ prompt: `問題 ${i}`, sessionId }));
      sessionId = result.sessionId;
    }
    const messages = bodies.at(-1).messages;
    assert.strictEqual(messages.length, 82, `${invalid} 應退回 system + 80 則歷史 + 本輪問題`);
    assert.ok(!messages.some((message: any) => message.content === '問題 1'), '最舊回合必須被裁掉');
    assert.ok(messages.some((message: any) => message.content === '問題 2'), '80 則歷史的邊界應保留');
  }
});

test('免金鑰本機端點連不上回報 unreachable', async () => {
  const adapter = createOpenAIAdapter({
    id: 'ollama', type: 'openai', baseUrl: 'http://localhost:11434/v1', models: 'auto',
    unreachableHint: '請先執行 ollama serve',
  }, {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  const failed = await adapter.testConnection();
  assert.strictEqual(failed.state, 'unreachable');
  assert.ok(/ollama serve/.test(failed.hint) && /ECONNREFUSED/.test(failed.error));
  assert.ok(!/ollama serve/.test(failed.error), '啟動提示不應在 error 與 hint 重複');

  const generic = createOpenAIAdapter({
    id: 'local', type: 'openai', baseUrl: 'http://localhost:9999/v1', models: 'auto',
  }, {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  const genericFailed = await generic.testConnection();
  assert.strictEqual(genericFailed.hint, '請確認服務已啟動並可連線');
  assert.ok(!/ollama/.test(genericFailed.hint), '非 Ollama 端點不得收到 Ollama 專屬指令');
});

test('apiKeyOptional 不會讓 check 與 testConnection 擋下請求', async () => {
  const adapter = createOpenAIAdapter({
    id: 'optional', type: 'openai', baseUrl: 'http://local.test/v1', apiKeyEnv: 'UNSET_OPTIONAL_KEY',
    apiKeyOptional: true, models: ['m'],
  }, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }),
  });
  assert.strictEqual((await adapter.check()).ok, true);
  assert.strictEqual((await adapter.testConnection()).ok, true);
});

test('Registry.checkAll 正規化狀態且不改變 CLI missing 判定', async () => {
  const reg: any = new Registry();
  const local = createOpenAIAdapter({
    id: 'ollama', type: 'openai', baseUrl: 'http://localhost:11434/v1', models: 'auto',
    unreachableHint: '請先執行 ollama serve',
  }, {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  process.env.CLOUD_TEST_KEY = 'configured';
  let cloudFetches = 0;
  const cloud = createOpenAIAdapter({
    id: 'cloud', type: 'openai', baseUrl: 'https://cloud.example/v1', apiKeyEnv: 'CLOUD_TEST_KEY', models: ['m'],
  }, {
    fetchImpl: async () => { cloudFetches++; throw new Error('offline'); },
  });
  reg.adapters = new Map([
    ['ollama', { ...local, origin: 'user' }],
    ['cloud', { ...cloud, origin: 'user' }],
    ['fake-cli', {
      id: 'fake-cli', label: 'Fake CLI', type: 'cli', origin: 'user', bin: 'fake',
      supportsResume: false, supportsEdit: true, efforts: [],
      check: async () => ({ ok: false, error: '找不到指令 fake' }),
      run: async () => ({}),
    }],
  ]);
  const health = await reg.checkAll();
  assert.strictEqual(health.ollama.state, 'unreachable');
  assert.strictEqual(health.cloud.state, 'ready', '已設定 key 的雲端 API 離線時不能誤報 unauthenticated');
  assert.strictEqual(cloudFetches, 0, 'checkAll 不應在啟動健康檢查時連線到有 credential 的雲端 API');
  assert.strictEqual(health['fake-cli'].state, 'missing');

  // 使用者打開設定時才真的驗證。離線要說「連不上」,不能說「尚未登入」——方向相反。
  const probed = await reg.checkAll({ probeCredentialed: true });
  assert.strictEqual(probed.cloud.state, 'unreachable', '有 key 但離線時應為 unreachable');
  assert.ok(probed.cloud.hint, 'unreachable 必須帶可照做的 hint');
  assert.ok(cloudFetches > 0, 'probeCredentialed 時應該真的連線');
  delete process.env.CLOUD_TEST_KEY;
});

// 只檢查「key 有沒有填」會對過期或打錯的 key 亮綠燈,而使用者正要依燈號判斷能不能開會。
test('無效的 API key 在驗證時回報 unauthenticated,不是 ready', async () => {
  process.env.BAD_KEY_TEST = 'sk-invalid';
  const reg = new Registry({ userDir: null, templatesDir: null });
  const cloud = createOpenAIAdapter({
    id: 'bad', type: 'openai', baseUrl: 'https://cloud.example/v1', apiKeyEnv: 'BAD_KEY_TEST', models: ['m'],
  }, {
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'Authentication Fails' }),
  });
  reg.adapters = new Map([['bad', { ...cloud, origin: 'user' }]]);

  // 啟動時不驗證,維持舊行為(不打付費端點)
  const quiet = await reg.checkAll();
  assert.strictEqual(quiet.bad.state, 'ready', '啟動健康檢查不連線,維持既有行為');

  const probed = await reg.checkAll({ probeCredentialed: true });
  assert.strictEqual(probed.bad.state, 'unauthenticated', '401 必須回報成金鑰問題');
  assert.strictEqual(probed.bad.ok, false);
  assert.match(probed.bad.hint, /重新填入/, 'hint 要指出可以去哪裡修');
  delete process.env.BAD_KEY_TEST;
});

test('maxHistoryMessages 與 unreachableHint 驗證設定型別', () => {
  for (const invalid of [0, -1, 1.5]) {
    const errors: string[] = [];
    validateOpenAISpec({ baseUrl: 'http://localhost:11434/v1', maxHistoryMessages: invalid }, errors);
    assert.ok(errors.some((error) => /maxHistoryMessages.*正整數/.test(error)), `應拒絕 ${invalid}`);
  }
  const hintErrors: string[] = [];
  validateOpenAISpec({ baseUrl: 'http://localhost:11434/v1', unreachableHint: 123 }, hintErrors);
  assert.ok(hintErrors.some((error) => /unreachableHint.*字串/.test(error)));
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    await fn();
    passed++;
    console.log('ok -', name);
  }
  console.log(`\n${passed}/${tests.length} Ollama adapter tests passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
