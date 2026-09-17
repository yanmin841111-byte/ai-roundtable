'use strict';
// 模型目錄:從各 CLI 的本機快取讀出可用模型,統一格式後回傳。
// 解析結果依檔案「修改時間 + 大小」快取;檔案沒變就不重讀,CLI 更新快取後下次呼叫自動生效。
//
// 統一的模型格式:
//   { id, label, description, efforts: string[], defaultEffort, aliases: string[] }
//   efforts 為空陣列代表此模型不支援強度設定。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { findModel, resolveModelId, resolveEffort } = require('./model-rules');

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// 讀不到快取時使用的內建清單(2026-09 的正式清單)。
const FALLBACK = {
  claude: [
    { id: 'claude-fable-5-1', label: 'Fable 5.1', description: 'For your toughest challenges', efforts: CLAUDE_EFFORTS, defaultEffort: 'high', aliases: ['fable'] },
    { id: 'claude-opus-5', label: 'Opus 5', description: 'For complex tasks', efforts: CLAUDE_EFFORTS, defaultEffort: 'high', aliases: ['opus'] },
    { id: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Most efficient for everyday tasks', efforts: CLAUDE_EFFORTS, defaultEffort: 'high', aliases: ['sonnet'] },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: 'Fastest for quick answers', efforts: [], defaultEffort: '', aliases: ['haiku'] },
  ],
  codex: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', description: 'Latest frontier agentic coding model.', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low', aliases: [] },
    { id: 'gpt-6-astra', label: 'GPT-6-Astra', description: 'Our most capable model for complex, demanding work.', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low', aliases: [] },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', description: 'Balanced agentic coding model for everyday work.', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium', aliases: [] },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', description: 'Fast and affordable agentic coding model.', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', aliases: [] },
  ],
};

// ---------- 解析(純函式,方便測試) ----------

function normalize(m) {
  const efforts = [...new Set((m.efforts || []).map((e) => String(e).toLowerCase()).filter(Boolean))];
  return {
    id: m.id,
    label: m.label || m.id,
    description: m.description || '',
    efforts,
    defaultEffort: efforts.includes(m.defaultEffort) ? m.defaultEffort : '',
    aliases: [...new Set((m.aliases || []).map((a) => String(a).toLowerCase()).filter(Boolean))],
  };
}

// ~/.codex/models_cache.json
// 保留 Codex 自己會列出的模型(visibility 為 list),排除已標記升級 / 退役的模型(upgrade 不為空)。
function parseCodexCache(data) {
  const list = Array.isArray(data && data.models) ? data.models : [];
  return list
    .filter((m) => m && typeof m.slug === 'string' && (m.visibility == null || m.visibility === 'list') && !m.upgrade)
    .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity)) // sort 為穩定排序,同優先度維持原順序
    .map((m) => normalize({
      id: m.slug,
      label: m.display_name,
      description: m.description,
      efforts: (m.supported_reasoning_levels || []).map((l) => l && l.effort),
      defaultEffort: m.default_reasoning_level,
    }));
}

// ~/.claude/cache/model-catalog/*.json
// 只取正式清單(section 為 main);thinking 不是 effort 型的模型視為不支援強度。
function parseClaudeCatalog(data) {
  const list = data && data.catalog && data.catalog.config && data.catalog.config.models;
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => m && typeof m.id === 'string' && (m.section == null || m.section === 'main'))
    .map((m) => {
      const opts = m.thinking && m.thinking.type === 'effort' ? m.thinking.effort_options || [] : [];
      return normalize({
        id: m.id,
        label: m.name,
        description: m.description,
        efforts: opts.map((o) => o && o.id),
        defaultEffort: (opts.find((o) => o && o.badge) || {}).id,
        aliases: m.short_name ? [m.short_name] : [],
      });
    });
}

// ---------- 讀檔與快取 ----------

const parsedCache = new Map(); // file -> { sig, models }

// 讀取並解析單一檔案;檔案沒變就回傳上次的結果。讀不到或解析不出模型時回傳 null。
function readCatalogFile(file, parser, stat) {
  let st = stat;
  if (!st) {
    try { st = fs.statSync(file); } catch { parsedCache.delete(file); return null; }
  }
  const sig = `${st.mtimeMs}:${st.size}`;
  const hit = parsedCache.get(file);
  if (hit && hit.sig === sig) return hit.models;
  let models = null;
  try {
    const parsed = parser(JSON.parse(fs.readFileSync(file, 'utf8')));
    models = parsed.length ? parsed : null;
  } catch { models = null; }
  parsedCache.set(file, { sig, models });
  return models;
}

function codexHome() { return process.env.CODEX_HOME || path.join(os.homedir(), '.codex'); }
function claudeHome() { return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }

const SOURCES = {
  codex() {
    const file = path.join(codexHome(), 'models_cache.json');
    const models = readCatalogFile(file, parseCodexCache);
    return models ? { models, file } : null;
  },
  // 目錄下可能有多個帳號的快取檔:由新到舊嘗試,跳過壞掉或沒有模型的檔案。
  claude() {
    const dir = path.join(claudeHome(), 'cache', 'model-catalog');
    let entries;
    try { entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return null; }
    const files = [];
    for (const name of entries) {
      const file = path.join(dir, name);
      try { files.push({ file, stat: fs.statSync(file) }); } catch {}
    }
    files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    for (const { file, stat } of files) {
      const models = readCatalogFile(file, parseClaudeCatalog, stat);
      if (models) return { models, file };
    }
    return null;
  },
};

// ---------- 對外 API ----------

// 回傳 { models, source: 'cache' | 'fallback' | 'none', file }
function listModels(cli) {
  const read = SOURCES[cli];
  if (!read) return { models: [], source: 'none', file: null };
  const found = read();
  if (found) return { models: found.models, source: 'cache', file: found.file };
  return { models: (FALLBACK[cli] || []).map(normalize), source: 'fallback', file: null };
}

// 執行時用:把設定的模型與強度換成實際要送給 CLI 的值。
function resolveRunOptions(cli, model, effort) {
  const { models } = listModels(cli);
  const id = model ? resolveModelId(models, model) : '';
  return { model: id, ...resolveEffort(models, id, effort) };
}

module.exports = { listModels, resolveRunOptions, findModel, parseCodexCache, parseClaudeCatalog, FALLBACK };
