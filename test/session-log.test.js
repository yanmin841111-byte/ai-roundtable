'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeSession, messagesToMarkdown, usageMarkdown } = require('../src/session-log');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-roundtable-sessions-'));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('原子寫入成功後 JSON 內容正確且沒有暫存檔', () => {
  const messages = [{ id: '1', kind: 'user', ts: 1, text: '測試任務' }];
  const result = writeSession(base, messages, { now: new Date('2026-01-02T03:04:05.000Z') });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(result.file, 'utf8')), messages);
  assert.strictEqual(fs.readdirSync(path.dirname(result.file)).some((name) => name.endsWith('.tmp')), false);
});

t('寫入失敗時回傳錯誤且不拋出', () => {
  const blocked = path.join(base, 'not-a-directory');
  fs.writeFileSync(blocked, 'file');
  const errors = [];
  const result = writeSession(blocked, [{ text: 'x' }], { logger: { error: (message) => errors.push(message) } });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error);
  assert.strictEqual(errors.length, 1);
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

fs.rmSync(base, { recursive: true, force: true });
console.log(`\n${n} tests passed`);
