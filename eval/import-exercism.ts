// 從 Exercism 的 problem-specifications 下載官方標準測資,轉成這裡的題目格式。
//
// 為什麼不自己出題:自己出題有兩個弱點——難度是猜的,測資也是自己寫的,
// 我對規格的誤解會同時進到題目與測試裡,量到的就變成「我有沒有寫對測試」。
// Exercism 的題目與測資是社群校準過的,邊界案例也比較齊。
//
// 授權:exercism/problem-specifications 為 MIT(Copyright (c) 2014, 2019, 2021 Exercism)。
// 這支程式只在需要更新測資時手動執行(要連網);跑實驗時讀的是已經存進版控的 JSON,離線可重現。
//   npx tsx eval/import-exercism.ts book-store dominoes
import fs from 'fs';
import path from 'path';

const BASE = 'https://raw.githubusercontent.com/exercism/problem-specifications/main/exercises';
const OUT = path.join(__dirname, 'exercism-data.json');

interface Case { description: string; property: string; input: Record<string, unknown>; expected: unknown }

// 巢狀的分組攤平成一串案例;沒有 expected 的分組節點自己不是案例
function flatten(cases: any[]): Case[] {
  const out: Case[] = [];
  for (const c of cases) {
    if (Array.isArray(c.cases)) out.push(...flatten(c.cases));
    else if (c.property) out.push({ description: c.description, property: c.property, input: c.input || {}, expected: c.expected });
  }
  return out;
}

async function main() {
  const wanted = process.argv.slice(2);
  if (!wanted.length) throw new Error('用法:npx tsx eval/import-exercism.ts <exercise> [exercise...]');
  const data: Record<string, { source: string; version: string | null; cases: Case[] }> = fs.existsSync(OUT)
    ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  for (const id of wanted) {
    const url = `${BASE}/${id}/canonical-data.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${id}:HTTP ${res.status}`);
    const json: any = await res.json();
    const cases = flatten(json.cases || []);
    if (!cases.length) throw new Error(`${id}:沒有案例`);
    data[id] = { source: url, version: json.version || null, cases };
    console.log(`${id}:${cases.length} 個案例`);
  }
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n');
  console.log(`寫入 ${path.relative(process.cwd(), OUT)}`);
}

main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
