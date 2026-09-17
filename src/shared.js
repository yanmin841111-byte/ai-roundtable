// 共用工具:orchestrator(Node)與 renderer(瀏覽器)共用同一套標記語意。
// UMD:Node 走 module.exports,瀏覽器掛到 root.Shared。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 只檢查最後幾行,避免成員在內文中「提到」標記就被誤判。
  var TAIL_LINES = 3;

  function tagText(tag) { return '[' + String(tag || '').trim() + ']'; }

  // 標記必須單獨成一行,且出現在文字結尾的最後 TAIL_LINES 行之內。
  function hasMarker(text, tag) {
    if (!text || !tag) return false;
    var want = tagText(tag);
    var lines = String(text).replace(/\r\n/g, '\n').trimEnd().split('\n');
    var tail = lines.slice(-TAIL_LINES);
    for (var i = 0; i < tail.length; i++) if (tail[i].trim() === want) return true;
    return false;
  }

  // 移除所有「單獨成行」的該標記(不限最後幾行),回傳 trim 後的文字。
  function stripMarker(text, tag) {
    if (!text) return '';
    if (!tag) return String(text).trim();
    var want = tagText(tag);
    return String(text)
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter(function (l) { return l.trim() !== want; })
      .join('\n')
      .trim();
  }

  // 找出文字裡「@名稱」指定的成員(全形 ＠ 也算),依第一次出現的順序回傳、不重複。
  // 名稱長的先比，避免「Codex」被「Code」搶先配對；名稱後面緊接英數字時不算(「@Codex2」不是「Codex」)。
  // 中文名稱後面可以直接接內容，例如「@克勞德幫我看」。
  function findMentions(text, agents) {
    var source = String(text || '').replace(/＠/g, '@');
    var lower = source.toLowerCase();
    var list = (agents || []).filter(function (a) { return a && typeof a.name === 'string' && a.name.trim(); });
    list.sort(function (a, b) { return b.name.trim().length - a.name.trim().length; });
    var used = [];
    var hits = [];
    var taken = function (from, to) {
      for (var i = 0; i < used.length; i++) if (from < used[i][1] && to > used[i][0]) return true;
      return false;
    };
    for (var k = 0; k < list.length; k++) {
      var needle = '@' + list[k].name.trim().toLowerCase();
      var at = lower.indexOf(needle);
      while (at >= 0) {
        var end = at + needle.length;
        var next = source.charAt(end);
        if (!/[A-Za-z0-9_-]/.test(next) && !taken(at, end)) {
          used.push([at, end]);
          hits.push({ index: at, agent: list[k] });
          break;
        }
        at = lower.indexOf(needle, at + 1);
      }
    }
    hits.sort(function (a, b) { return a.index - b.index; });
    return hits.map(function (h) { return h.agent; });
  }

  return { hasMarker: hasMarker, stripMarker: stripMarker, findMentions: findMentions, TAIL_LINES: TAIL_LINES };
});
