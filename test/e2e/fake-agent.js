// 假成員:依提示詞中最後一個階段標籤(中文【…】或英文[…])回覆固定內容
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const tags = [...input.matchAll(/【([^】]+)】|^\[([A-Za-z -]+)\]/gm)].map((m) => m[1] || m[2]);
  const phase = tags[tags.length - 1] || '';
  const me = process.argv[2];
  const en = /^[A-Za-z]/.test(phase);
  const key = { 分工: 'divide', 'Divide the work': 'divide', 執行: 'execute', Execute: 'execute', 交叉審查: 'review', 'Cross-review': 'review', 修復: 'fix', Repair: 'fix', 總結: 'summary', Summary: 'summary' }[phase] || 'discuss';
  const out = {
    divide: en ? '{"summary":"one file each","assignments":[{"agent":"A1","task":"create a.txt"},{"agent":"A2","task":"create b.txt"}]}' : '{"summary":"兩人各寫一個檔案","assignments":[{"agent":"A1","task":"建立 a.txt"},{"agent":"A2","task":"建立 b.txt"}]}',
    execute: en ? `${me} finished the assigned work` : `${me} 已完成分配的工作`,
    review: me === '甲' ? (en ? 'One small issue needs fixing' : '有一個小問題需要修正') : (en ? 'Looks fine\n[NO_ISSUES]' : '看起來沒問題\n[NO_ISSUES]'),
    fix: en ? `${me} fixed the review comments` : `${me} 已修正審查意見`,
    summary: en ? `${me}'s summary: task complete` : `${me} 的總結:任務完成`,
    // 討論回合順便回報提示詞裡有沒有附件區塊、檔案路徑、內嵌文字,讓 e2e 能從回覆驗證
    discuss: en
      ? `${me} agrees with this direction attachments=${input.includes('[Attachments]')} path=${input.includes('Path:')} text=${input.includes('筆記內容 hello')}\n[AGREED]`
      : `${me} 同意這個方向 附件=${input.includes('【附件】')} 路徑=${input.includes('路徑:')} 文字=${input.includes('筆記內容 hello')}\n[AGREED]`,
  }[key];
  process.stdout.write(out + '\n');
});
