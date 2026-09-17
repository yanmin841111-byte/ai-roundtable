'use strict';
// 轉接器登錄中心:內建轉接器 + 使用者擴充資料夾裡的 *.json / *.js。
//
// 轉接器介面(內建與擴充都一樣):
//   id, label, type('builtin' | 'cli' | 'openai' | 'js'), description
//   bin              指令名稱(沒有就 null)
//   supportsResume   能否用 sessionId 續接;不能時每回合會送完整對話紀錄
//   supportsEdit     能否修改檔案 / 執行指令;不能時成員的「允許修改檔案」無效
//   efforts          手動輸入模型時可選的強度
//   listModels()     → { models, source, error? }(同步,回傳目前已知的清單)
//   refreshModels?() → Promise,更新需要非同步取得的模型清單
//   check?()         → Promise<{ ok, version?, error? }>
//   run(agent, ctx)  → Promise<{ text, thinking, sessionId, usage, error }>

const fs = require('fs');
const path = require('path');
const { builtinAdapters } = require('./builtin');
const { validateCommon, normalizeModels, normalizeCapabilities } = require('./spec');
const { createCliAdapter, validateCliSpec } = require('./cli-adapter');
const { createOpenAIAdapter, validateOpenAISpec } = require('./openai-adapter');
const kit = require('./kit');

const FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(json|js)$/;

class Registry {
  constructor({ userDir, templatesDir, fetchImpl, getSecret, setSecret } = {}) {
    this.userDir = userDir;
    this.templatesDir = templatesDir;
    this.fetchImpl = fetchImpl;
    this.getSecret = getSecret;
    this.setSecret = setSecret;
    this.adapters = new Map();
    this.entries = []; // 使用者擴充的載入結果(含錯誤)
    this.reload();
  }

  // ---------- 載入 ----------
  reload() {
    this.adapters = new Map(builtinAdapters.map((a) => [a.id, { ...a, origin: 'builtin' }]));
    this.entries = [];
    if (!this.userDir) return this.summary();
    try { fs.mkdirSync(this.userDir, { recursive: true }); } catch {}
    let files = [];
    try { files = fs.readdirSync(this.userDir).filter((f) => FILE_PATTERN.test(f)).sort(); } catch {}
    const seen = new Map();
    for (const file of files) {
      const full = path.join(this.userDir, file);
      const entry = { file, path: full };
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
        if (seen.has(adapter.id)) throw new Error(`id「${adapter.id}」與 ${seen.get(adapter.id)} 重複`);
        seen.set(adapter.id, file);
        const builtin = this.adapters.get(adapter.id);
        if (builtin && builtin.origin === 'builtin') entry.overrides = true;
        this.adapters.set(adapter.id, { ...adapter, origin: 'user', file });
      } catch (e) {
        entry.error = e.message;
      }
      this.entries.push(entry);
    }
    return this.summary();
  }

  loadFile(full) {
    const errors = [];
    let adapter;
    if (full.endsWith('.json')) {
      let spec;
      try { spec = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) { throw new Error(`JSON 格式錯誤:${e.message}`); }
      validateCommon(spec, errors);
      const type = spec && spec.type;
      if (type === 'cli') validateCliSpec(spec, errors);
      else if (type === 'openai') validateOpenAISpec(spec, errors);
      else errors.push('type 必須是 "cli" 或 "openai"(需要更多彈性時請改寫成 .js 外掛)');
      if (errors.length) throw new Error(errors.join(';'));
      adapter = type === 'cli' ? createCliAdapter(spec) : createOpenAIAdapter(spec, { fetchImpl: this.fetchImpl, getSecret: this.getSecret });
    } else {
      delete require.cache[require.resolve(full)];
      let mod = require(full);
      if (typeof mod === 'function') mod = mod(kit);
      validateCommon(mod, errors);
      if (!mod || typeof mod.run !== 'function') errors.push('必須匯出 run(agent, ctx, kit) 函式');
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
        capabilities: normalizeCapabilities(mod.capabilities),
        listModels: () => {
          if (typeof mod.listModels === 'function') {
            const r = mod.listModels(kit);
            return Array.isArray(r) ? { models: normalizeModels(r), source: 'plugin' } : { ...r, models: normalizeModels(r && r.models) };
          }
          return { models: staticModels, source: staticModels.length ? 'config' : 'none' };
        },
        refreshModels: typeof mod.refreshModels === 'function' ? () => mod.refreshModels(kit) : undefined,
        check: typeof mod.check === 'function' ? () => mod.check(kit) : mod.bin ? () => kit.checkCli(mod.bin) : undefined,
        run: (agent, ctx) => mod.run(agent, ctx, kit),
      };
    }
    return adapter;
  }

  summary() {
    return { dir: this.userDir, entries: this.entries.map(({ path: _p, ...e }) => e), templates: this.templates() };
  }

  get(id) { return this.adapters.get(id) || null; }
  list() { return [...this.adapters.values()]; }

  // ---------- 給介面用 ----------
  async catalog({ refreshTimeoutMs = 6000 } = {}) {
    const refreshes = this.list().filter((a) => a.refreshModels).map((a) => Promise.resolve().then(() => a.refreshModels()).catch(() => {}));
    if (refreshes.length) await Promise.race([Promise.all(refreshes), new Promise((r) => setTimeout(r, refreshTimeoutMs))]);
    const out = {};
    for (const a of this.list()) {
      let models = { models: [], source: 'none' };
      try { models = a.listModels ? a.listModels() : models; } catch (e) { models = { models: [], source: 'error', error: e.message }; }
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

  async checkAll() {
    const results = await Promise.all(this.list().map(async (a) => {
      if (!a.check) return [a.id, null];
      try { return [a.id, await a.check()]; } catch (e) { return [a.id, { ok: false, error: e.message }]; }
    }));
    return Object.fromEntries(results.filter(([, r]) => r));
  }

  // ---------- 範本與檔案管理 ----------
  templates() {
    if (!this.templatesDir) return [];
    let files = [];
    try { files = fs.readdirSync(this.templatesDir).filter((f) => FILE_PATTERN.test(f)).sort(); } catch { return []; }
    return files.map((file) => {
      const full = path.join(this.templatesDir, file);
      let meta = {};
      try {
        if (file.endsWith('.json')) meta = JSON.parse(fs.readFileSync(full, 'utf8'));
        else {
          const src = fs.readFileSync(full, 'utf8');
          const pick = (k) => { const m = src.match(new RegExp(`\\b${k}:\\s*['"]([^'"]+)['"]`)); return m ? m[1] : undefined; };
          meta = { id: pick('id'), label: pick('label'), description: pick('description'), type: 'js' };
        }
      } catch {}
      return { file, id: meta.id || file, label: meta.label || file, type: meta.type || 'js', description: meta.description || '' };
    });
  }

  safeUserPath(file) {
    if (!FILE_PATTERN.test(file || '')) throw new Error('檔名只能包含英數字、. _ -,並以 .json 或 .js 結尾');
    return path.join(this.userDir, file);
  }

  installTemplate(templateFile) {
    if (!FILE_PATTERN.test(templateFile || '')) throw new Error('範本名稱不正確');
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

  readFile(file) {
    return fs.readFileSync(this.safeUserPath(file), 'utf8');
  }

  // 舊版擴充把 API key 明文寫在 apiKey 欄位。先存進安全儲存，成功後才改寫檔案；
  // 任何一步失敗都保留原檔，避免 key 遺失。JSON 壞掉或沒有 apiKey 時什麼都不做。
  migrateLegacyApiKey(file) {
    const full = this.safeUserPath(file);
    let spec;
    try { spec = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { return { migrated: false }; }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) || spec.apiKey == null) return { migrated: false };
    const legacyKey = typeof spec.apiKey === 'string' ? spec.apiKey.trim() : '';
    if (legacyKey && !spec.secretRef && (typeof spec.id !== 'string' || !spec.id)) return { migrated: false };
    const ref = spec.secretRef || `adapter:${spec.id}`;
    try {
      if (legacyKey) {
        if (typeof this.setSecret !== 'function') throw new Error('系統安全儲存目前不可用');
        this.setSecret(ref, legacyKey);
        spec.secretRef = ref;
      }
      delete spec.apiKey;
      fs.writeFileSync(full, JSON.stringify(spec, null, 2) + '\n');
    } catch (e) {
      return { migrated: false, error: `偵測到舊版明文 API key，但${e.message}。請設定環境變數後移除檔案中的 apiKey` };
    }
    return { migrated: !!legacyKey };
  }

  writeFile(file, content, { originalFile } = {}) {
    const full = this.safeUserPath(file);
    if (file.endsWith('.json')) {
      try { JSON.parse(content); } catch (e) { throw new Error(`JSON 格式錯誤,尚未儲存:${e.message}`); }
    }
    if (originalFile && originalFile !== file && fs.existsSync(full)) throw new Error(`已經有名為 ${file} 的擴充`);
    fs.mkdirSync(this.userDir, { recursive: true });
    fs.writeFileSync(full, content);
    if (originalFile && originalFile !== file) fs.rmSync(this.safeUserPath(originalFile), { force: true });
    const summary = this.reload();
    const entry = summary.entries.find((e) => e.file === file);
    return { summary, error: entry ? entry.error || null : null };
  }

  deleteFile(file) {
    fs.rmSync(this.safeUserPath(file), { force: true });
    return this.reload();
  }
}

module.exports = { Registry };
