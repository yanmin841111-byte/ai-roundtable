'use strict';

// 可腳本化的假成員:依提示詞裡最後一個階段標籤回固定內容。
// 設定以 base64 JSON 從 argv[2] 進來(引號與換行在 shell 裡太容易被吃掉)。
//
// 它的用途是把「流程」與「模型能力」分開:讓它當主持人產出確定的分工 JSON、
// 當 reviewer 撐開閘門,真正要驗的那位成員才是變數。

// writes:執行階段要寫進工作目錄的檔案 { 相對路徑: 內容 };report:執行階段的回報文字。
// 用來製造「成果有問題、報告卻說沒問題」的情境,測審查者看的是檔案還是報告。
let config = { plan: null, discuss: '同意直接進入分工\n[AGREED]', review: '看過了,沒問題\n[NO_ISSUES]', writes: null, report: null };
try {
  if (process.argv[2]) config = { ...config, ...JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8')) };
} catch {}

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const tags = [...input.matchAll(/【([^】]+)】|^\[([A-Za-z -]+)\]/gm)].map((m) => m[1] || m[2]);
  const phase = tags[tags.length - 1] || '';
  const key = {
    分工: 'divide', 'Divide the work': 'divide',
    執行: 'execute', Execute: 'execute',
    交叉審查: 'review', 'Cross-review': 'review',
    修復: 'fix', Repair: 'fix',
    總結: 'summary', Summary: 'summary',
  }[phase] || 'discuss';

  if (key === 'execute' && config.writes) {
    const fs = require('fs');
    const path = require('path');
    for (const [rel, content] of Object.entries(config.writes)) {
      const full = path.join(process.cwd(), rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
  const out = {
    divide: config.plan ? JSON.stringify(config.plan) : '{"summary":"沒有指定分工","assignments":[]}',
    execute: config.report || '這回合沒有被指派工作',
    review: config.review,
    fix: '沒有需要修復的項目',
    summary: '總結:流程已跑完',
    discuss: config.discuss,
  }[key];
  process.stdout.write(out + '\n');
});
