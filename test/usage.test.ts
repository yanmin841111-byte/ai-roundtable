'use strict';
const assert = require('assert');
const { normalizeUsage, detectShape, SHAPES } = require('../src/usage');

let n = 0; const t = (name: any, fn: any) => { fn(); n++; console.log('ok -', name); };

// 兩組真實樣本,取自 claude -p --output-format stream-json 的 result 事件
// (第二組是同一個 session 用 --resume 接上的第二回合)
const REAL_1 = { input_tokens: 2, cache_read_input_tokens: 28097, cache_creation_input_tokens: 9959, output_tokens: 4, total_cost_usd: 0.113749 };
const REAL_2 = { input_tokens: 2, cache_read_input_tokens: 38056, cache_creation_input_tokens: 126, output_tokens: 4, total_cost_usd: 0.020398 };

// ---------- 三種內建 shape 的換算 ----------

t('anthropic:三個欄位互斥,相加才是完整輸入', () => {
  const u = normalizeUsage({ input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 200, output_tokens: 50, total_cost_usd: 0.01 }, 'anthropic');
  assert.strictEqual(u.inputTokens, 1100);
  assert.strictEqual(u.cachedInputTokens, 800);
  assert.strictEqual(u.cacheWriteTokens, 200);
  assert.strictEqual(u.outputTokens, 50);
  assert.strictEqual(u.costUsd, 0.01);
  assert.strictEqual(u.shape, 'anthropic');
});

t('codex:input_tokens 本來就含快取,不再加一次', () => {
  const u = normalizeUsage({ input_tokens: 9000, cached_input_tokens: 8000, output_tokens: 50 }, 'codex');
  assert.strictEqual(u.inputTokens, 9000, '不可以變成 17000');
  assert.strictEqual(u.cachedInputTokens, 8000);
  assert.strictEqual(u.cacheWriteTokens, null);
  assert.strictEqual(u.costUsd, null);
});

t('openai:讀 prompt_tokens / completion_tokens 與巢狀 cached_tokens', () => {
  const u = normalizeUsage({ prompt_tokens: 900, completion_tokens: 12, total_tokens: 912, prompt_tokens_details: { cached_tokens: 800 } }, 'openai');
  assert.strictEqual(u.inputTokens, 900);
  assert.strictEqual(u.outputTokens, 12);
  assert.strictEqual(u.cachedInputTokens, 800);
  assert.strictEqual(u.cacheWriteTokens, null);
});

// ---------- 真實樣本 ----------

t('真實樣本一:總輸入 38058,成本保留單次值', () => {
  const u = normalizeUsage(REAL_1, 'anthropic');
  assert.strictEqual(u.inputTokens, 38058);
  assert.strictEqual(u.cachedInputTokens, 28097);
  assert.strictEqual(u.cacheWriteTokens, 9959);
  assert.strictEqual(u.outputTokens, 4);
  assert.strictEqual(u.costUsd, 0.113749);
});

t('真實樣本二(resume 後):總輸入 38184', () => {
  const u = normalizeUsage(REAL_2, 'anthropic');
  assert.strictEqual(u.inputTokens, 38184);
  assert.strictEqual(u.cacheWriteTokens, 126);
  assert.strictEqual(u.costUsd, 0.020398);
});

t('漏算 cache_creation 會少報:舊算法只有 28099', () => {
  // 這個案例存在的理由:排除 cache write 會在真實資料上少報 26%
  const old = REAL_1.input_tokens + REAL_1.cache_read_input_tokens;
  assert.strictEqual(old, 28099);
  assert.strictEqual(normalizeUsage(REAL_1, 'anthropic').inputTokens - old, 9959);
});

// ---------- shape 決定順序 ----------

t('明確宣告的 shape 優先於特徵辨識', () => {
  // 物件長得像 anthropic,但宣告 codex 就照 codex 解讀(input 已含快取,不再相加)
  const u = normalizeUsage({ input_tokens: 9000, cache_read_input_tokens: 8000, cached_input_tokens: 8000, output_tokens: 5 }, 'codex');
  assert.strictEqual(u.shape, 'codex');
  assert.strictEqual(u.inputTokens, 9000);
  assert.strictEqual(u.cacheWriteTokens, null);
});

t('宣告無效的 shape 時退回特徵辨識,不當成 unknown', () => {
  assert.strictEqual(normalizeUsage(REAL_1, 'nonsense').shape, 'anthropic');
  assert.strictEqual(normalizeUsage(REAL_1, '').shape, 'anthropic');
});

t('特徵辨識:cache_read / cache_creation → anthropic', () => {
  assert.strictEqual(detectShape({ cache_read_input_tokens: 1 }), 'anthropic');
  assert.strictEqual(detectShape({ cache_creation_input_tokens: 1 }), 'anthropic');
});

t('特徵辨識:prompt_tokens / completion_tokens → openai', () => {
  assert.strictEqual(detectShape({ prompt_tokens: 1 }), 'openai');
  assert.strictEqual(detectShape({ completion_tokens: 1 }), 'openai');
});

t('特徵辨識:cached_input_tokens → codex', () => {
  assert.strictEqual(detectShape({ cached_input_tokens: 1 }), 'codex');
});

t('特徵辨識:只有 input/output 且無任何快取欄位 → codex(兩種解讀收斂)', () => {
  const raw = { input_tokens: 500, output_tokens: 20 };
  assert.strictEqual(detectShape(raw), 'codex');
  // 快取為零時,「含快取」與「不含快取」的解讀結果相同,所以這不是猜測
  assert.strictEqual(normalizeUsage(raw).inputTokens, 500);
});

// ---------- unknown ----------

t('認不得的欄位判為 unknown,raw 原樣保留', () => {
  const raw = { tokens_used: 123, weird: { a: 1 } };
  const u = normalizeUsage(raw);
  assert.strictEqual(u.shape, 'unknown');
  assert.strictEqual(u.raw, raw, 'raw 必須是原物件,不可重建');
  for (const k of ['inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens', 'costUsd']) {
    assert.strictEqual(u[k], null, `${k} 應為 null`);
  }
});

t('不合法輸入一律回 unknown 且不拋出', () => {
  for (const bad of [null, undefined, {}, [], 'abc', 5, true, NaN]) {
    const u = normalizeUsage(bad);
    assert.strictEqual(u.shape, 'unknown', `${String(bad)} 應為 unknown`);
    assert.strictEqual(u.inputTokens, null);
  }
  assert.strictEqual(normalizeUsage(undefined).raw, null);
  assert.strictEqual(normalizeUsage([]).shape, 'unknown', '陣列不可被當成物件解讀');
});

// ---------- 缺欄位與髒資料 ----------

t('缺 cache 欄位時 inputTokens 仍正確,缺的欄位是 null 不是 0', () => {
  const u = normalizeUsage({ input_tokens: 300, output_tokens: 10 }, 'anthropic');
  assert.strictEqual(u.inputTokens, 300);
  assert.strictEqual(u.cachedInputTokens, null, '沒回報就是 null,不是 0');
  assert.strictEqual(u.cacheWriteTokens, null);
});

t('缺 output 時 outputTokens 是 null', () => {
  assert.strictEqual(normalizeUsage({ input_tokens: 1, cached_input_tokens: 0 }, 'codex').outputTokens, null);
});

t('字串數字會被接受,非數字字串與 NaN 一律 null,絕不產生 NaN', () => {
  const u = normalizeUsage({ input_tokens: '100', cache_read_input_tokens: '50', output_tokens: 'abc', total_cost_usd: NaN }, 'anthropic');
  assert.strictEqual(u.inputTokens, 150);
  assert.strictEqual(u.outputTokens, null);
  assert.strictEqual(u.costUsd, null);
  for (const v of Object.values(u)) assert.ok(!Number.isNaN(v), '不可出現 NaN');
});

t('全部欄位都讀不到數字時 inputTokens 是 null 而不是 0', () => {
  const u = normalizeUsage({ input_tokens: 'x', cache_read_input_tokens: null }, 'anthropic');
  assert.strictEqual(u.inputTokens, null);
});

t('codex 與 openai 的 cacheWriteTokens 必須是 null,不是 0', () => {
  assert.strictEqual(normalizeUsage({ input_tokens: 1, cached_input_tokens: 1, output_tokens: 1 }, 'codex').cacheWriteTokens, null);
  assert.strictEqual(normalizeUsage({ prompt_tokens: 1, completion_tokens: 1 }, 'openai').cacheWriteTokens, null);
});

t('cached 為 0 時保留 0,與「沒回報」的 null 可區分', () => {
  assert.strictEqual(normalizeUsage({ input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 }, 'codex').cachedInputTokens, 0);
  assert.strictEqual(normalizeUsage({ input_tokens: 5, output_tokens: 1 }, 'codex').cachedInputTokens, null);
});

// ---------- 混合來源加總(消費端的合約) ----------

t('混合來源:null 不被當成 0,unknown 不計入', () => {
  const rows = [
    normalizeUsage(REAL_1, 'anthropic'),
    normalizeUsage({ input_tokens: 9000, cached_input_tokens: 8000, output_tokens: 50 }, 'codex'),
    normalizeUsage({ tokens_used: 999 }),
  ];
  const known = rows.filter((u: any) => u.shape !== 'unknown');
  const sum = (key: any) => {
    const vals = known.map((u: any) => u[key]).filter((v: any) => v != null);
    return { total: vals.reduce((a: any, b: any) => a + b, 0), reported: vals.length };
  };

  assert.strictEqual(known.length, 2, 'unknown 不能進入總計');
  assert.deepStrictEqual(sum('inputTokens'), { total: 47058, reported: 2 });
  assert.deepStrictEqual(sum('outputTokens'), { total: 54, reported: 2 });
  // 只有 Claude 回報 cacheWrite:總和是 9959,涵蓋 1/2,不是「兩者相加 = 9959」的巧合
  assert.deepStrictEqual(sum('cacheWriteTokens'), { total: 9959, reported: 1 });
  assert.deepStrictEqual(sum('costUsd'), { total: 0.113749, reported: 1 });
});

// 真實樣本,取自 cursor-agent -p --output-format stream-json 的 result 事件(續接回合)
t('cursor:inputTokens 不含快取,三項相加才是完整輸入', () => {
  const raw = { inputTokens: 166, outputTokens: 193, cacheReadTokens: 15584, cacheWriteTokens: 0 };
  assert.strictEqual(detectShape(raw), 'cursor');
  const u = normalizeUsage(raw);
  assert.strictEqual(u.inputTokens, 15750);
  assert.strictEqual(u.cachedInputTokens, 15584);
  assert.strictEqual(u.cacheWriteTokens, 0, '有回報的 0 要保留為 0');
  assert.strictEqual(u.outputTokens, 193);
  assert.strictEqual(u.costUsd, null);
  assert.strictEqual(u.shape, 'cursor');
});

t('SHAPES 只包含內建慣例,unknown 不在其中', () => {
  assert.deepStrictEqual(SHAPES, ['anthropic', 'codex', 'openai', 'cursor']);
  assert.ok(!SHAPES.includes('unknown'), 'unknown 是判讀失敗的結果,不是可宣告的值');
});

console.log(`\n${n} 項測試全部通過`);
