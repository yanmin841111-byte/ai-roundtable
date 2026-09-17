const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-roundtable-models-'));

const codexHome = path.join(base, 'codex'); const claudeHome = path.join(base, 'claude');
const catDir = path.join(claudeHome, 'cache', 'model-catalog');
fs.mkdirSync(codexHome, { recursive: true }); fs.mkdirSync(catDir, { recursive: true });
process.env.CODEX_HOME = codexHome; process.env.CLAUDE_CONFIG_DIR = claudeHome;

const M = require('../src/models');
const R = require('../src/model-rules');
let n = 0; const t = (name: any, fn: any) => { fn(); n++; console.log('ok -', name); };
const lv = (...e: any[]) => e.map((effort: any) => ({ effort }));

t('兩邊都沒快取時退回內建清單', () => {
  assert.strictEqual(M.listModels('codex').source, 'fallback');
  assert.strictEqual(M.listModels('claude').source, 'fallback');
  assert.strictEqual(M.listModels('custom').source, 'none');
});

const codexFile = path.join(codexHome, 'models_cache.json');
fs.writeFileSync(codexFile, JSON.stringify({ models: [
  { slug: 'b', display_name: 'B', priority: 5, visibility: 'list', supported_reasoning_levels: lv('low', 'high'), default_reasoning_level: 'low' },
  { slug: 'hidden', priority: 1, visibility: 'hide', supported_reasoning_levels: lv('low') },
  { slug: 'old', priority: 2, visibility: 'list', upgrade: { model: 'b' }, supported_reasoning_levels: lv('low') },
  { slug: 'a', display_name: 'A', priority: 1, visibility: 'list', supported_reasoning_levels: lv('low', 'medium', 'high', 'ultra'), default_reasoning_level: 'nonsense' },
  { slug: 'noprio', visibility: 'list', supported_reasoning_levels: [] },
] }));

t('Codex:排除隱藏與退役、依優先度排序、無效預設強度清空', () => {
  const r = M.listModels('codex');
  assert.strictEqual(r.source, 'cache');
  assert.deepStrictEqual(r.models.map((m: any) => m.id), ['a', 'b', 'noprio']);
  assert.strictEqual(r.models[0].defaultEffort, '');
  assert.strictEqual(r.models[1].defaultEffort, 'low');
});

t('檔案沒變時回傳快取結果(同一個陣列物件)', () => {
  assert.strictEqual(M.listModels('codex').models, M.listModels('codex').models);
});

t('檔案內容變更後自動重讀', () => {
  const later = new Date(Date.now() + 5000);
  fs.writeFileSync(codexFile, JSON.stringify({ models: [{ slug: 'z', visibility: 'list', supported_reasoning_levels: lv('low') }] }));
  fs.utimesSync(codexFile, later, later);
  assert.deepStrictEqual(M.listModels('codex').models.map((m: any) => m.id), ['z']);
});

t('Codex 快取壞掉時退回內建清單', () => {
  const later = new Date(Date.now() + 10000);
  fs.writeFileSync(codexFile, '{not json');
  fs.utimesSync(codexFile, later, later);
  assert.strictEqual(M.listModels('codex').source, 'fallback');
});

const claudeCat = (models: any) => JSON.stringify({ catalog: { config: { models } } });
const effortThinking = (ids: any, def: any) => ({ type: 'effort', effort_options: ids.map((id: any) => (id === def ? { id, badge: {} } : { id })) });
const older = path.join(catDir, 'older.json'); const newer = path.join(catDir, 'newer.json');
fs.writeFileSync(older, claudeCat([
  { id: 'claude-x-1', name: 'X 1', short_name: 'X', section: 'main', thinking: effortThinking(['low', 'high', 'max'], 'high') },
  { id: 'claude-legacy', name: 'Legacy', section: 'legacy', thinking: effortThinking(['low'], 'low') },
  { id: 'claude-y', name: 'Y', short_name: 'y', section: 'main', thinking: { type: 'adaptive' } },
]));
fs.writeFileSync(newer, 'broken');
const t0 = new Date(Date.now() - 60000); const t1 = new Date();
fs.utimesSync(older, t0, t0); fs.utimesSync(newer, t1, t1);

t('Claude:最新的檔案壞掉時改用較舊的檔案', () => {
  const r = M.listModels('claude');
  assert.strictEqual(r.source, 'cache');
  assert.strictEqual(path.basename(r.file), 'older.json');
});

t('Claude:只取 main、別名轉小寫、非 effort 型視為不支援強度', () => {
  const r = M.listModels('claude');
  assert.deepStrictEqual(r.models.map((m: any) => m.id), ['claude-x-1', 'claude-y']);
  assert.deepStrictEqual(r.models[0].aliases, ['x']);
  assert.strictEqual(r.models[0].defaultEffort, 'high');
  assert.deepStrictEqual(r.models[1].efforts, []);
});

t('resolveRunOptions:別名轉完整名稱、支援的強度原樣送出', () => {
  assert.deepStrictEqual(M.resolveRunOptions('claude', 'X', 'HIGH'), { model: 'claude-x-1', effort: 'high', note: null });
});

t('resolveRunOptions:不支援強度的模型略過強度並附說明', () => {
  const r = M.resolveRunOptions('claude', 'y', 'high');
  assert.strictEqual(r.effort, null); assert.ok(r.note);
});

t('resolveRunOptions:不支援的強度降到不超過要求的最高等級', () => {
  assert.strictEqual(M.resolveRunOptions('claude', 'claude-x-1', 'xhigh').effort, 'high');
  assert.strictEqual(M.resolveRunOptions('claude', 'claude-x-1', 'ultra').effort, 'max');
  assert.strictEqual(M.resolveRunOptions('claude', 'claude-x-1', 'minimal').effort, 'low');
});

t('resolveRunOptions:不認得的模型與強度照原樣送出、空值不送', () => {
  assert.deepStrictEqual(M.resolveRunOptions('claude', 'claude-future-9', 'ultra'), { model: 'claude-future-9', effort: 'ultra', note: null });
  assert.deepStrictEqual(M.resolveRunOptions('claude', '', ''), { model: '', effort: null, note: null });
});

t('resolveEffort:無法排序的強度退回模型預設', () => {
  const models = [{ id: 'm', label: 'M', efforts: ['fast', 'slow'], defaultEffort: 'slow', aliases: [] }];
  assert.deepStrictEqual(R.resolveEffort(models, 'm', 'turbo'), { effort: 'slow', note: 'M 不支援強度 turbo,改用 slow' });
});

t('findModel:完整名稱優先於別名', () => {
  const models = [{ id: 'opus', aliases: [] }, { id: 'claude-opus-5', aliases: ['opus'] }];
  assert.strictEqual(R.findModel(models, 'opus').id, 'opus');
});

fs.rmSync(base, { recursive: true, force: true });
console.log(`\n${n} tests passed`);
