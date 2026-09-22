'use strict';

// 情境:反例在「真的 app 裡」跑不跑得起來,判定方向對不對(見 src/counterexample.ts)。
//
// 這個情境存在的理由和 verify.ts 是同一個,而且是同一個坑:反例用 process.execPath 開子行程,
// 在 app 裡那是 Electron 不是 node。少了 ELECTRON_RUN_AS_NODE,腳本不會被當成 node 腳本執行,
// 而在這裡「非零結束碼」的意思是**問題確認了**——所以那個 bug 的後果是每一條反例都被誣賴成真的,
// 然後派人去修一個不存在的問題。單元測試在純 node 底下跑,永遠抓不到這件事。
// 實驗 5 的第一次 48 跑就是被這一類誤判作廢的(見 eval/EXPERIMENTS.md)。
//
// 一併驗:確認過的反例有沒有真的存進專案的語料庫(src/corpus.ts)。

import fs from 'fs';
import path from 'path';
import { runApp, report } from '../app';
import { scriptedMember } from '../fixtures';

// 審查者的回覆:一段文字意見,加上兩個反例——一個真的會失敗、一個不會。
// 兩個都放是刻意的:只放會失敗的那個,測不出「判定方向有沒有反」。
const REVIEW = [
  'sum 的加法寫反了,兩個正數會得到負的結果。',
  '',
  '```counterexample 1 + 1 應該是 2',
  "const assert = require('assert');",
  "assert.strictEqual(require('./sum.js')(1, 1), 2);",
  '```',
  '',
  '```counterexample 0 + 0 應該是 0',
  "const assert = require('assert');",
  "assert.strictEqual(require('./sum.js')(0, 0), 0);",
  '```',
].join('\n');

async function main() {
  const r = await runApp({
    members: [
      // 審查者由 pickReviewPairs 從其他啟用成員裡挑,這裡兩位都給同一份回覆,
      // 情境才不會依賴「挑中的是哪一位」這個實作細節
      scriptedMember({
        id: 'lead', name: '主持人', review: REVIEW, recheck: '這次對了\n[NO_ISSUES]',
        plan: { summary: '寫一個加法', assignments: [{ agent: '執行者', task: '建立 sum.js,匯出 (a, b) => a + b' }] },
      }),
      scriptedMember({
        id: 'exec', name: '執行者', canEdit: true,
        // 減號:1 + 1 會得到 0,所以第一個反例失敗、第二個(0 + 0)照樣通過
        writes: { 'sum.js': 'module.exports = (a, b) => a - b;\n' },
        report: '已建立 sum.js',
        // 修復回合把它改對:反例應該從失敗變成通過,而且由 app 自己跑出來確認
        fixWrites: { 'sum.js': 'module.exports = (a, b) => a + b;\n' },
        fixReport: '已把減號改成加號',
      }),
      scriptedMember({ id: 'rev', name: '審查者', review: REVIEW, recheck: '這次對了\n[NO_ISSUES]' }),
    ],
    settings: { workStyle: 'code' },
    timeoutMs: 3 * 60 * 1000,
    scenario: async () => {
      const g: any = globalThis;
      await g.ready();
      const msgs = await g.send('請寫一個加法', 'divide');
      const ce = msgs.filter((m: any) => m.kind === 'system' && m.tag === 'counterexample');
      g.check(ce.length > 0, '有反例的系統訊息');
      const text = ce.map((m: any) => m.text).join('\n');

      // 判定方向:會失敗的那個才算確認,不會失敗的那個要被標成「不成立」。
      // 這兩條一起過,才證明反例真的被當成 node 腳本跑了。
      g.check(/1 \+ 1 應該是 2/.test(text), `會失敗的反例要被指名(${text.slice(0, 300)})`);
      const confirmed = ce.find((m: any) => /真的重現了問題/.test(m.text));
      g.check(!!confirmed && /1 \+ 1 應該是 2/.test(confirmed.text), '1+1 那個要列在「確認」裡');
      g.check(!!confirmed && !/0 \+ 0 應該是 0/.test(confirmed.text), '0+0 那個不可以被算成確認');
      const unsub = ce.find((m: any) => /舉不出可重現的例子/.test(m.text));
      g.check(!!unsub && /0 \+ 0 應該是 0/.test(unsub.text), '0+0 那個要被標成不成立');
      g.check(!/跑不起來|無法啟動/.test(text), `反例不可以是「跑不成」——那代表 node 沒被正確叫起來(${text.slice(0, 300)})`);

      // 修復之後 app 自己重跑,確認它從失敗變成通過
      const improved = msgs.find((m: any) => m.kind === 'system' && /從不通過變成通過/.test(m.text || ''));
      g.check(!!improved && /1 \+ 1 應該是 2/.test(improved.text), `修好之後要量到改善(${improved?.text?.slice(0, 200)})`);

      const card = msgs.find((m: any) => m.tag === 'task-summary');
      g.check(!!card, '有結果卡');
      g.check(!card.taskSummary.rollback, `沒有退步就不該回退(${JSON.stringify(card.taskSummary.rollback)})`);
      g.check(!msgs.some((m: any) => m.kind === 'system' && /有關卡從通過變成不通過/.test(m.text || '')), '不可以報告不存在的退步');
      // 語料庫與反例腳本都不可以被算成成員的改動
      const files = (card.taskSummary.files || []).map((f: any) => f.path);
      g.check(!files.some((f: string) => f.startsWith('.roundtable')), `檔案改動不該有 app 自己的檔案(${files.join(', ')})`);
      return { text: text.slice(0, 400), files };
    },
  });
  report('反例與語料庫', r);

  // 磁碟上的事實:修好了,而且確認過的反例留進了專案的語料庫
  const sum = r.read('sum.js');
  console.log(/a \+ b/.test(sum || '') ? '  ok - 磁碟上的 sum.js 已修好' : `  失敗:sum.js 仍是 ${JSON.stringify(sum)}`);
  const corpusFile = path.join(r.workDir, '.roundtable', 'counterexamples.json');
  const corpus = fs.existsSync(corpusFile) ? JSON.parse(fs.readFileSync(corpusFile, 'utf8')) : [];
  const titles = corpus.map((e: any) => e.title);
  console.log(titles.includes('1 + 1 應該是 2') ? '  ok - 確認過的反例已存進語料庫' : `  失敗:語料庫裡是 ${JSON.stringify(titles)}`);
  console.log(!titles.includes('0 + 0 應該是 0') ? '  ok - 不成立的反例沒有被收進語料庫' : '  失敗:不成立的反例被收進語料庫了');
  // 反例腳本是一次性的,不可以留在工作目錄裡被當成成員的改動
  const leftovers = fs.readdirSync(r.workDir).filter((f: string) => f.startsWith('.roundtable-ce-'));
  console.log(leftovers.length === 0 ? '  ok - 反例腳本沒有留在工作目錄' : `  失敗:留下 ${leftovers.join(', ')}`);
}

main();
