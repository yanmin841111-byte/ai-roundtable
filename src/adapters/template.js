'use strict';
// 擴充設定檔用的小工具:取值路徑、字串範本、條件參數、事件比對。

// 以點號路徑取值,例如 "delta.text"、"tool_calls.0.function.name"。空路徑回傳物件本身。
function getPath(obj, path) {
  if (path == null || path === '' || path === '.') return obj;
  let cur = obj;
  for (const key of String(path).split('.')) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

const PLACEHOLDER = /\{\{|\}\}|\{([^{}]+)\}/g;

function isEmpty(v) {
  return v === undefined || v === null || v === '' || v === false;
}

function stringify(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// 找出字串中的佔位名稱(不含 {{ }} 跳脫)
function placeholders(str) {
  const names = [];
  String(str).replace(PLACEHOLDER, (m, name) => { if (name) names.push(name.trim()); return m; });
  return names;
}

// "{model}" → vars.model;"{{" 與 "}}" 輸出成單一大括號。
function render(str, vars) {
  return String(str).replace(PLACEHOLDER, (m, name) => {
    if (m === '{{') return '{';
    if (m === '}}') return '}';
    return stringify(getPath(vars, name.trim()));
  });
}

// 條件:"name" 為真、"!name" 為假、"name=value" 相等、"name!=value" 不相等;陣列表示全部成立。
function evalCondition(cond, vars) {
  if (Array.isArray(cond)) return cond.every((c) => evalCondition(c, vars));
  const s = String(cond).trim();
  let m = s.match(/^([^!=]+)!=(.*)$/);
  if (m) return stringify(getPath(vars, m[1].trim())) !== m[2].trim();
  m = s.match(/^([^!=]+)=(.*)$/);
  if (m) return stringify(getPath(vars, m[1].trim())) === m[2].trim();
  if (s.startsWith('!')) return isEmpty(getPath(vars, s.slice(1).trim()));
  return !isEmpty(getPath(vars, s));
}

// 組參數。每個元素可以是:
//   "字串"                      含佔位時,任一佔位為空就略過這個參數
//   ["-m", "{model}"]           參數群組,任一佔位為空就整組略過
//   { "if": "cond", "then": [...], "else": [...] }  依條件選擇
function buildArgs(spec, vars) {
  const out = [];
  for (const item of spec || []) {
    if (typeof item === 'string' || typeof item === 'number') {
      const s = String(item);
      if (placeholders(s).some((n) => isEmpty(getPath(vars, n)))) continue;
      out.push(render(s, vars));
    } else if (Array.isArray(item)) {
      const strings = item.map(String);
      if (strings.some((s) => placeholders(s).some((n) => isEmpty(getPath(vars, n))))) continue;
      out.push(...strings.map((s) => render(s, vars)));
    } else if (item && typeof item === 'object' && 'if' in item) {
      out.push(...buildArgs(evalCondition(item.if, vars) ? item.then : item.else, vars));
    }
  }
  return out;
}

// 深層套用範本:物件與陣列中的字串都會 render;整個字串剛好是單一佔位時保留原始型別。
function renderDeep(value, vars) {
  if (typeof value === 'string') {
    const only = value.match(/^\{([^{}]+)\}$/);
    if (only) return getPath(vars, only[1].trim());
    return render(value, vars);
  }
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderDeep(v, vars);
    return out;
  }
  return value;
}

// 事件比對。match 的每個 key 是路徑,value 可以是:
//   字面值               完全相等
//   [a, b]               其中之一
//   { "$exists": true }  存在與否
//   { "$startsWith": "item." } / { "$regex": "^a" } / { "$ne": x } / { "$in": [...] }
function matches(event, match) {
  if (!match) return true;
  for (const [path, expected] of Object.entries(match)) {
    const v = getPath(event, path);
    if (Array.isArray(expected)) {
      if (!expected.includes(v)) return false;
    } else if (expected && typeof expected === 'object') {
      if ('$exists' in expected && (v !== undefined) !== !!expected.$exists) return false;
      if ('$startsWith' in expected && !(typeof v === 'string' && v.startsWith(expected.$startsWith))) return false;
      if ('$regex' in expected && !(typeof v === 'string' && new RegExp(expected.$regex).test(v))) return false;
      if ('$ne' in expected && v === expected.$ne) return false;
      if ('$in' in expected && !(Array.isArray(expected.$in) && expected.$in.includes(v))) return false;
    } else if (v !== expected) {
      return false;
    }
  }
  return true;
}

module.exports = { getPath, render, renderDeep, buildArgs, evalCondition, matches, placeholders, isEmpty };
