// 端對端測試:用建置好的 dist/ 啟動真正的 Electron app,在介面裡跑 scenario.js,
// 結束後再檢查工作目錄與附件目錄沒有殘留。成員是假的自訂指令(fake-agent.js),不碰任何真正的 CLI。
// 執行:npm run e2e(會先 build);CI 在 build 之後直接跑這個檔案。
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = path.resolve(__dirname, '..', '..');
const TIMEOUT_MS = 120_000;

// 在 Node 裡 require('electron') 回傳的是執行檔路徑
const electronBin = require('electron') as unknown as string;

interface E2EResult { ok?: boolean; steps?: string[]; error?: string }

function fail(message: string): never {
  console.error(`e2e 失敗:${message}`);
  process.exit(1);
}

function prepare() {
  if (!fs.existsSync(path.join(root, 'dist', 'main.js'))) fail('找不到 dist/main.js,請先執行 npm run build');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-roundtable-e2e-'));
  const userData = path.join(tmp, 'user-data');
  const workDir = path.join(tmp, 'work');
  fs.mkdirSync(userData);
  fs.mkdirSync(workDir);
  const fakeAgent = path.join(root, 'test', 'e2e', 'fake-agent.js');
  const member = (id: string, name: string, color: string) => ({
    id, name, cli: 'custom', model: '', effort: '', persona: '測試', color, canEdit: true, enabled: true,
    customCommand: `node "${fakeAgent}" ${name}`,
  });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    agents: [member('a1', '甲', '#d97757'), member('a2', '乙', '#10a37f')],
    settings: { workDir, maxRounds: 2, mode: 'divide', leadAgentId: 'a1', language: '繁體中文', maxTranscriptChars: 60000, uiLocale: 'zh-Hant', theme: 'light' },
  }, null, 2));
  const noteFile = path.join(tmp, 'note.txt');
  const pngFile = path.join(tmp, 'dot.png');
  fs.writeFileSync(noteFile, '筆記內容 hello\n');
  // 1×1 的 PNG
  fs.writeFileSync(pngFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'));
  const scenario = fs.readFileSync(path.join(root, 'test', 'e2e', 'scenario.js'), 'utf8');
  const script = path.join(tmp, 'scenario.js');
  fs.writeFileSync(script, `const E2E = ${JSON.stringify({ workDir, noteFile, pngFile })};\n${scenario}`);
  return { tmp, userData, workDir, script };
}

function runElectron(userData: string, script: string): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, AI_ROUNDTABLE_E2E_SCRIPT: script, AI_ROUNDTABLE_DEBUG: '1' };
    delete env.ELECTRON_RUN_AS_NODE; // 有這個變數時 electron 會以純 node 模式啟動,開不了視窗
    const child = spawn(electronBin, [root, `--user-data-dir=${userData}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // 不設 encoding 的話多位元組字會被切在 chunk 邊界,結果那行會壞掉
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

(async () => {
  const { tmp, userData, workDir, script } = prepare();
  const { code, stdout, stderr, timedOut } = await runElectron(userData, script);
  const line = stdout.split('\n').find((l) => l.startsWith('E2E_RESULT '));
  let result: E2EResult | null = null;
  try { result = line ? JSON.parse(line.slice('E2E_RESULT '.length)) : null; } catch {}

  for (const step of (result && result.steps) || []) console.log('ok -', step);
  const rendererLog = stdout.split('\n').filter((l) => l.startsWith('[renderer:')).join('\n');

  if (timedOut) fail(`Electron ${TIMEOUT_MS / 1000} 秒內沒有結束\n${stderr}`);
  if (!result) fail(`沒有收到劇本結果(結束代碼 ${code})\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
  if (!result.ok) fail(`${result.error || '未知錯誤'}\n--- renderer ---\n${rendererLog}`);
  // 劇本回報成功之後才崩潰的話,結束代碼是唯一看得出來的地方
  if (code !== 0) fail(`Electron 異常退出(結束代碼 ${code})\n--- renderer ---\n${rendererLog}\n--- stderr ---\n${stderr}`);

  // app 結束後才檢查得到:工作目錄不能留下附件暫存,刪掉紀錄後附件目錄也要清空
  const runtimeDir = path.join(workDir, '.roundtable-runtime');
  if (fs.existsSync(runtimeDir)) fail(`工作目錄殘留 ${runtimeDir}`);
  const attachmentsDir = path.join(userData, 'attachments');
  const leftover = fs.existsSync(attachmentsDir) ? fs.readdirSync(attachmentsDir) : [];
  if (leftover.length) fail(`刪除紀錄後附件目錄仍有 ${leftover.join(', ')}`);
  console.log('ok - 工作目錄與附件目錄沒有殘留');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${(result.steps || []).length + 1} 項端對端檢查全部通過`);
})().catch((error) => fail(error instanceof Error ? error.stack || error.message : String(error)));
