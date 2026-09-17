'use strict';
// 擴充規格的共用檢查與正規化。

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// 模型清單可寫成字串陣列或物件陣列,統一成 model-rules 使用的格式。
function normalizeModels(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((m) => (typeof m === 'string' ? { id: m } : m))
    .filter((m) => m && typeof m.id === 'string' && m.id.trim())
    .map((m) => {
      const efforts = [...new Set((m.efforts || []).map((e) => String(e).toLowerCase()).filter(Boolean))];
      return {
        id: m.id.trim(),
        label: m.label || m.id.trim(),
        description: m.description || '',
        efforts,
        defaultEffort: efforts.includes(m.defaultEffort) ? m.defaultEffort : '',
        aliases: [...new Set((m.aliases || []).map((a) => String(a).toLowerCase()).filter(Boolean))],
        // 沒寫 efforts 的模型不限制強度(交給 CLI / API 自己判斷)
        ...(Array.isArray(m.efforts) ? {} : { efforts: [], unrestrictedEffort: true }),
      };
    });
}

function validateCommon(spec, errors) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { errors.push('內容必須是物件'); return; }
  if (typeof spec.id !== 'string' || !ID_PATTERN.test(spec.id)) errors.push('id 必須是 1–64 個英數字,可含 . _ -,且以英數字開頭');
  if (spec.label != null && typeof spec.label !== 'string') errors.push('label 必須是字串');
  if (spec.models != null && spec.models !== 'auto' && !Array.isArray(spec.models)) errors.push('models 必須是陣列或 "auto"');
  if (spec.efforts != null && !Array.isArray(spec.efforts)) errors.push('efforts 必須是陣列');
  if (spec.timeoutMs != null && !(Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0)) errors.push('timeoutMs 必須是正數');
}

module.exports = { ID_PATTERN, normalizeModels, validateCommon };
