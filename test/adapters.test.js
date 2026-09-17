'use strict';
// 擴充系統測試:用假 CLI 與本機假 API 伺服器跑完整流程。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { Registry } = require('../src/adapters/registry');
const { createCliAdapter, validateCliSpec } = require('../src/adapters/cli-adapter');
const { createOpenAIAdapter } = require('../src/adapters/openai-adapter');
const { buildArgs, render, matches, renderDeep } = require('../src/adapters/template');
const adapters = require('../src/adapters');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-roundtable-adapters-'));
const tests = [];
const t = (name, fn) => tests.push({ name, fn });

// 收集回呼的 ctx
function makeCtx(extra = {}) {
  const log = { texts: [], thinking: [], activities: [], sessions: [], procs: [] };
  const ctx = {
    prompt: 'hello',
    systemPrompt: 'SYS',
    sessionId: null,
    cwd: tmp,
    timeoutMs: 15000,
    onText: (x) => log.texts.push(x),
    onThinking: (x) => log.thinking.push(x),
    onActivity: (a) => log.activities.push(a),
    onSession: (id) => log.sessions.push(id),
    onProc: (p) => log.procs.push(p),
    ...extra,
  };
  return { ctx, log };
}

// 假 CLI:把收到的參數、stdin、環境變數回報成 JSONL,並依參數決定輸出內容
const fakeCli = path.join(tmp, 'fake-cli.js');
fs.writeFileSync(fakeCli, `
const args = process.argv.slice(2);
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const mode = process.env.FAKE_MODE || 'jsonl';
  const fileIdx = args.indexOf('--prompt-file');
  const fromFile = fileIdx >= 0 ? require('fs').readFileSync(args[fileIdx + 1], 'utf8') : '';
  if (mode === 'text') { process.stdout.write('line1\\nline2\\n'); return; }
  if (mode === 'json') { out({ text: 'final:' + stdin, sessionId: 'json-session' }); return; }
  if (mode === 'fail') { process.stderr.write('boom'); process.exit(3); }
  if (mode === 'stderr-session') { process.stderr.write('session id: abc-123\\n'); process.stdout.write('ok\\n'); return; }
  out({ type: 'init', session_id: 'sess-1' });
  out({ type: 'echo', args, stdin, fromFile, env: process.env.FAKE_VAR || null });
  out({ type: 'delta', text: 'Hel' });
  out({ type: 'delta', text: 'lo' });
  out({ type: 'msg', content: 'Second' });
  out({ type: 'think', text: 'hmm' });
  out({ type: 'calls', calls: [{ id: 'c1', name: 'Read' }, { id: 'c2', name: 'Bash' }] });
  out({ type: 'usage', usage: { input_tokens: 5, output_tokens: 7 } });
  process.stdout.write('not json line\\n');
});
`);

function cliSpec(overrides = {}) {
  return {
    id: 'fake',
    type: 'cli',
    bin: process.execPath,
    args: [fakeCli, ['-m', '{model}'], ['--effort', '{effort}'], ['--resume', '{sessionId}'], { if: 'canEdit', then: ['--yolo'], else: ['--read-only'] }],
    output: {
      format: 'jsonl',
      rules: [
        { match: { type: 'init' }, sessionId: 'session_id' },
        { match: { type: 'delta' }, text: 'text' },
        { match: { type: 'msg' }, text: 'content', mode: 'message' },
        { match: { type: 'think' }, thinking: 'text' },
        { match: { type: 'calls' }, each: 'calls', activity: { id: '{id}', title: '工具:{name}', status: 'running' } },
        { match: { type: 'usage' }, usage: 'usage' },
      ],
    },
    models: [{ id: 'm-1', aliases: ['m'], efforts: ['low', 'high'] }],
    ...overrides,
  };
}

// ---------- 範本工具 ----------
t('buildArgs:空佔位略過單一參數與整組,條件分支', () => {
  const vars = { model: 'x', effort: '', canEdit: false, sessionId: '' };
  assert.deepStrictEqual(
    buildArgs(['-p', '{model}', '{effort}', ['--e', '{effort}'], ['--m', '{model}'], { if: 'canEdit', then: ['--yolo'], else: ['--safe'] }, { if: '!sessionId', then: ['--new'] }, { if: 'model=x', then: ['--is-x'] }], vars),
    ['-p', 'x', '--m', 'x', '--safe', '--new', '--is-x'],
  );
});

t('render 與 renderDeep:跳脫大括號、保留單一佔位的型別', () => {
  assert.strictEqual(render('{{literal}} {a.b}', { a: { b: 1 } }), '{literal} 1');
  assert.deepStrictEqual(renderDeep({ n: '{num}', s: 'v={num}', arr: ['{obj}'] }, { num: 3, obj: { k: 1 } }), { n: 3, s: 'v=3', arr: [{ k: 1 }] });
});

t('matches:字面值、陣列、$exists、$startsWith、$ne、$regex', () => {
  const ev = { type: 'item.completed', n: 2, nested: { ok: true } };
  assert.ok(matches(ev, { type: { $startsWith: 'item.' }, 'nested.ok': true, n: [1, 2] }));
  assert.ok(matches(ev, { missing: { $exists: false }, type: { $regex: 'completed$' }, n: { $ne: 3 } }));
  assert.ok(!matches(ev, { type: 'item.started' }));
});

// ---------- CLI 轉接器 ----------
t('CLI jsonl:文字累加、訊息分段、思考、工具、usage、session、參數與 stdin', async () => {
  const adapter = createCliAdapter(cliSpec());
  const { ctx, log } = makeCtx();
  const r = await adapter.run({ model: 'm', effort: 'high', canEdit: true }, ctx);
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.text, 'Hello\n\nSecond');
  assert.strictEqual(r.thinking, 'hmm');
  assert.strictEqual(r.sessionId, 'sess-1');
  assert.deepStrictEqual(r.usage, { input_tokens: 5, output_tokens: 7 });
  assert.deepStrictEqual(log.activities.map((a) => a.title), ['工具:Read', '工具:Bash']);
  assert.strictEqual(adapter.supportsResume, true);
  // 別名轉完整名稱、首回合 system prompt 前置到 stdin、canEdit 參數
  assert.ok(log.texts.length >= 3);
});

t('CLI:參數實際送達(別名、強度、續接、唯讀),續接時不再前置 system prompt', async () => {
  let echo;
  const spec = cliSpec();
  spec.output.rules.push({ match: { type: 'echo' }, text: '$event', mode: 'replace' });
  const adapter = createCliAdapter(spec);
  const { ctx } = makeCtx({ sessionId: 'prev', onText: (x) => { if (!echo && x.startsWith('{')) echo = JSON.parse(x); } });
  await adapter.run({ model: 'm', effort: 'ultra', canEdit: false }, ctx);
  assert.deepStrictEqual(echo.args, ['-m', 'm-1', '--effort', 'high', '--resume', 'prev', '--read-only']);
  assert.strictEqual(echo.stdin, 'hello');
});

t('CLI input=arg / file,systemPrompt=arg,env 範本', async () => {
  let echo;
  const spec = cliSpec({
    input: 'file',
    systemPrompt: 'arg',
    env: { FAKE_VAR: 'model={model}' },
    args: [fakeCli, ['--prompt-file', '{promptFile}'], ['--system', '{systemPrompt}'], ['-m', '{model}']],
  });
  spec.output.rules.push({ match: { type: 'echo' }, text: '$event', mode: 'replace' });
  const adapter = createCliAdapter(spec);
  const { ctx } = makeCtx({ onText: (x) => { if (!echo && x.startsWith('{')) echo = JSON.parse(x); } });
  await adapter.run({ model: 'm-1' }, ctx);
  assert.strictEqual(echo.fromFile, 'hello');
  assert.strictEqual(echo.stdin, '');
  assert.ok(echo.args.includes('--system') && echo.args.includes('SYS'));
  assert.strictEqual(echo.env, 'model=m-1');
  const promptFile = echo.args[echo.args.indexOf('--prompt-file') + 1];
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!fs.existsSync(promptFile), '暫存提示詞檔應該被刪除');
});

t('CLI format=text、json、sessionIdPattern(stderr)、非零結束代碼', async () => {
  const text = createCliAdapter(cliSpec({ args: [fakeCli], env: { FAKE_MODE: 'text' }, output: { format: 'text' } }));
  assert.strictEqual((await text.run({}, makeCtx().ctx)).text, 'line1\nline2');

  const json = createCliAdapter(cliSpec({ args: [fakeCli], env: { FAKE_MODE: 'json' }, systemPrompt: 'none', output: { format: 'json', rules: [{ text: 'text', sessionId: 'sessionId' }] } }));
  const jr = await json.run({}, makeCtx().ctx);
  assert.strictEqual(jr.text, 'final:hello');
  assert.strictEqual(jr.sessionId, 'json-session');

  const pat = createCliAdapter(cliSpec({ args: [fakeCli], env: { FAKE_MODE: 'stderr-session' }, output: { format: 'text', sessionIdPattern: 'session id: ([\\w-]+)' } }));
  assert.strictEqual((await pat.run({}, makeCtx().ctx)).sessionId, 'abc-123');

  const fail = createCliAdapter(cliSpec({ args: [fakeCli], env: { FAKE_MODE: 'fail' }, output: { format: 'text' } }));
  const fr = await fail.run({}, makeCtx().ctx);
  assert.ok(/結束代碼 3/.test(fr.error) && /boom/.test(fr.error), fr.error);

  const missing = createCliAdapter(cliSpec({ bin: 'definitely-not-a-real-cli-xyz', args: [] }));
  assert.ok(/無法啟動/.test((await missing.run({}, makeCtx().ctx)).error));
});

t('validateCliSpec:回報錯誤欄位', () => {
  const errors = [];
  validateCliSpec({ bin: '', input: 'pipe', output: { format: 'xml', rules: [{ mode: 'bad' }], sessionIdPattern: '(' } }, errors);
  assert.strictEqual(errors.length, 5, errors.join('\n'));
});

// ---------- OpenAI 相容 API ----------
function startMockApi() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const json = body ? JSON.parse(body) : null;
      requests.push({ url: req.url, auth: req.headers.authorization, extra: req.headers['x-extra'], body: json });
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'zeta-chat' }, { id: 'alpha-chat' }, { id: 'embed-1' }] }));
      }
      if (json && json.model === 'bad') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'invalid key' } }));
      }
      if (json && json.model === 'slow') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'partial' } }] }) + '\n\n');
        return; // 不結束,測試停止
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      send({ choices: [{ delta: { reasoning_content: 'think ' } }] });
      send({ choices: [{ delta: { reasoning_content: 'more' } }] });
      send({ choices: [{ delta: { content: 'Hi ' } }] });
      send({ choices: [{ delta: { content: 'there' } }] });
      send({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } });
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, base: `http://127.0.0.1:${server.address().port}/v1` })));
}

t('API:串流文字與思考、usage、金鑰、額外 header 與 body、強度參數、續接歷史', async () => {
  const { server, requests, base } = await startMockApi();
  try {
    process.env.TEST_API_KEY = 'secret';
    const adapter = createOpenAIAdapter({
      id: 'mock', type: 'openai', baseUrl: base, apiKeyEnv: 'TEST_API_KEY',
      headers: { 'X-Extra': 'yes' },
      body: { temperature: 0.2, tag: 'for {model}' },
      effortBody: { thinking: { type: 'enabled' }, reasoning_effort: '{effort}' },
      models: [{ id: 'mock-pro', aliases: ['pro'], efforts: ['low', 'high'] }],
    });
    assert.strictEqual(adapter.supportsEdit, false);
    const { ctx, log } = makeCtx();
    const r1 = await adapter.run({ model: 'pro', effort: 'max' }, ctx);
    assert.strictEqual(r1.error, null);
    assert.strictEqual(r1.text, 'Hi there');
    assert.strictEqual(r1.thinking, 'think more');
    assert.deepStrictEqual(r1.usage, { prompt_tokens: 3, completion_tokens: 2 });
    assert.ok(r1.sessionId && log.sessions[0] === r1.sessionId);
    const q1 = requests.at(-1);
    assert.strictEqual(q1.auth, 'Bearer secret');
    assert.strictEqual(q1.extra, 'yes');
    assert.strictEqual(q1.body.model, 'mock-pro');
    assert.strictEqual(q1.body.reasoning_effort, 'high'); // max 不支援,降到 high
    assert.deepStrictEqual(q1.body.thinking, { type: 'enabled' });
    assert.strictEqual(q1.body.tag, 'for mock-pro');
    assert.deepStrictEqual(q1.body.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hello' }]);
    assert.ok(log.activities.some((a) => a.kind === 'note'));

    const r2 = await adapter.run({ model: 'mock-pro' }, makeCtx({ prompt: 'again', sessionId: r1.sessionId }).ctx);
    assert.strictEqual(r2.sessionId, r1.sessionId);
    const q2 = requests.at(-1);
    assert.deepStrictEqual(q2.body.messages.map((m) => m.role + ':' + m.content), ['system:SYS', 'user:hello', 'assistant:Hi there', 'user:again']);
    assert.ok(!('reasoning_effort' in q2.body));
  } finally {
    server.close();
    delete process.env.TEST_API_KEY;
  }
});

t('API:自動模型清單與篩選、HTTP 錯誤、缺少金鑰、停止', async () => {
  const { server, base } = await startMockApi();
  try {
    const adapter = createOpenAIAdapter({ id: 'mock', type: 'openai', baseUrl: base, models: 'auto', modelFilter: 'chat$' });
    assert.strictEqual(adapter.listModels().source, 'loading');
    await adapter.refreshModels();
    assert.deepStrictEqual(adapter.listModels().models.map((m) => m.id), ['alpha-chat', 'zeta-chat']);

    const bad = await adapter.run({ model: 'bad' }, makeCtx().ctx);
    assert.ok(/HTTP 401/.test(bad.error) && /invalid key/.test(bad.error), bad.error);
    assert.strictEqual(bad.sessionId, null);

    const noKey = createOpenAIAdapter({ id: 'k', type: 'openai', baseUrl: base, apiKeyEnv: 'NOPE_NOT_SET_KEY', models: ['x'] });
    assert.ok(/NOPE_NOT_SET_KEY/.test((await noKey.run({ model: 'x' }, makeCtx().ctx)).error));
    assert.strictEqual((await noKey.check()).ok, false);

    const { ctx, log } = makeCtx();
    const pending = adapter.run({ model: 'slow' }, ctx);
    await new Promise((r) => setTimeout(r, 300));
    log.procs[0].kill();
    const stopped = await pending;
    assert.strictEqual(stopped.text, 'partial');
    assert.strictEqual(stopped.error, '已停止');
  } finally {
    server.close();
  }
});

// ---------- 登錄中心 ----------
t('Registry:載入 JSON 與 JS、回報錯誤、重複 id、覆寫內建、重新載入', () => {
  const dir = path.join(tmp, 'reg1');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify({ id: 'good', type: 'cli', bin: 'echo' }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ nope');
  fs.writeFileSync(path.join(dir, 'badtype.json'), JSON.stringify({ id: 'bt', type: 'grpc' }));
  fs.writeFileSync(path.join(dir, 'zdup.json'), JSON.stringify({ id: 'good', type: 'openai', baseUrl: 'https://x' }));
  fs.writeFileSync(path.join(dir, 'codex.json'), JSON.stringify({ id: 'codex', type: 'cli', bin: 'my-codex' }));
  fs.writeFileSync(path.join(dir, 'plugin.js'), "module.exports = (kit) => ({ id: 'plug', label: 'Plug', models: ['p1'], run: async () => ({ text: typeof kit.runProcess }) });");
  fs.writeFileSync(path.join(dir, 'noRun.js'), "module.exports = { id: 'norun' };");
  fs.writeFileSync(path.join(dir, 'ignored.txt'), 'x');

  const reg = new Registry({ userDir: dir, templatesDir: path.join(__dirname, '..', 'adapters', 'templates') });
  const byFile = Object.fromEntries(reg.summary().entries.map((e) => [e.file, e]));
  assert.ok(!byFile['good.json'].error);
  assert.ok(/JSON 格式錯誤/.test(byFile['broken.json'].error));
  assert.ok(/type 必須是/.test(byFile['badtype.json'].error));
  assert.ok(/重複/.test(byFile['zdup.json'].error)); // 依檔名排序,先載入的保留
  assert.ok(byFile['codex.json'].overrides);
  assert.strictEqual(reg.get('codex').bin, 'my-codex');
  assert.ok(/run/.test(byFile['noRun.js'].error));
  assert.ok(!('ignored.txt' in byFile));
  assert.strictEqual(reg.get('plug').type, 'js');
  assert.deepStrictEqual(reg.get('plug').listModels().models.map((m) => m.id), ['p1']);

  fs.writeFileSync(path.join(dir, 'plugin.js'), "module.exports = { id: 'plug', label: 'Plug v2', run: async () => ({}) };");
  reg.reload();
  assert.strictEqual(reg.get('plug').label, 'Plug v2');
  fs.rmSync(path.join(dir, 'codex.json'));
  reg.reload();
  assert.strictEqual(reg.get('codex').origin, 'builtin');
});

t('Registry:所有內建範本都能載入', () => {
  const dir = path.join(tmp, 'reg-templates');
  const templatesDir = path.join(__dirname, '..', 'adapters', 'templates');
  const reg = new Registry({ userDir: dir, templatesDir });
  const templates = reg.templates();
  assert.ok(templates.length >= 5);
  for (const tpl of templates) reg.installTemplate(tpl.file);
  const errors = reg.summary().entries.filter((e) => e.error);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(reg.summary().entries.length, templates.length);
});

t('Registry:同一範本裝兩次會換 id、檔案管理擋掉壞檔名與壞 JSON', () => {
  const dir = path.join(tmp, 'reg2');
  const reg = new Registry({ userDir: dir, templatesDir: path.join(__dirname, '..', 'adapters', 'templates') });
  const a = reg.installTemplate('deepseek-api.json');
  const b = reg.installTemplate('deepseek-api.json');
  assert.notStrictEqual(a.file, b.file);
  assert.ok(reg.get('deepseek') && reg.get('deepseek-2'));

  assert.throws(() => reg.readFile('../secret.json'), /檔名/);
  assert.throws(() => reg.writeFile('x.json', '{bad'), /JSON 格式錯誤/);
  const w = reg.writeFile('x.json', JSON.stringify({ id: 'x', type: 'cli' }));
  assert.ok(/bin/.test(w.error));
  const renamed = reg.writeFile('y.json', JSON.stringify({ id: 'y', type: 'cli', bin: 'y' }), { originalFile: 'x.json' });
  assert.strictEqual(renamed.error, null);
  assert.ok(!fs.existsSync(path.join(dir, 'x.json')));
  reg.deleteFile('y.json');
  assert.strictEqual(reg.get('y'), null);
});

t('Registry:載入時把舊版明文 apiKey 移到安全儲存，失敗時保留原檔', () => {
  const dir = path.join(tmp, 'reg-legacy-key');
  fs.mkdirSync(dir);
  const legacy = { id: 'legacy', type: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-legacy', models: ['m'] };
  const blank = { id: 'blank', type: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: '', models: ['m'] };
  fs.writeFileSync(path.join(dir, 'legacy.json'), JSON.stringify(legacy));
  fs.writeFileSync(path.join(dir, 'blank.json'), JSON.stringify(blank));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{bad');

  // 安全儲存不可用:檔案原封不動，key 不能不見
  const failing = new Registry({ userDir: dir, setSecret: () => { throw new Error('系統安全儲存目前不可用'); } });
  const failedEntry = failing.entries.find((e) => e.file === 'legacy.json');
  assert.ok(/舊版明文 API key/.test(failedEntry.error));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'legacy.json'), 'utf8')).apiKey, 'sk-legacy');
  assert.deepStrictEqual(failing.migrateLegacyApiKey('broken.json'), { migrated: false });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'broken.json'), 'utf8'), '{bad');
  // 空白 apiKey 不需要安全儲存，直接移除即可載入
  assert.ok(failing.get('blank'));

  const stored = {};
  const reg = new Registry({ userDir: dir, setSecret: (ref, value) => { stored[ref] = value; }, getSecret: (ref) => stored[ref] });
  assert.strictEqual(stored['adapter:legacy'], 'sk-legacy');
  const migrated = JSON.parse(fs.readFileSync(path.join(dir, 'legacy.json'), 'utf8'));
  assert.strictEqual(migrated.apiKey, undefined);
  assert.strictEqual(migrated.secretRef, 'adapter:legacy');
  assert.ok(reg.get('legacy'));
  assert.ok(/JSON 格式錯誤/.test(reg.entries.find((e) => e.file === 'broken.json').error));
  assert.strictEqual(reg.readFile('broken.json'), '{bad');
});

t('runTurn:找不到 CLI、外掛丟例外、API 成員不能改檔案', async () => {
  const dir = path.join(tmp, 'reg3');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'throws.js'), "module.exports = { id: 'throws', run: async () => { throw new Error('kaboom'); } };");
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({ id: 'api', type: 'openai', baseUrl: 'https://example.com', models: ['m'] }));
  fs.writeFileSync(path.join(dir, 'seen.js'), "module.exports = { id: 'seen', run: async (agent) => ({ text: String(agent.canEdit) }) };");
  const previous = adapters.getRegistry();
  adapters.setRegistry(new Registry({ userDir: dir }));
  try {
    assert.ok(/找不到 CLI/.test((await adapters.runTurn({ cli: 'ghost' }, {})).error));
    assert.ok(/kaboom/.test((await adapters.runTurn({ cli: 'throws' }, {})).error));
    assert.strictEqual(adapters.effectiveCanEdit({ cli: 'api', canEdit: true }), false);
    assert.strictEqual(adapters.effectiveCanEdit({ cli: 'claude', canEdit: true }), true);
    assert.strictEqual((await adapters.runTurn({ cli: 'seen', canEdit: true }, {})).text, 'true');
    const catalog = await adapters.getRegistry().catalog();
    assert.strictEqual(catalog.api.supportsEdit, false);
    assert.strictEqual(catalog.claude.origin, 'builtin');
  } finally {
    adapters.setRegistry(previous);
  }
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log('ok -', name);
    } catch (e) {
      console.log('FAIL -', name);
      console.log(e);
      process.exitCode = 1;
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed}/${tests.length} tests passed`);
})();
