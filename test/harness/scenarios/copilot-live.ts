'use strict';

// 情境:三個 Copilot 模型以多 AI 把關修一個小錯誤。會使用 Copilot 額度,需 COPILOT_LIVE=1。
// 模型可用性由組織政策決定;失敗時保留暫存目錄供查。

import { execFileSync } from 'child_process';
import path from 'path';
import { runApp, report } from '../app';

const MODELS = (process.env.COPILOT_MODELS || 'gpt-5-mini,claude-haiku-4.5,gpt-5.4-mini').split(',').map((model) => model.trim()).filter(Boolean);

const FILES = {
  'sum.js': 'function sum(values) {\n  let total = 0;\n  for (let i = 1; i < values.length; i++) total += values[i];\n  return total;\n}\nmodule.exports = { sum };\n',
  'sum.test.js': "const assert = require('assert');\nconst { sum } = require('./sum');\nassert.strictEqual(sum([1, 2, 3]), 6);\nassert.strictEqual(sum([]), 0);\nconsole.log('sum ok');\n",
};

async function main() {
  if (process.env.COPILOT_LIVE !== '1') {
    console.log('略過:設定 COPILOT_LIVE=1 才會使用 Copilot 額度');
    return;
  }
  if (MODELS.length < 3) throw new Error('COPILOT_MODELS needs at least three models');
  const [lead, author, reviewer] = MODELS;
  const started = Date.now();
  const result = await runApp({
    members: [
      { id: 'lead', name: `Copilot ${lead}`, cli: 'copilot', model: lead, canEdit: false },
      { id: 'author', name: `Copilot ${author}`, cli: 'copilot', model: author, canEdit: true },
      { id: 'reviewer', name: `Copilot ${reviewer}`, cli: 'copilot', model: reviewer, canEdit: false },
    ],
    files: FILES,
    git: true,
    settings: { leadAgentId: 'lead', mode: 'guarded', workStyle: 'code', discussionMode: 'independent-first', maxRounds: 2, verifyCommand: 'node sum.test.js', uiLocale: 'zh-Hant' },
    timeoutMs: 30 * 60 * 1000,
    scenario: async () => {
      const app: any = globalThis;
      await app.ready();
      const messages = await app.send('sum.js 少加了第一個元素,請修正讓 node sum.test.js 通過。只改 sum.js,不要修改測試。', 'guarded');
      const turns = messages.filter((message: any) => message.kind === 'agent');
      const summary = messages.find((message: any) => message.taskSummary)?.taskSummary;
      app.check(turns.length > 0, `模型有回覆(${turns.length} 則)`);
      app.check(!!summary, '產生結果卡');
      await app.shot('copilot-live');
      return {
        errors: turns.filter((message: any) => message.error).map((message: any) => `${message.agentName}: ${String(message.error).slice(0, 200)}`),
        phases: turns.map((message: any) => `${message.agentName}:${message.phase?.code || '-'}`),
        guard: summary?.guard,
        verify: summary?.verify,
        members: summary?.members?.map((member: any) => ({ name: member.name, status: member.status })),
      };
    },
  });
  const ok = report(`Copilot 真機 · ${MODELS.join(' / ')}`, result);
  let testPassed = false;
  try {
    execFileSync(process.execPath, ['sum.test.js'], { cwd: result.workDir, stdio: 'pipe' });
    testPassed = true;
  } catch { /* 下方回報 */ }
  const testFile = result.read('sum.test.js');
  console.log('  耗時:', `${Math.round((Date.now() - started) / 1000)}s`);
  console.log('  獨立執行 node sum.test.js:', testPassed ? '通過' : '失敗');
  console.log('  測試檔未被修改:', testFile === FILES['sum.test.js'] ? '是' : '否');
  console.log('  git numstat:', result.numstat() || '(無變更)');
  console.log('  結果:', JSON.stringify(result.value, null, 2));
  console.log('  暫存目錄:', path.relative(process.cwd(), result.tmp) || result.tmp);
  if (!ok || !testPassed || testFile !== FILES['sum.test.js']) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
