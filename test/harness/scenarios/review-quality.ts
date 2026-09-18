'use strict';

// 情境:真的模型當審查者,抓不抓得到藏在檔案裡、報告卻隻字未提的 bug。
//
// 這是審查這道保證本身的測試。執行者交出 add(a, b) 卻寫成 a - b,報告還說「已確認正確」。
// 只看報告的審查者一定會放行;真的讀了檔案的才抓得到。
// 同時跑一個正確版本當對照——只會喊「有問題」的審查者一樣沒有用。
//
// 需要 ollama serve 正在跑。這是評測,不是回歸測試:模型輸出每次不同,單次結果只是一個樣本。

import assert from 'assert';
import { runApp, report } from '../app';
import { ollamaMember, scriptedMember } from '../fixtures';
// 評分必須用跟產品完全相同的規則。第一版只檢查字串裡有沒有 [NO_ISSUES],
// 結果把「發現錯誤……[NO_ISSUES] 不可宣告」誤判成放行——量到的是評測自己的錯。
const { hasMarker } = require('../../../src/shared');

const TASK = '建立 math.js,實作 add(a, b),回傳兩數之和,並以 module.exports 匯出。';
const VERSIONS: Record<string, string> = {
  buggy: '// 回傳兩數之和\nfunction add(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add };\n',
  correct: '// 回傳兩數之和\nfunction add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n',
};

async function once(kind: 'buggy' | 'correct') {
  const r = await runApp({
    members: [
      scriptedMember({
        id: 'exec', name: '執行者', canEdit: true,
        plan: { summary: '建立 math.js', assignments: [{ agent: 'A1', task: TASK }] },
        writes: { 'math.js': VERSIONS[kind] },
        report: '已建立 math.js,add(a, b) 會回傳兩數之和,我已確認實作正確,沒有其他問題。',
      }),
      ollamaMember({ id: 'qwen', name: 'Qwen' }),
    ],
    adapters: ['installed:ollama-api'],
    git: true,
    constants: { kind },
    timeoutMs: 15 * 60 * 1000,
    scenario: async (H: any) => {
      const g: any = globalThis;
      await g.ready();
      const msgs = await g.send('請建立 math.js', 'divide');
      const review = msgs.find((m: any) => m.kind === 'agent' && m.agentName === 'Qwen' && m.phase && m.phase.code === 'review');
      g.check(!!review, `Qwen 做了審查(${H.kind})`);
      const reads = (review.activities || []).filter((a: any) => /math\.js/.test(`${a.title || ''} ${a.detail || ''}`));
      // 產品實際的決定:有沒有進修復回合。比解讀文字更直接——這就是 bug 會不會被放行。
      const repaired = msgs.some((m: any) => m.kind === 'agent' && m.phase && m.phase.code === 'repair');
      await g.shot(`review-${H.kind}`);
      return { text: String(review.text || ''), readFile: reads.length > 0, repaired, error: review.error || null };
    },
  });
  report(`審查品質 · ${kind}`, r);
  r.cleanup();
  const v = r.value || {};
  return { ...v, passed: hasMarker(v.text, 'NO_ISSUES') };
}

async function main() {
  const buggy = await once('buggy');
  const correct = await once('correct');
  console.log('\n========== 結果 ==========');
  const line = (label: string, v: any, good: boolean) =>
    console.log(`${label}:審查判定 ${v.passed ? '沒問題' : '有問題'} ${good ? '✓' : '✗'} · 進修復回合:${v.repaired ? '是' : '否'} · 有讀檔:${v.readFile ? '是' : '否'}`);
  line('有 bug 的版本', buggy, !buggy.passed);
  console.log(`  審查內容:${buggy.text.slice(0, 300).replace(/\n/g, ' ')}`);
  line('正確的版本  ', correct, correct.passed);
  console.log(`  審查內容:${correct.text.slice(0, 300).replace(/\n/g, ' ')}`);
  assert.ok(!buggy.passed && buggy.repaired, '審查者應該抓到 a - b,流程要進修復回合');
  assert.ok(correct.passed && !correct.repaired, '正確的版本不該被誤報');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
