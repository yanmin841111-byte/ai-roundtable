// 轉接器登錄中心:內建轉接器 + 使用者擴充資料夾裡的 *.json / *.js。
// 轉接器介面(內建與擴充都一樣)定義在 ./types.ts。

import fs from 'fs';
import path from 'path';
import { builtinAdapters } from './builtin';
import { validateCommon, normalizeModels, normalizeCapabilities } from './spec';
import { createCliAdapter, validateCliSpec } from './cli-adapter';
import { canonicalModelId, createOpenAIAdapter, discoverOllama, validateOpenAISpec } from './openai-adapter';
import { kit } from './kit';
import type { Adapter, ModelList, RegisteredAdapter } from './types';
import type { CliHealth, CliStatus, EnvFix } from '../ipc-types';
import { tx, type TextLocale } from '../text';
import { capabilityKey, capabilityStore } from '../capabilities';
import { hasInstaller } from '../cli-install';
import type { ModelCapability } from '../ipc-types';

const FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(json|js)$/;

// 健康檢查結果 → 「照做就能修好」的下一步。
// 這裡是唯一決定它的地方:設定畫面、成員的模型設定、回合失敗時的錯誤訊息都拿同一份答案,
// 同一個狀態不會在三個地方變成三種說法。轉接器自己給了答案就尊重它,
// 沒給、而且只是沒安裝時,退回官方安裝說明。
export function fixFromStatus(adapter: (Pick<Adapter, 'docsUrl'> & { id?: string; origin?: string }) | undefined, status: CliStatus | null | undefined): EnvFix | undefined {
  if (!status || status.ok) return undefined;
  if (status.fix) return status.fix;
  const state = status.state || 'missing';
  const install = state === 'missing' && adapter?.origin === 'builtin' && adapter.id && hasInstaller(adapter.id) ? { install: adapter.id } : {};
  if (state === 'missing' && adapter && adapter.docsUrl) return { ...install, url: adapter.docsUrl };
  return undefined;
}

class Registry {
  userDir: any;
  templatesDir: any;
  fetchImpl: any;
  getSecret: any;
  setSecret: any;
  getLocale: () => TextLocale;
  adapters: Map<string, RegisteredAdapter>;
  entries: any[];

  constructor({ userDir, templatesDir, fetchImpl, getSecret, setSecret, getLocale }: any = {}) {
    this.userDir = userDir;
    this.templatesDir = templatesDir;
    this.fetchImpl = fetchImpl;
    this.getSecret = getSecret;
    this.setSecret = setSecret;
    this.getLocale = getLocale || (() => 'zh-Hant');
    this.adapters = new Map();
    this.entries = []; // 使用者擴充的載入結果(含錯誤)
    this.reload();
  }

  // ---------- 載入 ----------
  reload() {
    this.adapters = new Map(builtinAdapters.map((a): [string, RegisteredAdapter] => [a.id, { ...a, origin: 'builtin' }]));
    this.entries = [];
    if (!this.userDir) return this.summary();
    try { fs.mkdirSync(this.userDir, { recursive: true }); } catch {}
    let files: any[] = [];
    try { files = fs.readdirSync(this.userDir).filter((f: any) => FILE_PATTERN.test(f)).sort(); } catch {}
    const seen = new Map();
    for (const file of files) {
      const full = path.join(this.userDir, file);
      const entry: any = { file, path: full };
      try {
        if (file.endsWith('.json')) {
          const migration = this.migrateLegacyApiKey(file);
          if (migration.error) throw new Error(migration.error);
        }
        const adapter = this.loadFile(full);
        entry.id = adapter.id;
        entry.label = adapter.label;
        entry.type = adapter.type;
        entry.description = adapter.description || '';
        if (seen.has(adapter.id)) throw new Error(tx(this.getLocale(), 'ext.duplicateId', { id: adapter.id, file: seen.get(adapter.id) }));
        seen.set(adapter.id, file);
        const builtin = this.adapters.get(adapter.id);
        if (builtin && builtin.origin === 'builtin') entry.overrides = true;
        this.adapters.set(adapter.id, { ...adapter, origin: 'user', file });
      } catch (e: any) {
        entry.error = e.message;
      }
      this.entries.push(entry);
    }
    return this.summary();
  }

  loadFile(full: string): Adapter {
    const errors: string[] = [];
    let adapter: Adapter;
    if (full.endsWith('.json')) {
      let spec: any;
      try { spec = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e: any) { throw new Error(tx(this.getLocale(), 'ext.badJson', { error: e.message })); }
      validateCommon(spec, errors, this.getLocale());
      const type = spec && spec.type;
      if (type === 'cli') validateCliSpec(spec, errors, this.getLocale());
      else if (type === 'openai') validateOpenAISpec(spec, errors, this.getLocale());
      else errors.push(tx(this.getLocale(), 'ext.badType'));
      if (errors.length) throw new Error(errors.join(';'));
      adapter = type === 'cli' ? createCliAdapter(spec) : createOpenAIAdapter(spec, { fetchImpl: this.fetchImpl, getSecret: this.getSecret, getLocale: this.getLocale });
    } else {
      delete require.cache[require.resolve(full)];
      let mod = require(full);
      if (typeof mod === 'function') mod = mod(kit);
      validateCommon(mod, errors, this.getLocale());
      if (!mod || typeof mod.run !== 'function') errors.push(tx(this.getLocale(), 'ext.noRun'));
      if (errors.length) throw new Error(errors.join(';'));
      const staticModels = normalizeModels(mod.models);
      adapter = {
        id: mod.id,
        label: mod.label || mod.id,
        type: 'js',
        description: mod.description || '',
        bin: mod.bin || null,
        supportsResume: !!mod.supportsResume,
        supportsEdit: mod.supportsEdit != null ? !!mod.supportsEdit : true,
        efforts: mod.efforts || [],
        // 沒宣告時保持 undefined,attachmentCapabilities 才會依 supportsEdit 套用退路
        capabilities: mod.capabilities != null ? normalizeCapabilities(mod.capabilities) : undefined,
        listModels: () => {
          if (typeof mod.listModels === 'function') {
            const r = mod.listModels(kit);
            return Array.isArray(r) ? { models: normalizeModels(r), source: 'plugin' } : { ...r, models: normalizeModels(r && r.models) };
          }
          return { models: staticModels, source: staticModels.length ? 'config' : 'none' };
        },
        refreshModels: typeof mod.refreshModels === 'function' ? () => mod.refreshModels(kit) : undefined,
        check: typeof mod.check === 'function' ? () => mod.check(kit) : mod.bin ? (opts?: { locale?: TextLocale }) => kit.checkCli(mod.bin, undefined, opts?.locale) : undefined,
        run: (agent: any, ctx: any) => mod.run(agent, ctx, kit),
      };
    }
    return adapter;
  }

  summary() {
    return { dir: this.userDir, entries: this.entries.map(({ path: _p, ...e }: any) => e), templates: this.templates() };
  }

  get(id: string): RegisteredAdapter | null { return this.adapters.get(id) || null; }

  // 從磁碟重新讀一份獨立的轉接器實例，不動目前登錄的那份。
  // 測試連線要用剛儲存的設定，但不能清掉進行中對話的 session 記憶。
  loadFresh(id: string): Adapter | null {
    const current = this.adapters.get(id);
    if (!current || current.origin !== 'user' || !current.file) return current || null;
    try { return this.loadFile(path.join(this.userDir, current.file)); } catch { return current; }
  }
  list(): RegisteredAdapter[] { return [...this.adapters.values()]; }

  // ---------- 給介面用 ----------
  async catalog({ refreshTimeoutMs = 6000 }: any = {}) {
    const refreshes = this.list().map((a) => a.refreshModels).filter((refresh) => !!refresh).map((refresh) => Promise.resolve().then(refresh).catch(() => {}));
    if (refreshes.length) await Promise.race([Promise.all(refreshes), new Promise((r: any) => setTimeout(r, refreshTimeoutMs))]);
    const out: Record<string, any> = {};
    for (const a of this.list()) {
      let models: ModelList = { models: [], source: 'none' };
      try { models = a.listModels ? a.listModels() : models; } catch (e: any) { models = { models: [], source: 'error', error: e.message }; }
      out[a.id] = {
        id: a.id,
        label: a.label,
        type: a.type,
        origin: a.origin,
        file: a.file || null,
        description: a.description || '',
        bin: a.bin || null,
        supportsResume: !!a.supportsResume,
        supportsEdit: !!a.supportsEdit,
        capabilities: normalizeCapabilities(a.capabilities),
        usesCustomCommand: !!a.usesCustomCommand,
        efforts: a.efforts || [],
        models: models.models || [],
        modelSource: models.source,
        modelError: models.error || null,
      };
    }
    return out;
  }

  // probeCredentialed:連有 key 的雲端 API 真的驗證一次。預設關閉,因為啟動健康檢查
  // 不該每次都去打付費端點;使用者打開設定畫面時才帶 true——只檢查「key 有沒有填」
  // 會對過期或打錯的 key 亮綠燈,而他正要依那個燈號判斷能不能開會。
  async checkAll({ probeCredentialed = false }: { probeCredentialed?: boolean } = {}) {
    const results = await Promise.all(this.list().map(async (a) => {
      // 免 credential 的 OpenAI HTTP adapter 每次都探測（典型是 Ollama，本機且免費）。
      const probe = (a as RegisteredAdapter & { probeConnectionOnCheck?: boolean }).probeConnectionOnCheck;
      const shouldProbe = a.type === 'openai' && a.testConnection && (probe || probeCredentialed);
      if (!(shouldProbe ? a.testConnection : a.check)) return [a.id, null];
      let status: CliStatus;
      try {
        // testConnection 由 adapter 自己透過 getLocale 取語言;check 沒有 ctx,這裡把語言帶進去
        status = shouldProbe ? await a.testConnection!() : await a.check!({ locale: this.getLocale() });
      } catch (e: any) { status = { ok: false, error: e.message }; }
      const state = status.state || (status.ok ? 'ready' : a.type === 'openai' ? 'unauthenticated' : 'missing');
      const normalized: CliHealth = {
        ...status,
        // CLI 維持原本的 ready / missing；需要金鑰的 API 缺 key 時維持 unauthenticated。
        // 免金鑰 HTTP adapter 會由上面的 checker 選用 testConnection 並明確回傳 unreachable。
        state,
        fix: fixFromStatus(a as Adapter, { ...status, state }),
      };
      return [a.id, normalized];
    }));
    return Object.fromEntries(results.filter(([, r]: any) => r));
  }

  // 成員所用模型的能力(API 成員)。先看快取,沒有才問 adapter;live 代表使用者按了「測試」,
  // 一定重新實測。結果寫回快取,orchestrator 與 effectiveCanEdit 之後查得到。
  async modelCapability(adapterId: string, model: string, live = false): Promise<ModelCapability | null> {
    const adapter = this.get(adapterId);
    if (!adapter || adapter.type !== 'openai' || typeof adapter.modelCapability !== 'function') return null;
    // 先確保模型清單載入(有快取,很便宜):沒載入時 gemma3 不會被對應成 gemma3:latest,
    // 結果會存在一個流程之後查不到的名字下
    if (adapter.refreshModels) await adapter.refreshModels();
    const resolved = adapter.resolveModel ? adapter.resolveModel(model || '') : model;
    if (!resolved) return null;
    const key = capabilityKey(adapterId, adapter.endpoint, resolved);
    const store = capabilityStore();
    const cached = store.get(key);
    if (cached && !live) return cached;
    const found = await adapter.modelCapability(resolved, { live });
    if (!found) return cached || null;
    // 測試沒能下結論的項目,保留原本知道的。整個沒結論(例如端點剛好在忙、key 還沒設)就不覆蓋:
    // 以前一次失敗的測試會把「不能呼叫工具」洗成「不知道」並存檔,成員又拿到寫入工具、又被拒絕。
    // 這次的錯誤照樣帶回給介面顯示,但不存。
    if (found.tools === undefined && found.images === undefined) {
      return { ...(cached || { model: resolved, source: found.source, at: found.at }), ...(found.error ? { error: found.error } : {}) };
    }
    const tools = found.tools ?? cached?.tools;
    const images = found.images ?? cached?.images;
    const merged: ModelCapability = {
      model: resolved,
      source: found.source,
      at: found.at,
      ...(tools !== undefined ? { tools } : {}),
      ...(images !== undefined ? { images } : {}),
    };
    store.set(key, merged);
    return merged;
  }

  // 一鍵連接 Ollama：不帶 model 時只偵測並列出模型；帶 model 時套用內建範本並完成儲存。
  // 主程序只需把這一支方法透過 IPC 暴露給 renderer，不必讓介面理解 baseUrl / API key / JSON。
  async quickSetupOllama({ model }: { model?: string } = {}) {
    if (!this.userDir) throw new Error(tx(this.getLocale(), 'ext.noUserDir'));
    if (!this.templatesDir) throw new Error(tx(this.getLocale(), 'ext.noTemplateDir'));
    const templateFile = 'ollama-api.json';
    const templatePath = path.join(this.templatesDir, templateFile);
    let template: any;
    try { template = JSON.parse(fs.readFileSync(templatePath, 'utf8')); }
    catch (e: any) { throw new Error(tx(this.getLocale(), 'ext.ollamaTemplateUnreadable', { error: e.message })); }

    const existing = this.entries.find((entry: any) => entry.id === 'ollama' && !entry.error && entry.file?.endsWith('.json'));
    let existingSpec: any = {};
    if (existing) {
      try { existingSpec = JSON.parse(fs.readFileSync(this.safeUserPath(existing.file), 'utf8')); }
      catch (e: any) { throw new Error(tx(this.getLocale(), 'ext.ollamaConfigUnreadable', { error: e.message })); }
    }

    // 模型必須從實際要寫回的同一個端點取得；否則自訂 port / 遠端 Ollama 會拿到
    // localhost 的模型清單，直到第一次發話才發現選到不存在的模型。
    const baseUrl = typeof existingSpec.baseUrl === 'string' && existingSpec.baseUrl.trim()
      ? existingSpec.baseUrl.trim()
      : template.baseUrl;
    const discovery = await discoverOllama({ fetchImpl: this.fetchImpl, baseUrl, getLocale: this.getLocale });
    if (!discovery.ok) return { ...discovery, installed: false, recommendedModel: null };

    const recommendedModel = canonicalModelId(discovery.models, template.defaultModel)
      || discovery.models[0]?.id
      || null;
    if (!model) return { ...discovery, installed: false, recommendedModel };

    const selectedModel = canonicalModelId(discovery.models, model);
    if (!selectedModel) throw new Error(tx(this.getLocale(), 'ext.ollamaModelMissing', { model }));

    let file = existing?.file || templateFile;
    if (!existing) {
      const ext = path.extname(templateFile);
      const base = path.basename(templateFile, ext);
      for (let i = 2; fs.existsSync(path.join(this.userDir, file)); i++) file = `${base}-${i}${ext}`;
    }
    // 模型能力與行為必須跟最新範本走，避免舊版 efforts / capabilities / body 讓
    // thinking 靜默重開、強度選項失效，或多模態模型收不到圖片。
    // 只保留使用者環境與偏好欄位；未列入的舊範本欄位由新版範本取代。
    const preservedKeys = [
      'baseUrl', 'path', 'modelsPath', 'headers', 'modelFilter',
      'secretRef', 'apiKeyEnv', 'apiKeyOptional', 'unreachableHint', 'fixCommand', 'docsUrl',
      'timeoutMs', 'maxHistoryMessages', 'history', 'stream', 'streamUsage',
      'systemRole', 'reasoningFields',
    ];
    const preserved = Object.fromEntries(preservedKeys
      .filter((key) => Object.prototype.hasOwnProperty.call(existingSpec, key))
      .map((key) => [key, existingSpec[key]]));
    const spec = { ...template, ...preserved, id: 'ollama', defaultModel: selectedModel };
    const saved = this.writeFile(file, JSON.stringify(spec, null, 2) + '\n');
    if (saved.error) throw new Error(saved.error);
    return {
      ...discovery,
      installed: true,
      recommendedModel: selectedModel,
      selectedModel,
      adapterId: spec.id,
      file,
      summary: saved.summary,
    };
  }

  // ---------- 範本與檔案管理 ----------
  templates() {
    if (!this.templatesDir) return [];
    let files: any[] = [];
    try { files = fs.readdirSync(this.templatesDir).filter((f: any) => FILE_PATTERN.test(f)).sort(); } catch { return []; }
    return files.map((file: any) => {
      const full = path.join(this.templatesDir, file);
      let meta: Record<string, any> = {};
      try {
        if (file.endsWith('.json')) meta = JSON.parse(fs.readFileSync(full, 'utf8'));
        else {
          const src = fs.readFileSync(full, 'utf8');
          const pick = (k: any) => { const m = src.match(new RegExp(`\\b${k}:\\s*['"]([^'"]+)['"]`)); return m ? m[1] : undefined; };
          meta = { id: pick('id'), label: pick('label'), description: pick('description'), type: 'js' };
        }
      } catch {}
      return { file, id: meta.id || file, label: meta.label || file, type: meta.type || 'js', description: meta.description || '' };
    });
  }

  safeUserPath(file: any) {
    if (!FILE_PATTERN.test(file || '')) throw new Error(tx(this.getLocale(), 'ext.badFileName'));
    return path.join(this.userDir, file);
  }

  installTemplate(templateFile: any) {
    if (!FILE_PATTERN.test(templateFile || '')) throw new Error(tx(this.getLocale(), 'ext.badTemplate'));
    const src = path.join(this.templatesDir, templateFile);
    const ext = path.extname(templateFile);
    const base = path.basename(templateFile, ext);
    let name = templateFile;
    for (let i = 2; fs.existsSync(path.join(this.userDir, name)); i++) name = `${base}-${i}${ext}`;
    let content = fs.readFileSync(src, 'utf8');
    // 複製第二份時 id 也要跟著換,否則會和第一份衝突
    if (name !== templateFile && ext === '.json') {
      try {
        const spec = JSON.parse(content);
        spec.id = `${spec.id}-${name.slice(base.length + 1, -ext.length)}`;
        content = JSON.stringify(spec, null, 2) + '\n';
      } catch {}
    }
    fs.mkdirSync(this.userDir, { recursive: true });
    fs.writeFileSync(path.join(this.userDir, name), content);
    return { file: name, summary: this.reload() };
  }

  readFile(file: any) {
    return fs.readFileSync(this.safeUserPath(file), 'utf8');
  }

  // 舊版擴充把 API key 明文寫在 apiKey 欄位。先存進安全儲存，成功後才改寫檔案；
  // 任何一步失敗都保留原檔，避免 key 遺失。JSON 壞掉或沒有 apiKey 時什麼都不做。
  migrateLegacyApiKey(file: any) {
    const full = this.safeUserPath(file);
    let spec: any;
    try { spec = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { return { migrated: false }; }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) || spec.apiKey == null) return { migrated: false };
    const legacyKey = typeof spec.apiKey === 'string' ? spec.apiKey.trim() : '';
    if (legacyKey && !spec.secretRef && (typeof spec.id !== 'string' || !spec.id)) return { migrated: false };
    const ref = spec.secretRef || `adapter:${spec.id}`;
    try {
      if (legacyKey) {
        if (typeof this.setSecret !== 'function') throw new Error(tx(this.getLocale(), 'ext.noKeychain'));
        this.setSecret(ref, legacyKey);
        spec.secretRef = ref;
      }
      delete spec.apiKey;
      fs.writeFileSync(full, JSON.stringify(spec, null, 2) + '\n');
    } catch (e: any) {
      return { migrated: false, error: tx(this.getLocale(), 'ext.legacyKeyFailed', { error: e.message }) };
    }
    return { migrated: !!legacyKey };
  }

  writeFile(file: any, content: any, { originalFile }: any = {}) {
    const full = this.safeUserPath(file);
    if (file.endsWith('.json')) {
      try { JSON.parse(content); } catch (e: any) { throw new Error(tx(this.getLocale(), 'ext.badJsonUnsaved', { error: e.message })); }
    }
    if (originalFile && originalFile !== file && fs.existsSync(full)) throw new Error(tx(this.getLocale(), 'ext.exists', { file }));
    fs.mkdirSync(this.userDir, { recursive: true });
    fs.writeFileSync(full, content);
    if (originalFile && originalFile !== file) fs.rmSync(this.safeUserPath(originalFile), { force: true });
    const summary = this.reload();
    const entry = summary.entries.find((e: any) => e.file === file);
    return { summary, error: entry ? entry.error || null : null };
  }

  deleteFile(file: any) {
    fs.rmSync(this.safeUserPath(file), { force: true });
    return this.reload();
  }
}

export { Registry };
