'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeSession, listSessions, readSession, deleteSession, messagesToMarkdown, usageMarkdown, resolveSessionPath } = require('../src/session-log');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-roundtable-sessions-'));
let n = 0;
const t = (name: any, fn: any) => { fn(); n++; console.log('ok -', name); };

t('原子寫入產生 envelope 且沒有留下暫存檔', () => {
  const messages = [{ id: '1', kind: 'user', ts: 1, text: '測試任務' }];
  const result = writeSession(base, messages, { now: new Date('2026-01-02T03:04:05.000Z') });
  assert.strictEqual(result.ok, true);
  const saved = JSON.parse(fs.readFileSync(result.file, 'utf8'));
  assert.strictEqual(saved.version, 1);
  assert.strictEqual(saved.title, '測試任務');
  assert.deepStrictEqual(saved.messages, messages);
  assert.ok(saved.createdAt, 'createdAt 必填');
  assert.strictEqual(fs.readdirSync(path.dirname(result.file)).some((name: any) => name.endsWith('.tmp')), false);
});

t('envelope 的 title / agents / createdAt 從訊息推導', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-env-'));
  const long = '任'.repeat(200);
  const r = writeSession(dir, [
    { kind: 'user', ts: Date.UTC(2026, 0, 2, 3, 4, 5), text: long },
    { kind: 'agent', agentName: 'Claude', text: 'a' },
    { kind: 'agent', agentName: 'Codex', text: 'b' },
    { kind: 'agent', agentName: 'Claude', text: 'c' },
    { kind: 'system', text: '略' },
  ]);
  const e = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.strictEqual(e.title.length, 81, '80 字加上省略號');
  assert.ok(e.title.endsWith('…'));
  assert.deepStrictEqual(e.agents, ['Claude', 'Codex'], '去重且保留出現順序,不含系統訊息');
  assert.strictEqual(e.createdAt, new Date(Date.UTC(2026, 0, 2, 3, 4, 5)).toISOString());
  fs.rmSync(dir, { recursive: true, force: true });
});

t('空訊息也能寫入,標題降級為「(無標題)」', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-empty-'));
  const r = writeSession(dir, []);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')).title, '(無標題)');
  fs.rmSync(dir, { recursive: true, force: true });
});

t('寫入失敗時回傳錯誤且不拋出', () => {
  const blocked = path.join(base, 'not-a-directory');
  fs.writeFileSync(blocked, 'file');
  const errors: any[] = [];
  const result = writeSession(blocked, [{ text: 'x' }], { logger: { error: (message: any) => errors.push(message) } });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error);
  assert.strictEqual(errors.length, 1);
});

t('壞掉的 now 或 userDataDir 只回傳錯誤,絕不拋出', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-bad-'));
  // now 壞掉不該影響寫入:退回目前時間照樣寫成功
  assert.strictEqual(writeSession(dir, [], { now: null }).ok, true);
  assert.strictEqual(writeSession(dir, [], { now: new Date('x') }).ok, true);
  assert.strictEqual(writeSession(dir, [], { now: 'nonsense' }).ok, true);
  // userDataDir 壞掉就寫不了,但只能回傳錯誤
  for (const bad of [undefined, null, 42, {}]) {
    const r = writeSession(bad, [], { logger: { error() {} } });
    assert.strictEqual(r.ok, false, `userDataDir=${String(bad)}`);
    assert.ok(r.error);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

t('createdAt 只看 messages[0].ts,不會挑後面訊息的時間', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-ts-'));
  const sdir = path.join(dir, 'sessions');
  fs.mkdirSync(sdir, { recursive: true });
  const full = path.join(sdir, 'noTs.json');
  // 第一則沒有 ts、第二則是 2020、檔案 mtime 是 2025 → 必須用 mtime,不能用 2020
  fs.writeFileSync(full, JSON.stringify([
    { kind: 'user', text: '沒有時間戳' },
    { kind: 'agent', agentName: 'X', ts: Date.UTC(2020, 0, 1), text: 'x' },
  ]));
  const mtime = new Date(Date.UTC(2025, 0, 1));
  fs.utimesSync(full, mtime, mtime);
  assert.strictEqual(readSession(dir, 'noTs.json').session.createdAt, mtime.toISOString());
  assert.strictEqual(listSessions(dir).sessions[0].createdAt, mtime.toISOString());
  fs.rmSync(dir, { recursive: true, force: true });
});

t('可解析但不是對話紀錄的 JSON 要降級,不可列為空對話', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-notsession-'));
  const sdir = path.join(dir, 'sessions');
  fs.mkdirSync(sdir, { recursive: true });
  const bad = [
    ['object.json', { foo: 'bar' }],
    ['noMessages.json', { version: 1, title: '看起來像但沒有 messages' }],
    ['wrongType.json', { version: 1, messages: '不是陣列' }],
    ['nullMessages.json', { version: 1, messages: null }],
    ['scalar.json', 42],
    ['str.json', '"字串"'],
    ['nul.json', null],
  ];
  for (const [name, content] of bad) {
    fs.writeFileSync(path.join(sdir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  const { sessions } = listSessions(dir);
  assert.strictEqual(sessions.length, bad.length);
  for (const s of sessions) {
    assert.strictEqual(s.title, '(無法讀取)', `${s.id} 應降級`);
    assert.ok(s.error, `${s.id} 應帶錯誤訊息`);
    assert.strictEqual(readSession(dir, s.id).ok, false, `${s.id} readSession 應失敗`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

t('合法的空對話仍然可讀,不會被當成損壞', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-emptyok-'));
  const r = writeSession(dir, []);
  const s = readSession(dir, path.basename(r.file));
  assert.strictEqual(s.ok, true, 'messages 是空陣列是合法的,不同於缺少 messages');
  assert.deepStrictEqual(s.session.messages, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

t('Markdown 保留一般、系統與錯誤訊息的名稱、階段、時間及內容', () => {
  const markdown = messagesToMarkdown([
    { kind: 'agent', agentName: 'Codex', phase: '執行', model: 'gpt-test', ts: '2026-01-02T03:04:05Z', text: '完成檔案。', usage: { shape: 'codex', inputTokens: 12, cachedInputTokens: 4, cacheWriteTokens: null, outputTokens: 3, costUsd: null, raw: {} } },
    { kind: 'system', level: 'warn', ts: '2026-01-02T03:05:00Z', text: '需要確認。' },
    { kind: 'system', level: 'error', ts: '2026-01-02T03:06:00Z', text: '執行失敗。', error: '第一行\n第二行' },
  ]);
  assert.match(markdown, /## Codex · 執行 · gpt-test · /);
  assert.match(markdown, /2026/);
  assert.match(markdown, /GMT|UTC|台北標準時間/);
  assert.match(markdown, /> 用量：輸入: 12（其中快取 4） · 輸出: 3/);
  assert.match(markdown, /完成檔案。/);
  assert.match(markdown, /## 系統警告/);
  assert.match(markdown, /需要確認。/);
  assert.match(markdown, /## 系統錯誤/);
  assert.match(markdown, /> 錯誤：第一行\n> 第二行/);
});

t('Markdown 將正規化 usage 的快取寫入與成本清楚列出', () => {
  const out = usageMarkdown({ shape: 'anthropic', inputTokens: 100, cachedInputTokens: 40, cacheWriteTokens: 20, outputTokens: 5, costUsd: 0.0123, raw: {} });
  assert.match(out, /輸入: 100（其中快取 40、寫入快取 20）/);
  assert.match(out, /輸出: 5/);
  assert.match(out, /成本: \$0\.012/);
});

t('unknown usage 會展開 raw,包含巢狀欄位', () => {
  const out = usageMarkdown({ shape: 'unknown', inputTokens: null, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: null, costUsd: null, raw: { tokens: 9, detail: { cached: 2 } } });
  assert.match(out, /原始用量：tokens: 9/);
  assert.match(out, /detail: \{"cached":2\}/);
});

t('null 欄位不會在 Markdown 中顯示成 0', () => {
  const out = usageMarkdown({ shape: 'openai', inputTokens: 10, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: null, costUsd: null, raw: {} });
  assert.strictEqual(out, '> 用量：輸入: 10');
});


// ---------- listSessions / readSession / deleteSession ----------

// 建一個獨立的 userData,裡面塞新舊兩種格式與一個壞檔
function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-list-'));
  const sdir = path.join(dir, 'sessions');
  fs.mkdirSync(sdir, { recursive: true });
  const write = (name: any, content: any, mtime: any) => {
    const full = path.join(sdir, name);
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content));
    fs.utimesSync(full, mtime, mtime);
    return name;
  };
  // 舊格式:純陣列,沒有 envelope 欄位
  write('old.json', [
    { kind: 'user', ts: Date.UTC(2026, 0, 1), text: '舊格式任務' },
    { kind: 'agent', agentName: 'Codex', text: 'x' },
  ], new Date(2026, 0, 1));
  write('new.json', {
    version: 1, createdAt: '2026-03-03T00:00:00.000Z', title: '新格式任務',
    agents: ['Claude'], messages: [{ kind: 'user', ts: 1, text: '新格式任務' }],
  }, new Date(2026, 2, 3));
  write('broken.json', '{ 這不是 JSON', new Date(2026, 1, 2));
  write('ignored.txt', 'x', new Date(2026, 5, 1)); // 非 .json,不該出現在清單
  return dir;
}

t('listSessions 依時間倒序,只收 .json', () => {
  const dir = makeStore();
  const { sessions, error } = listSessions(dir);
  assert.strictEqual(error, undefined);
  assert.deepStrictEqual(sessions.map((s: any) => s.id), ['new.json', 'broken.json', 'old.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

t('listSessions 對舊的純陣列格式動態推導 title / createdAt / agents', () => {
  const dir = makeStore();
  const old = listSessions(dir).sessions.find((s: any) => s.id === 'old.json');
  assert.strictEqual(old.title, '舊格式任務');
  assert.deepStrictEqual(old.agents, ['Codex']);
  assert.strictEqual(old.createdAt, new Date(Date.UTC(2026, 0, 1)).toISOString());
  assert.strictEqual(old.messageCount, 2);
  assert.ok(old.size > 0);
  // 不可批次改寫舊檔:原檔仍然是陣列
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'old.json'), 'utf8'))));
  fs.rmSync(dir, { recursive: true, force: true });
});

t('壞掉的檔案只讓該筆降級,不讓整份清單失效', () => {
  const dir = makeStore();
  const { sessions } = listSessions(dir);
  const bad = sessions.find((s: any) => s.id === 'broken.json');
  assert.strictEqual(bad.title, '(無法讀取)');
  assert.ok(bad.error, '該筆要帶錯誤訊息');
  assert.strictEqual(sessions.length, 3, '其餘紀錄仍然列得出來');
  fs.rmSync(dir, { recursive: true, force: true });
});

t('listSessions 套用 limit,且 sessions 目錄不存在時回空陣列不報錯', () => {
  const dir = makeStore();
  assert.strictEqual(listSessions(dir, { limit: 1 }).sessions.length, 1);
  assert.strictEqual(listSessions(dir, { limit: 0 }).sessions.length, 0);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-none-'));
  assert.deepStrictEqual(listSessions(empty), { sessions: [] });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});

t('readSession 對新舊格式都回傳同一種形狀', () => {
  const dir = makeStore();
  for (const id of ['old.json', 'new.json']) {
    const r = readSession(dir, id);
    assert.strictEqual(r.ok, true, id);
    assert.deepStrictEqual(Object.keys(r.session).sort(), ['agents', 'conversationId', 'createdAt', 'messages', 'title', 'version']);
    assert.strictEqual(r.session.version, 1);
    assert.ok(Array.isArray(r.session.messages));
  }
  assert.strictEqual(readSession(dir, 'broken.json').ok, false);
  assert.strictEqual(readSession(dir, 'nope.json').ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

t('deleteSession 成功後檔案確實消失', () => {
  const dir = makeStore();
  assert.deepStrictEqual(deleteSession(dir, 'old.json'), { ok: true });
  assert.strictEqual(fs.existsSync(path.join(dir, 'sessions', 'old.json')), false);
  assert.strictEqual(deleteSession(dir, 'old.json').ok, false, '刪第二次要回錯誤');
  fs.rmSync(dir, { recursive: true, force: true });
});

t('mtime 快取:檔案沒變不重讀,變了要重讀', () => {
  const dir = makeStore();
  const full = path.join(dir, 'sessions', 'new.json');
  assert.strictEqual(readSession(dir, 'new.json').session.title, '新格式任務');
  // 直接改內容並推進 mtime,快取必須失效
  fs.writeFileSync(full, JSON.stringify({ version: 1, title: '改過了', messages: [] }));
  fs.utimesSync(full, new Date(2026, 6, 1), new Date(2026, 6, 1));
  assert.strictEqual(readSession(dir, 'new.json').session.title, '改過了');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 路徑防護 ----------

t('惡意 id 一律被拒,且不觸碰 sessions 目錄外的檔案', () => {
  const dir = makeStore();
  const outside = path.join(dir, 'secret.json');              // sessions 的上一層
  fs.writeFileSync(outside, JSON.stringify([{ kind: 'user', text: '機密' }]));
  const evil = [
    '../secret.json', '../../secret.json', 'sub/../../secret.json',
    '..', '.', '', 'evil.txt', 'no-extension',
    '/etc/passwd', './new.json', 'new.json/', null, undefined, 42, {},
  ];
  for (const id of evil) {
    assert.strictEqual(resolveSessionPath(dir, id), null, `resolveSessionPath 應拒絕 ${JSON.stringify(id)}`);
    assert.strictEqual(readSession(dir, id).ok, false, `readSession 應拒絕 ${JSON.stringify(id)}`);
    assert.strictEqual(deleteSession(dir, id).ok, false, `deleteSession 應拒絕 ${JSON.stringify(id)}`);
  }
  // 最關鍵的一條:外部檔案必須毫髮無傷
  assert.strictEqual(fs.existsSync(outside), true, '目錄外的檔案不可以被刪掉');
  assert.strictEqual(JSON.parse(fs.readFileSync(outside, 'utf8'))[0].text, '機密', '內容不可被更動');
  fs.rmSync(dir, { recursive: true, force: true });
});

t('合法 id 才通過,且解析結果就在 sessions 目錄下', () => {
  const dir = makeStore();
  const full = resolveSessionPath(dir, 'new.json');
  assert.strictEqual(path.dirname(full), path.resolve(dir, 'sessions'));
  assert.strictEqual(path.basename(full), 'new.json');
  fs.rmSync(dir, { recursive: true, force: true });
});

t('帶 id 時覆寫同一份紀錄(繼續討論不會拆成多筆),壞 id 不寫任何檔案', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-overwrite-'));
  const first = writeSession(dir, [{ kind: 'user', ts: 1, text: '原始任務' }], { conversationId: 'c1' });
  assert.strictEqual(first.id, path.basename(first.file));
  const again = writeSession(dir, [
    { kind: 'user', ts: 1, text: '原始任務' },
    { kind: 'user', ts: 2, text: '繼續討論' },
  ], { conversationId: 'c1', id: first.id });
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.file, first.file);
  assert.strictEqual(listSessions(dir).sessions.length, 1);
  assert.strictEqual(readSession(dir, first.id).session.messages.length, 2);
  assert.strictEqual(readSession(dir, first.id).session.title, '原始任務');

  const bad = writeSession(dir, [{ kind: 'user', text: 'x' }], { id: '../escape.json', logger: { error() {} } });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(listSessions(dir).sessions.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

fs.rmSync(base, { recursive: true, force: true });
console.log(`\n${n} tests passed`);
