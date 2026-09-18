// 模型能力的快取:API 成員選的模型會不會呼叫工具、能不能看圖。
//
// 範本支援工具,不代表成員選的模型支援:同一個 Ollama 範本可以選到 gemma3 這種不收 tools 的模型。
// 知道了就能事先避開——不支援工具的模型不給改檔權限、審查時直接附上內容——
// 而不是每次送出一個注定被拒絕的請求,再靠重送補救。
//
// 實際測試要花錢(付費 API),所以結果存檔,重開 app 不必再測;
// Ollama 的回報每次開 app 重新查:它免費,而且模型可能被重新下載成另一個版本。

import fs from 'fs';
import path from 'path';
import type { ModelCapability } from './ipc-types';

const SOURCES = new Set(['ollama', 'metadata', 'probe']);

// 同一個 adapter 換了端點(例如改了 baseUrl)就是另一個模型,要重新確認
export function capabilityKey(adapterId: string, endpoint: string | undefined, model: string): string {
  return `${adapterId}\n${endpoint || ''}\n${model}`;
}

// 紀錄檔可能被手動改過:形狀不對就不收
function valid(raw: any): ModelCapability | null {
  if (!raw || typeof raw !== 'object' || typeof raw.model !== 'string' || !SOURCES.has(raw.source)) return null;
  return {
    model: raw.model,
    source: raw.source,
    at: Number.isFinite(raw.at) ? raw.at : 0,
    ...(typeof raw.tools === 'boolean' ? { tools: raw.tools } : {}),
    ...(typeof raw.images === 'boolean' ? { images: raw.images } : {}),
    ...(typeof raw.error === 'string' && raw.error ? { error: raw.error } : {}),
  };
}

export class CapabilityStore {
  private file: string | null;
  private entries = new Map<string, ModelCapability>();

  constructor(file: string | null = null) {
    this.file = file;
    if (!file) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [key, raw] of Object.entries(data && data.entries ? data.entries : {})) {
        const cap = valid(raw);
        if (cap && cap.source !== 'ollama') this.entries.set(key, cap);
      }
    } catch {} // 沒有檔案或壞掉:當成什麼都不知道,不影響開會
  }

  get(key: string): ModelCapability | undefined {
    return this.entries.get(key);
  }

  set(key: string, cap: ModelCapability): void {
    this.entries.set(key, cap);
    if (cap.source !== 'ollama') this.persist();
  }

  private persist(): void {
    if (!this.file) return;
    const entries = Object.fromEntries([...this.entries].filter(([, c]) => c.source !== 'ollama'));
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, entries }, null, 2));
    } catch {} // 存不了只是下次要重測,不能讓開會失敗
  }
}

// 主程序啟動時換成存檔的那一份;測試可以換成自己的
let active = new CapabilityStore();
export function setCapabilityStore(store: CapabilityStore): void { active = store; }
export function capabilityStore(): CapabilityStore { return active; }
