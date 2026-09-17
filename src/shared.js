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

  return { hasMarker: hasMarker, stripMarker: stripMarker, TAIL_LINES: TAIL_LINES };
});
