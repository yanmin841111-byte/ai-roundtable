'use strict';

// 環境問題的「照做就能修好」:同一個形狀(EnvFix)從偵測一路傳到畫面。
//
// 驗的是這條路真的通,而且不亂給:
//   - 回合失敗時,失敗訊息會帶上下一步(沒登入 → 登入指令、沒裝 → 安裝說明、缺 key → 設定)
//   - 轉接器自己知道原因時用它的答案,不知道才回頭問健康檢查
//   - 健康檢查說一切正常就不硬湊一顆按不動的按鈕
//   - 修復建議不寫進歷史紀錄:環境會變,而紀錄檔可能被手動改過

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const adapters = require('../src/adapters');
const { Registry } = require('../src/adapters/registry');
const { restoreMessage } = require('../src/flow/messages');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-envfix-'));

// 假轉接器:run 一定失敗,check 回報指定的健康狀態
function plugin(id: string, check: string, run = "async () => ({ error: 'boom' })") {
  fs.writeFileSync(path.join(tmp, `${id}.js`), `module.exports = { id: '${id}', label: '${id}', run: ${run}, check: ${check} };`);
}

async function withRegistry(fn: () => Promise<void>) {
  const previous = adapters.getRegistry();
  adapters.setRegistry(new Registry({ userDir: tmp }));
  try { await fn(); } finally { adapters.setRegistry(previous); }
}

test('回合失敗:沒登入時,錯誤訊息帶著可以直接執行的登入指令', async () => {
  plugin('needlogin', "async () => ({ ok: false, state: 'unauthenticated', hint: '請先登入', fix: { command: 'needlogin login' } })");
  await withRegistry(async () => {
    const r = await adapters.runTurn({ cli: 'needlogin' }, {});
    assert.strictEqual(r.error, 'boom');
    assert.deepStrictEqual(r.fix, { command: 'needlogin login' });
  });
});

test('轉接器自己知道原因時就用它的答案,不再問健康檢查', async () => {
  plugin('selfaware', "async () => { throw new Error('check 不該被呼叫'); }", "async () => ({ error: 'no key', fix: { settingsTab: 'clis' } })");
  await withRegistry(async () => {
    const r = await adapters.runTurn({ cli: 'selfaware' }, {});
    assert.deepStrictEqual(r.fix, { settingsTab: 'clis' });
  });
});

test('健康檢查說一切正常時不給修復按鈕(這次失敗是別的原因)', async () => {
  plugin('healthy', "async () => ({ ok: true, state: 'ready', version: '1.0' })");
  await withRegistry(async () => {
    const r = await adapters.runTurn({ cli: 'healthy' }, {});
    assert.strictEqual(r.error, 'boom');
    assert.strictEqual(r.fix, undefined);
  });
});

test('健康檢查本身壞掉不影響這次回合的錯誤訊息', async () => {
  plugin('brokencheck', "async () => { throw new Error('check 掛了'); }");
  await withRegistry(async () => {
    const r = await adapters.runTurn({ cli: 'brokencheck' }, {});
    assert.strictEqual(r.error, 'boom');
    assert.strictEqual(r.fix, undefined);
  });
});

test('成功的回合不帶修復建議,也不會去跑健康檢查', async () => {
  plugin('fine', "async () => { throw new Error('check 不該被呼叫'); }", "async () => ({ text: 'ok' })");
  await withRegistry(async () => {
    const r = await adapters.runTurn({ cli: 'fine' }, {});
    assert.strictEqual(r.error, null);
    assert.strictEqual(r.fix, undefined);
  });
});

test('找不到轉接器時,下一步是去設定裡看,而不是去終端打指令', async () => {
  await withRegistry(async () => {
    const r = await adapters.runTurn({ cli: 'ghost' }, {});
    assert.deepStrictEqual(r.fix, { settingsTab: 'clis' });
  });
});

test('健康檢查:沒安裝的內建 CLI 會補上官方安裝說明', async () => {
  await withRegistry(async () => {
    const health = await adapters.getRegistry().checkAll();
    for (const [id, status] of Object.entries<any>(health)) {
      if (status.state !== 'missing' || !['claude', 'codex', 'cursor'].includes(id)) continue;
      assert.ok(status.fix && /^https:\/\//.test(status.fix.url), `${id} 應該給安裝說明`);
    }
    // 內建的三個 CLI 一定都在清單裡(裝沒裝都會被檢查)
    for (const id of ['claude', 'codex', 'cursor']) assert.ok(health[id], `健康檢查應該包含 ${id}`);
  });
});

test('修復建議不進歷史紀錄:載回來的訊息不帶 fix', () => {
  const restored = restoreMessage({ kind: 'agent', text: '失敗', status: 'error', error: 'boom', fix: { command: 'rm -rf /' } });
  assert.strictEqual(restored.fix, undefined);
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed}/${tests.length} env fix tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
