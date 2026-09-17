// 模型規則:別名比對、強度驗證。不碰檔案系統,主程序與 renderer 共用同一套判斷。
// UMD:Node 走 module.exports,瀏覽器掛到 root.ModelRules。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ModelRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 由弱到強。不在表中的強度無法比較,只接受完全相符。
  var EFFORT_RANK = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

  function lower(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

  // 依完整 id 或別名(不分大小寫)找模型;找不到回傳 null。
  function findModel(models, name) {
    var key = lower(name);
    if (!key || !models) return null;
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      if (lower(m.id) === key) return m;
    }
    for (var j = 0; j < models.length; j++) {
      var aliases = models[j].aliases || [];
      for (var k = 0; k < aliases.length; k++) if (lower(aliases[k]) === key) return models[j];
    }
    return null;
  }

  // 別名轉成完整 id;不認得的名稱原樣保留(可能是使用者手動輸入的新模型)。
  function resolveModelId(models, name) {
    var m = findModel(models, name);
    return m ? m.id : String(name == null ? '' : name).trim();
  }

  // 決定實際要送出的強度。
  // 回傳 { effort, note }:effort 為 null 表示不傳強度參數;note 說明做了什麼調整。
  function resolveEffort(models, modelName, effort) {
    var want = lower(effort);
    if (!want) return { effort: null, note: null };
    var m = findModel(models, modelName);
    if (!m) return { effort: want, note: null }; // 不認得的模型無從驗證,照使用者設定送出
    if (m.unrestrictedEffort) return { effort: want, note: null }; // 設定檔沒限制強度,照使用者設定送出
    var supported = m.efforts || [];
    if (supported.length === 0) return { effort: null, note: m.label + ' 不支援強度設定,已略過 ' + want };
    if (supported.indexOf(want) >= 0) return { effort: want, note: null };

    // 不支援時,改用「不超過要求」的最高等級;都比要求高時用最低等級。
    var rank = EFFORT_RANK.indexOf(want);
    var ranked = supported
      .map(function (e) { return { e: e, r: EFFORT_RANK.indexOf(e) }; })
      .filter(function (x) { return x.r >= 0; })
      .sort(function (a, b) { return a.r - b.r; });
    var pick = null;
    if (rank >= 0 && ranked.length) {
      for (var i = ranked.length - 1; i >= 0; i--) if (ranked[i].r <= rank) { pick = ranked[i].e; break; }
      if (!pick) pick = ranked[0].e;
    }
    if (!pick) pick = m.defaultEffort && supported.indexOf(m.defaultEffort) >= 0 ? m.defaultEffort : null;
    return {
      effort: pick,
      note: m.label + ' 不支援強度 ' + want + (pick ? ',改用 ' + pick : ',改用模型預設'),
    };
  }

  return { EFFORT_RANK: EFFORT_RANK, findModel: findModel, resolveModelId: resolveModelId, resolveEffort: resolveEffort };
});
