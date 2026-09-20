// 擴充規格的共用檢查與正規化。

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
import { SHAPES as USAGE_SHAPES } from '../usage';
const ATTACHMENT_CAPABILITIES = ['filePath', 'imageInline', 'textInline'];

import type { Model } from '../model-rules';
import type { AdapterCapabilities } from './types';
import { tx, type TextLocale } from '../text';

// 「a、b、c 或 d」/「a, b, c or d」。or=false 時只是並列(「只接受 a、b、c」)。
function listOf(values: readonly string[], locale: TextLocale, or = true): string {
  const sep = tx(locale, 'spec.listSep');
  if (!or || values.length < 2) return values.join(sep);
  return values.slice(0, -1).join(sep) + tx(locale, 'spec.or') + values[values.length - 1];
}

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

function validateCommon(spec: any, errors: any, locale: TextLocale = 'zh-Hant') {
  const e = (key: string, params: Record<string, string> = {}) => errors.push(tx(locale, key, params));
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { e('spec.contentObject'); return; }
  if (typeof spec.id !== 'string' || !ID_PATTERN.test(spec.id)) e('spec.badId');
  if (spec.label != null && typeof spec.label !== 'string') e('spec.mustBeString', { field: 'label' });
  // 安裝/設定說明頁。這個 CLI 或服務不在時,介面把它當成可照做的下一步(「打開安裝說明」)
  if (spec.docsUrl != null && typeof spec.docsUrl !== 'string') e('spec.mustBeString', { field: 'docsUrl' });
  if (spec.models != null && spec.models !== 'auto' && !Array.isArray(spec.models)) e('spec.modelsShape');
  if (spec.efforts != null && !Array.isArray(spec.efforts)) e('spec.mustBeArray', { field: 'efforts' });
  if (spec.timeoutMs != null && !(Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0)) e('spec.mustBePositive', { field: 'timeoutMs' });
  if (spec.usageShape != null && !USAGE_SHAPES.includes(spec.usageShape)) e('spec.usageShape', { list: listOf(USAGE_SHAPES, locale) });
  if (spec.capabilities != null) {
    const caps = spec.capabilities;
    if (!caps || typeof caps !== 'object' || Array.isArray(caps)) e('spec.mustBeObject', { field: 'capabilities' });
    else {
      if (!Array.isArray(caps.attachments)) e('spec.mustBeArray', { field: 'capabilities.attachments' });
      else {
        const invalid = caps.attachments.filter((value: any) => !ATTACHMENT_CAPABILITIES.includes(value));
        if (invalid.length) e('spec.onlyAccepts', { field: 'capabilities.attachments', list: listOf(ATTACHMENT_CAPABILITIES, locale, false) });
        if (new Set(caps.attachments).size !== caps.attachments.length) e('spec.noDuplicates', { field: 'capabilities.attachments' });
      }
      if (caps.attachmentsNeedCwd != null && typeof caps.attachmentsNeedCwd !== 'boolean') e('spec.mustBeBoolean', { field: 'capabilities.attachmentsNeedCwd' });
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

export { ID_PATTERN, ATTACHMENT_CAPABILITIES, normalizeModels, normalizeCapabilities, validateCommon, listOf };
