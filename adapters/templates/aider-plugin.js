'use strict';
// JS 外掛範例:包裝 Aider(https://aider.chat)。
// JSON 設定不夠用時(需要特殊解析、多步驟流程、呼叫別的服務…),可以照這個格式寫 .js 外掛。
// 外掛在 app 主程序中執行,擁有完整的 Node.js 權限,只安裝你信任的外掛。

module.exports = {
  id: 'aider',
  label: 'Aider',
  description: 'JS 外掛範例:包裝 Aider CLI。純文字輸出,不支援續接。',
  bin: 'aider',
  supportsResume: false, // true 時需回傳 sessionId,之後 ctx.sessionId 會帶回來
  supportsEdit: true,
  capabilities: { attachments: ['filePath'], attachmentsNeedCwd: false },
  efforts: [],
  models: [], // 也可以改寫成 listModels(kit) { return [...] }

  // agent:成員設定(model、effort、canEdit、name…)
  // ctx:prompt、systemPrompt、sessionId、cwd、timeoutMs,以及 onText / onThinking / onActivity / onSession / onProc 回呼
  // kit:runProcess、buildArgs、truncate、resolveEffort… 等工具,見 src/adapters/kit.ts
  async run(agent, ctx, kit) {
    const prompt = ctx.systemPrompt ? `${ctx.systemPrompt}\n\n---\n\n${ctx.prompt}` : ctx.prompt;
    const args = kit.buildArgs([
      '--message', '{prompt}',
      '--no-stream', '--no-pretty', '--no-auto-commits', '--no-check-update',
      ['--model', '{model}'],
      { if: 'canEdit', then: ['--yes-always'], else: ['--dry-run'] },
    ], { prompt, model: agent.model, canEdit: agent.canEdit });

    let text = '';
    const res = await kit.runProcess('aider', args, { cwd: ctx.cwd, timeoutMs: ctx.timeoutMs }, {
      onProc: ctx.onProc,
      onLine: (line) => { text += (text ? '\n' : '') + line; ctx.onText(text); },
    });

    let error = null;
    if (res.spawnError) error = `無法啟動 aider:${res.stderr}`;
    else if (res.timedOut) error = res.error;
    else if (res.code !== 0 && !text) error = `aider 結束代碼 ${res.code}\n${kit.truncate(res.stderr, 1500)}`;
    return { text, error };
  },
};
