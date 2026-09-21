'use strict';

// 程式裡用到的每個文案 key,中英文字典都要有。
//
// 為什麼需要:缺 key 不會讓程式壞掉,只會讓使用者看到 `sys.reverted` 這種原始字串,
// 而且多半出現在少見的路徑上(還原失敗、某種錯誤),測試與手動點都不容易碰到。
// 實際發生過:一次批次修改中途失敗,文案沒被寫進字典,流程照跑,訊息變成 key。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

const ROOT = path.resolve(__dirname, '..');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

// 取出一次呼叫括號裡的所有字串常數:支援 this.text(cond ? 'a' : 'b') 這種寫法,
// 那正是第一版漏掉的情況(漏掉就等於守門的門沒關)。
function keysInCalls(source: string): string[] {
  const out: string[] = [];
  const call = /(?:this\.text|\btx)\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(source))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
    }
    const args = source.slice(m.index + m[0].length, i);
    // 只取看起來像 key 的字串:字母開頭、含點、沒有空白或斜線(排除路徑與訊息)
    for (const lit of args.matchAll(/'([a-zA-Z][\w]*(?:\.[\w]+)+)'/g)) out.push(lit[1]);
  }
  return out;
}

test('src/ 用到的 tx / this.text key,繁中與英文都有', () => {
  // 直接比對兩本字典,不用 tx() 試:找不到英文時 tx 會退回中文,
  // 那正是最該抓的情況——英文使用者看到的是中文,不是錯誤。
  const dict = fs.readFileSync(path.join(ROOT, 'src', 'text.ts'), 'utf8');
  const enAt = dict.indexOf('const EN');
  const keysIn = (text: string) => new Set([...text.matchAll(/'([a-zA-Z][\w]*(?:\.[\w]+)+)':/g)].map((m) => m[1]));
  const zh = keysIn(dict.slice(0, enAt));
  const en = keysIn(dict.slice(enAt));
  const missing: string[] = [];
  for (const file of walk(path.join(ROOT, 'src'))) {
    if (file.endsWith(path.join('src', 'text.ts'))) continue;
    for (const key of keysInCalls(fs.readFileSync(file, 'utf8'))) {
      if (key === 'zh-Hant') continue;
      if (!zh.has(key)) missing.push(`${key}(繁中) ← ${path.relative(ROOT, file)}`);
      if (!en.has(key)) missing.push(`${key}(英文) ← ${path.relative(ROOT, file)}`);
    }
  }
  assert.deepStrictEqual(missing, [], `這些文案 key 在字典裡找不到:\n${missing.join('\n')}`);
});

test('兩本字典的 key 要一模一樣', () => {
  const dict = fs.readFileSync(path.join(ROOT, 'src', 'text.ts'), 'utf8');
  const enAt = dict.indexOf('const EN');
  const keysIn = (text: string) => new Set([...text.matchAll(/'([a-zA-Z][\w]*(?:\.[\w]+)+)':/g)].map((m) => m[1]));
  const zh = keysIn(dict.slice(0, enAt));
  const en = keysIn(dict.slice(enAt));
  assert.deepStrictEqual([...zh].filter((k) => !en.has(k)), [], '有中文沒英文的 key');
  assert.deepStrictEqual([...en].filter((k) => !zh.has(k)), [], '有英文沒中文的 key');
});

test('renderer 用到的 t(key),繁中與英文都有', () => {
  const source = walk(path.join(ROOT, 'renderer')).map((f) => [f, fs.readFileSync(f, 'utf8')] as const);
  const dict = fs.readFileSync(path.join(ROOT, 'renderer', 'i18n.ts'), 'utf8');
  const zh = new Set([...dict.slice(0, dict.indexOf('const EN')).matchAll(/^\s+'([\w.]+)':/gm)].map((m) => m[1]));
  const en = new Set([...dict.slice(dict.indexOf('const EN')).matchAll(/^\s+'([\w.]+)':/gm)].map((m) => m[1]));
  const missing: string[] = [];
  for (const [file, text] of source) {
    if (file.endsWith('i18n.ts')) continue;
    for (const m of text.matchAll(/\bt\(\s*'([a-zA-Z][\w.]+)'/g)) {
      const key = m[1];
      if (!zh.has(key)) missing.push(`${key}(繁中) ← ${path.relative(ROOT, file)}`);
      if (!en.has(key)) missing.push(`${key}(英文) ← ${path.relative(ROOT, file)}`);
    }
  }
  assert.deepStrictEqual(missing, [], `這些文案 key 在字典裡找不到:\n${missing.join('\n')}`);
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} text key tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
