'use strict';

// 情境:真的本機模型,透過 app 從頭到尾改一個檔案。
//
// 這是檔案工具唯一真正有意義的驗證——單元測試只證明 FileToolSession 本身對,
// 證明不了「模型會不會用它」「稽核有沒有進 transcript」「使用者看不看得到」。
//
// 設計:假成員當主持人(產出確定的分工 JSON,並當 reviewer 撐開閘門),
// 真模型只負責執行。這樣失敗時分得出是流程問題還是模型問題。
//
// 需要 ollama serve 正在跑,而且已經 pull 過對應模型。

import assert from 'assert';
import { runApp, report } from '../app';
import { ollamaMember, scriptedMember, ONE_LINE_EDIT } from '../fixtures';

async function main() {
  const r = await runApp({
    members: [
      scriptedMember({
        id: 'lead', name: '主持人',
        plan: { summary: '由 Qwen 修正錯誤訊息', assignments: [{ agent: 'A2', task: ONE_LINE_EDIT.task }] },
        review: '改動看起來正確\n[NO_ISSUES]',
      }),
      ollamaMember({ id: 'qwen', name: 'Qwen' }),
    ],
    adapters: ['installed:ollama-api'],
    files: { [ONE_LINE_EDIT.file]: ONE_LINE_EDIT.before },
    git: true,
    constants: { target: ONE_LINE_EDIT.file, expect: ONE_LINE_EDIT.newText },
    scenario: async (H: any) => {
      const g: any = globalThis;
      await g.ready();
      await g.shot('01-before');

      const msgs = await g.send('請修正錯誤訊息', 'divide');
      const agents = msgs.filter((m: any) => m.kind === 'agent');
      const exec = agents.find((m: any) => m.agentName === 'Qwen' && m.phase && m.phase.code === 'execute');
      g.check(!!exec, `Qwen 進入執行階段(${agents.map((m: any) => (m.phase || {}).code).join(',')})`);
      g.check(!exec.error, `Qwen 執行沒有錯誤(${exec.error || '無'})`);

      const entries = g.toolAudits(msgs);
      g.check(entries.length > 0, `transcript 裡有工具稽核紀錄(${entries.length} 筆)`);
      const wrote = entries.find((e: any) => e.path && e.path.includes(H.target) && e.ok !== false);
      g.check(!!wrote, `有一筆針對 ${H.target} 的成功寫入`);
      g.check(typeof wrote.added === 'number' && typeof wrote.removed === 'number', `稽核含增刪行數(+${wrote.added}/-${wrote.removed})`);
      g.check(!!wrote.shaAfter, '稽核含 shaAfter,reviewer 可追查');
      g.check(!agents.some((m: any) => m.unreviewed), '有 reviewer 回覆,不該出現「尚未審查」');

      // 畫面上真的看得到嗎——稽核不能只存在於資料裡
      const timeline = (document.querySelector('#timeline') || { textContent: '' }).textContent || '';
      g.check(timeline.includes('replace_text') || timeline.includes('write_file'), '時間軸上看得到檔案操作面板');
      await g.shot('02-after');

      return { audit: { tool: wrote.tool, path: wrote.path, added: wrote.added, removed: wrote.removed } };
    },
  });

  const ok = report('檔案工具真機端到端', r);

  // 不經過 app 的獨立驗證:磁碟與 git 各說一次
  const after = r.read(ONE_LINE_EDIT.file) || '';
  const correct = after.includes(ONE_LINE_EDIT.newText) && !after.includes(ONE_LINE_EDIT.oldText);
  console.log('  磁碟內容正確:', correct ? '是' : '否');
  console.log('  git numstat:', r.numstat() || '(無變更)');
  if (r.value && r.value.audit) {
    const a = r.value.audit;
    const [add, del] = (r.numstat().split('\t')[0] || '') === '' ? ['?', '?'] : r.numstat().split('\t');
    console.log(`  稽核 +${a.added}/-${a.removed} vs git ${add}/${del}:`, String(a.added) === add && String(a.removed) === del ? '一致' : '不一致');
  }

  assert.ok(ok, r.error || '情境失敗');
  assert.ok(correct, '磁碟內容沒有被改成期望值');
  r.cleanup();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
