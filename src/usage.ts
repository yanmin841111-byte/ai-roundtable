'use strict';
// 用量正規化:各 CLI / API 回報的 usage 欄位名稱與語意都不一樣,
// 在這裡統一成單一形狀,介面端才能安全地跨成員加總。
//
// 正規化形狀:
//   inputTokens        送進模型的「完整輸入總量」,包含快取命中與快取寫入
//   cachedInputTokens  其中命中快取的部分(inputTokens 的子集)
//   cacheWriteTokens   其中寫入快取的部分(inputTokens 的子集,與 cached 互斥)
//   outputTokens       輸出
//   costUsd            金額,只有部分來源會回報
//   shape              實際採用的慣例;'unknown' 代表無法判讀,呼叫端應排除在總計外
//   raw                原始物件,永遠原樣保留
//
// 最重要的規則:沒有回報的欄位一律是 null,絕不能寫成 0。
// 「這個來源沒給這個數字」和「這個數字確定是零」在加總時意義完全不同。

const SHAPES = ['anthropic', 'codex', 'openai', 'cursor'];

// 只接受有限的數字;字串數字也收(有些 CLI 會輸出字串)
function num(value: any) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 相加時 null 視為「沒有這一項」,但只要有任何一項有值,結果就有值;
// 全部都沒有才回 null。
function addParts(...values: any[]) {
  let total: any = null;
  for (const v of values) {
    const n = num(v);
    if (n == null) continue;
    total = (total == null ? 0 : total) + n;
  }
  return total;
}

const has = (o: any, k: any) => o[k] != null;

// 依欄位特徵判斷慣例。只在簽名沒有歧義時回答,否則回 null 交給 unknown。
function detectShape(raw: any) {
  if (!raw || typeof raw !== 'object') return null;
  if (has(raw, 'cache_read_input_tokens') || has(raw, 'cache_creation_input_tokens')) return 'anthropic';
  if (has(raw, 'prompt_tokens') || has(raw, 'completion_tokens')) return 'openai';
  if (has(raw, 'cached_input_tokens')) return 'codex';
  if (has(raw, 'cacheReadTokens') || has(raw, 'cacheWriteTokens')) return 'cursor';
  // 只有 input/output 而完全沒有任何快取欄位:此時「含快取」與「不含快取」兩種
  // 解讀會收斂到同一個數字(快取為零),所以歸到 codex 慣例是安全的,不是猜測。
  if (has(raw, 'input_tokens') && has(raw, 'output_tokens')) return 'codex';
  return null;
}

const unknown = (raw: any) => ({
  inputTokens: null, cachedInputTokens: null, cacheWriteTokens: null,
  outputTokens: null, costUsd: null, shape: 'unknown', raw: raw ?? null,
});

function normalizeUsage(raw: any, shape: any) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unknown(raw ?? null);
  const kind = SHAPES.includes(shape) ? shape : detectShape(raw);
  if (!kind) return unknown(raw);

  if (kind === 'anthropic') {
    // Anthropic 的三個欄位互斥,相加才是完整的 prompt。
    // 少算 cache_creation 會在寫入快取的那一回合嚴重少報輸入量。
    return {
      inputTokens: addParts(raw.input_tokens, raw.cache_read_input_tokens, raw.cache_creation_input_tokens),
      cachedInputTokens: num(raw.cache_read_input_tokens),
      cacheWriteTokens: num(raw.cache_creation_input_tokens),
      outputTokens: num(raw.output_tokens),
      // total_cost_usd 是「單次 invocation」的成本,不是 session 累計,所以呼叫端逐則相加正確。
      // 實測方式(可複現):在一個乾淨目錄跑兩回合,第二回合用 --resume 接上第一回合的 session_id,
      //   claude -p --output-format stream-json --verbose "..."
      //   claude -p --output-format stream-json --verbose --resume <session_id> "..."
      // 取兩次 result 事件的 total_cost_usd:回合 1 = 0.113749,回合 2 = 0.020398。
      // 第二回合金額比第一回合小;若是 session 累計就不可能遞減,故確認為單次成本。
      costUsd: num(raw.total_cost_usd),
      shape: kind,
      raw,
    };
  }
  if (kind === 'codex') {
    // Codex 的 input_tokens 本來就含快取,cached_input_tokens 是其中的子集。
    return {
      inputTokens: num(raw.input_tokens),
      cachedInputTokens: num(raw.cached_input_tokens),
      cacheWriteTokens: null, // 不回報,不是 0
      outputTokens: num(raw.output_tokens),
      costUsd: null,
      shape: kind,
      raw,
    };
  }
  if (kind === 'cursor') {
    // Cursor CLI 的 inputTokens 不含快取:實測續接回合 inputTokens=166、cacheReadTokens=15584,
    // 若 inputTokens 是總量就不可能小於快取命中量。與 Anthropic 相同,三項相加才是完整輸入。
    return {
      inputTokens: addParts(raw.inputTokens, raw.cacheReadTokens, raw.cacheWriteTokens),
      cachedInputTokens: num(raw.cacheReadTokens),
      cacheWriteTokens: num(raw.cacheWriteTokens),
      outputTokens: num(raw.outputTokens),
      costUsd: null,
      shape: kind,
      raw,
    };
  }
  // openai:prompt_tokens 含快取,cached_tokens 在 prompt_tokens_details 底下
  const details = (raw.prompt_tokens_details && typeof raw.prompt_tokens_details === 'object') ? raw.prompt_tokens_details : {};
  return {
    inputTokens: num(raw.prompt_tokens),
    cachedInputTokens: num(details.cached_tokens),
    cacheWriteTokens: null,
    outputTokens: num(raw.completion_tokens),
    costUsd: null,
    shape: kind,
    raw,
  };
}

module.exports = { normalizeUsage, detectShape, SHAPES };
