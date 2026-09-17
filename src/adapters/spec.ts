// 擴充規格的共用檢查與正規化。

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
import { SHAPES as USAGE_SHAPES } from '../usage';
const ATTACHMENT_CAPABILITIES = ['filePath', 'imageInline', 'textInline'];

import type { Model } from '../model-rules';
import type { AdapterCapabilities } from './types';

// 模型清單可寫成字串陣列或物件陣列,統一成 model-rules 使用的格式。
function normalizeModels(list: unknown): Model[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((m: any) => (typeof m === 'string' ? { id: m } : m))
    .filter((m: any) => m && typeof m.id === 'string' && m.id.trim())
    .map((m: any) => {
      const efforts = [...new Set<string>((m.efforts || []).map((e: any) => String(e).toLowerCase()).filter(Boolean))];
      return {
        id: m.id.trim(),
        label: m.label || m.id.trim(),
        description: m.description || '',
        efforts,
        defaultEffort: efforts.includes(m.defaultEffort) ? m.defaultEffort : '',
        aliases: [...new Set<string>((m.aliases || []).map((a: any) => String(a).toLowerCase()).filter(Boolean))],
        // 沒寫 efforts 的模型不限制強度(交給 CLI / API 自己判斷)
        ...(Array.isArray(m.efforts) ? {} : { efforts: [], unrestrictedEffort: true }),
      };
    });
}

function validateCommon(spec: any, errors: any) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { errors.push('內容必須是物件'); return; }
  if (typeof spec.id !== 'string' || !ID_PATTERN.test(spec.id)) errors.push('id 必須是 1–64 個英數字,可含 . _ -,且以英數字開頭');
  if (spec.label != null && typeof spec.label !== 'string') errors.push('label 必須是字串');
  if (spec.models != null && spec.models !== 'auto' && !Array.isArray(spec.models)) errors.push('models 必須是陣列或 "auto"');
  if (spec.efforts != null && !Array.isArray(spec.efforts)) errors.push('efforts 必須是陣列');
  if (spec.timeoutMs != null && !(Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0)) errors.push('timeoutMs 必須是正數');
  if (spec.usageShape != null && !USAGE_SHAPES.includes(spec.usageShape)) errors.push(`usageShape 必須是 ${USAGE_SHAPES.join('、')};不填則依欄位特徵自動判斷`);
  if (spec.capabilities != null) {
    const caps = spec.capabilities;
    if (!caps || typeof caps !== 'object' || Array.isArray(caps)) errors.push('capabilities 必須是物件');
    else {
      if (!Array.isArray(caps.attachments)) errors.push('capabilities.attachments 必須是陣列');
      else {
        const invalid = caps.attachments.filter((value: any) => !ATTACHMENT_CAPABILITIES.includes(value));
        if (invalid.length) errors.push(`capabilities.attachments 只接受 ${ATTACHMENT_CAPABILITIES.join('、')}`);
        if (new Set(caps.attachments).size !== caps.attachments.length) errors.push('capabilities.attachments 不可重複');
      }
      if (caps.attachmentsNeedCwd != null && typeof caps.attachmentsNeedCwd !== 'boolean') errors.push('capabilities.attachmentsNeedCwd 必須是布林值');
    }
  }
}

function normalizeCapabilities(capabilities: any, fallback: string[] = []): AdapterCapabilities {
  const caps = capabilities && typeof capabilities === 'object' ? capabilities : {};
  return {
    attachments: Array.isArray(caps.attachments) ? [...new Set<string>(caps.attachments)] : [...fallback],
    attachmentsNeedCwd: !!caps.attachmentsNeedCwd,
  };
}

export { ID_PATTERN, ATTACHMENT_CAPABILITIES, normalizeModels, normalizeCapabilities, validateCommon };
