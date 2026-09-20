'use strict';

// 終端分頁。驗的是「這真的是一個 pty」——只看得到 stdout 有字是不夠的:
//   - tty 存在、顏色與 SIGWINCH 會到前景程式,vim / top / claude 才跑得起來
//   - 改視窗大小之後,shell 看到的 cols/lines 也真的變了
//   - 關掉分頁時 shell 行程一起死掉,不留孤兒(app 關了還在跑才是真的麻煩)
// 這些都要真的開一個 shell 才看得到,所以這份測試不用假物件。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { TerminalManager, MAX_SESSIONS, resolveCwd } = require('../src/terminal');

const tests: Array<{ name: string; fn: () => unknown }> = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });

// 測試要可預期:固定用 zsh,而且給它一個只有空 .zshrc 的 ZDOTDIR。
// 乾淨的機器(CI runner)沒有 ~/.zshrc 時,互動式 zsh 會跳出新使用者設定精靈並等輸入,
// 測試就會等一個永遠不會來的輸出。產品本身照樣用使用者自己的 shell 與設定檔。
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-term-home-'));
fs.writeFileSync(path.join(HOME_DIR, '.zshrc'), '');
process.env.ZDOTDIR = HOME_DIR;
const SHELL = '/bin/zsh';

// 開過的分頁一定要收掉:pty 的子行程會把 event loop 撐著,某一條斷言掛掉卻沒收乾淨時,
// 整個 npm test 會停在這裡等到天荒地老(CI 上實際發生過,而且因為輸出還沒 flush,
// 連失敗原因都看不到)。所以:集中記錄、結束時一律關掉,再加一個逾時保險。
const managers: any[] = [];
function newManager() { const m = new TerminalManager(); managers.push(m); return m; }
function closeEverything() { for (const m of managers) { try { m.closeAll(); } catch {} } }
const watchdog = setTimeout(() => {
  console.error('terminal tests 逾時(120 秒),強制結束');
  closeEverything();
  process.exit(1);
}, 120000);
watchdog.unref();

// 送進 shell 的字會被回顯,所以標記不能直接出現在指令裡:
// 用 shell 自己算出來的字串當標記,看到它就代表指令真的執行過。
function session(manager: any, options: Record<string, unknown> = {}) {
  const created = manager.create({ cols: 100, rows: 30, shell: SHELL, ...options });
  assert.ok(created.ok, `開不起來:${created.code}`);
  let output = '';
  manager.on('data', (event: { id: string; data: Buffer }) => {
    if (event.id === created.session.id) output += event.data.toString('utf8');
  });
  const seen = () => output;
  const waitFor = (needle: string | RegExp, timeoutMs = 20000) => new Promise<string>((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const hit = typeof needle === 'string' ? (output.includes(needle) ? needle : null) : (output.match(needle) || [null])[0];
      if (hit) return resolve(String(hit));
      if (Date.now() - started > timeoutMs) return reject(new Error(`等不到 ${needle};目前輸出:\n${output.slice(-600)}`));
      setTimeout(tick, 40);
    };
    tick();
  });
  const exited = new Promise<{ code: number }>((resolve) => {
    manager.on('exit', (event: { id: string; code: number }) => { if (event.id === created.session.id) resolve(event); });
  });
  return { id: created.session.id, info: created.session, seen, waitFor, exited };
}

test('分頁跑在真的 pty 上:指令會執行,tty 存在', async () => {
  const manager = newManager();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-term-'));
  const s = session(manager, { cwd: dir });
  manager.write(s.id, 'echo RT_$((6*7))_$(tty)\n');
  const line = await s.waitFor(/RT_42_\/dev\/tty\S+/);
  assert.ok(line.includes('/dev/tty'), `應該拿到 pty:${line}`);
  assert.strictEqual(s.info.cwd, dir);
  manager.write(s.id, 'echo RT_DIR_$(pwd)\n');
  await s.waitFor(`RT_DIR_${fs.realpathSync(dir)}`);
  manager.closeAll();
  await s.exited;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('改大小:shell 看到新的 cols/lines,前景程式收得到 SIGWINCH', async () => {
  const manager = newManager();
  const s = session(manager, { cols: 100, rows: 30 });
  manager.write(s.id, 'echo RT_SIZE_$(tput cols)x$(tput lines)\n');
  await s.waitFor('RT_SIZE_100x30');
  // 前景程式真的被通知:zsh 的 WINCH trap 會在 pty 大小變動時觸發
  manager.write(s.id, "trap 'echo RT_GOT_WINCH' WINCH; echo RT_TRAP_SET\n");
  await s.waitFor('RT_TRAP_SET'); // 等 trap 真的設好再改大小,不用固定秒數猜
  manager.resize(s.id, 133, 44);
  await s.waitFor('RT_GOT_WINCH');
  manager.write(s.id, 'echo RT_SIZE_$(tput cols)x$(tput lines)\n');
  await s.waitFor('RT_SIZE_133x44');
  manager.closeAll();
  await s.exited;
});

test('關分頁:shell 行程一起結束,不留孤兒', async () => {
  const manager = newManager();
  const s = session(manager);
  manager.write(s.id, 'echo RT_PID_$$\n');
  const pid = Number((await s.waitFor(/RT_PID_\d+/)).replace('RT_PID_', ''));
  assert.ok(pid > 0);
  process.kill(pid, 0); // 還活著
  manager.close(s.id);
  const exit = await s.exited;
  assert.strictEqual(typeof exit.code, 'number');
  // 行程表要等一下才會反映
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.throws(() => process.kill(pid, 0), /ESRCH/, `shell ${pid} 還在跑`);
  assert.strictEqual(manager.size, 0);
  manager.closeAll();
});

test('自己結束的 shell 會回報 exit,分頁從清單消失', async () => {
  const manager = newManager();
  const s = session(manager);
  manager.write(s.id, 'exit 3\n');
  const exit = await s.exited;
  assert.strictEqual(exit.code, 3);
  assert.strictEqual(manager.has(s.id), false);
  assert.deepStrictEqual(manager.list(), []);
  manager.closeAll();
});

test('上限:超過 MAX_SESSIONS 就拒絕,不會愈開愈多', async () => {
  const manager = newManager();
  const ids: string[] = [];
  for (let i = 0; i < MAX_SESSIONS; i++) {
    const created = manager.create({});
    assert.ok(created.ok, `第 ${i + 1} 個應該開得起來`);
    ids.push(created.session.id);
  }
  const extra = manager.create({});
  assert.deepStrictEqual(extra, { ok: false, code: 'tooMany' });
  assert.strictEqual(manager.size, MAX_SESSIONS);
  manager.closeAll();
  // 全關之後名額要放出來
  for (let i = 0; i < 200 && manager.size > 0; i++) await new Promise((r) => setTimeout(r, 25));
  assert.strictEqual(manager.size, 0);
});

// app 不是每次都能好好說再見:當掉、被 kill -9、被工作管理員關掉都不會走到清理程式碼。
// 那種時候終端裡的 shell 還活著,而且沒有任何介面看得到它——實測在開發機上累積過 23 個。
test('app 被強制結束時,終端裡的 shell 跟著結束,不留孤兒', async () => {
  const script = path.join(HOME_DIR, 'fake-app.ts');
  fs.writeFileSync(script, `
    const { TerminalManager } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'terminal'))});
    const m = new TerminalManager();
    const r = m.create({ cols: 80, rows: 24, shell: ${JSON.stringify(SHELL)} });
    if (!r.ok) { console.log('CREATE_FAILED'); process.exit(1); }
    let out = '';
    m.on('data', (e) => {
      out += e.data.toString();
      const hit = out.match(/RT_SHELL_(\\d+)/);
      if (hit) { console.log('SHELL_PID ' + hit[1]); out = ''; }
    });
    setTimeout(() => m.write(r.session.id, 'echo RT_SHELL_$$\\n'), 400);
    setTimeout(() => {}, 60000); // 活著等被砍
  `);
  const child = spawn(process.execPath, ['--import', 'tsx', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const shellPid: number = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`假 app 沒有回報 shell 的 pid:\n${buf.slice(-400)}`)), 30000);
      const onData = (chunk: Buffer) => {
        buf += chunk.toString();
        const hit = buf.match(/SHELL_PID (\d+)/);
        if (hit) { clearTimeout(timer); resolve(Number(hit[1])); }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
    });
    process.kill(shellPid, 0); // 先確認真的在跑
    process.kill(child.pid, 'SIGKILL'); // 模擬當掉:主程序完全沒機會清理
    for (let i = 0; i < 60; i++) {
      try { process.kill(shellPid, 0); } catch { break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.throws(() => process.kill(shellPid, 0), /ESRCH/, `app 被 kill -9 之後,shell ${shellPid} 應該跟著結束`);
  } finally {
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
  }
});

test('工作目錄:不存在就建,建不起來才退回家目錄', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-term-cwd-'));
  const fresh = path.join(base, 'nested', 'work');
  assert.strictEqual(resolveCwd(fresh), fresh);
  assert.ok(fs.statSync(fresh).isDirectory());
  // 路徑上是一個檔案,建不成目錄
  const blocked = path.join(base, 'file.txt');
  fs.writeFileSync(blocked, 'x');
  assert.strictEqual(resolveCwd(path.join(blocked, 'sub')), os.homedir());
  assert.strictEqual(resolveCwd(''), os.homedir());
  assert.strictEqual(resolveCwd(undefined), os.homedir());
  fs.rmSync(base, { recursive: true, force: true });
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) { await fn(); passed++; console.log('ok -', name); }
  console.log(`\n${passed}/${tests.length} terminal tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  closeEverything();
  clearTimeout(watchdog);
  fs.rmSync(HOME_DIR, { recursive: true, force: true });
  // 還沒收完的 pty 不該決定這份測試能不能結束;輸出 flush 之後就走
  setTimeout(() => process.exit(process.exitCode || 0), 800).unref();
});
