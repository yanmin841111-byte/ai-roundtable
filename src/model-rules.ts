// 模型規則:別名比對、強度驗證。不碰檔案系統,主程序與 renderer 共用同一套判斷。
// 標準 ESM export:Node 端由 tsc 編成 CommonJS,renderer 端由 esbuild inline 進 bundle。

// 統一的模型格式(產生處見 src/models.js 的 normalize)。
// efforts 為空陣列代表此模型不支援強度設定;unrestrictedEffort 代表設定檔沒限制強度。
export interface Model {
  id: string;
  label: string;
  description?: string;
  efforts?: string[];
  defaultEffort?: string;
  aliases?: string[];
  unrestrictedEffort?: boolean;
  lowCost?: boolean;
}

// 回傳 { effort, note }:effort 為 null 表示不傳強度參數;note 說明做了什麼調整。
export interface EffortResolution {
  effort: string | null;
  note: string | null;
}

// 由弱到強。不在表中的強度無法比較,只接受完全相符。
export const EFFORT_RANK = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

function lower(s: unknown): string {
  return String(s == null ? '' : s).trim().toLowerCase();
}

// 依完整 id 或別名(不分大小寫)找模型;找不到回傳 null。
export function findModel(models: readonly Model[] | null | undefined, name: unknown): Model | null {
  const key = lower(name);
  if (!key || !models) return null;
  for (const m of models) {
    if (lower(m.id) === key) return m;
  }
  for (const m of models) {
    const aliases = m.aliases || [];
    for (const alias of aliases) if (lower(alias) === key) return m;
  }
  return null;
}

// 別名轉成完整 id;不認得的名稱原樣保留(可能是使用者手動輸入的新模型)。
export function resolveModelId(models: readonly Model[] | null | undefined, name: unknown): string {
  const m = findModel(models, name);
  return m ? m.id : String(name == null ? '' : name).trim();
}

// 決定實際要送出的強度。
export function resolveEffort(
  models: readonly Model[] | null | undefined,
  modelName: unknown,
  effort: unknown,
): EffortResolution {
  const want = lower(effort);
  if (!want) return { effort: null, note: null };
  const m = findModel(models, modelName);
  if (!m) return { effort: want, note: null }; // 不認得的模型無從驗證,照使用者設定送出
  if (m.unrestrictedEffort) return { effort: want, note: null }; // 設定檔沒限制強度,照使用者設定送出
  const supported = m.efforts || [];
  if (supported.length === 0) return { effort: null, note: m.label + ' 不支援強度設定,已略過 ' + want };
  if (supported.indexOf(want) >= 0) return { effort: want, note: null };

  // 不支援時,改用「不超過要求」的最高等級;都比要求高時用最低等級。
  const rank = EFFORT_RANK.indexOf(want);
  const ranked = supported
    .map((e) => ({ e, r: EFFORT_RANK.indexOf(e) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r);
  let pick: string | null = null;
  if (rank >= 0 && ranked.length) {
    for (let i = ranked.length - 1; i >= 0; i--) if (ranked[i].r <= rank) { pick = ranked[i].e; break; }
    if (!pick) pick = ranked[0].e;
  }
  if (!pick) pick = m.defaultEffort && supported.indexOf(m.defaultEffort) >= 0 ? m.defaultEffort : null;
  return {
    effort: pick,
    note: m.label + ' 不支援強度 ' + want + (pick ? ',改用 ' + pick : ',改用模型預設'),
  };
}
