// 自動驗證:不靠模型判斷,直接執行。
//
// 為什麼需要:評測(eval/EXPERIMENTS.md 實驗 3)量到,審查者讀完檔案照樣把「有語法錯誤、
// 根本載不起來」的成果判成通過。讀程式碼看不出執行時才會出現的錯,再多一個模型讀也一樣。
// 這裡做兩件事:
//   1. 語法檢查:改動的 .js / .mjs / .cjs 用 node --check,.json 用 JSON.parse。不需要任何設定。
//   2. 驗證指令:使用者為工作目錄設定的指令,一行一道(例如先 lint、再 type check、再 npm test),
//      執行後與修復後各跑一次。依序執行,第一道沒過就停——後面那些多半是同一個錯的回音,
//      而且模型一次修一件事比較有機會修對。
// 結果會交給審查者與修復回合,也寫進結果卡——「審查通過」不能只是模型說通過。
import fs from 'fs';
import path from 'path';
import { runProcess, truncate } from './adapters/process';
import { tx } from './text';
import type { TextLocale } from './text';

export const SYNTAX_MAX_FILES = 40;
const SYNTAX_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const OUTPUT_MAX = 4000;
const SYNTAX_EXTS = new Set(['.js', '.mjs', '.cjs', '.json']);

// 一道門檻:使用者設定的一行指令
export interface GateResult {
  command: string;
  ok: boolean;
  code: number | null;
  output: string;
  timedOut: boolean;
  // 指令根本不存在(shell 回 127,或連 shell 都起不來)
  notFound?: boolean;
}

export interface VerifyResult {
  // 載不起來的檔案(路徑相對工作目錄)
  syntax: Array<{ file: string; error: string }>;
  // 依序跑過的門檻:一道沒過就停,所以最後一筆才是失敗的那道
  gates?: GateResult[];
  // 第一道沒過的指令;全過或沒有設定就沒有這一段。
  // notFound:指令根本不存在。這和「指令跑了但沒過」是兩回事——要改的是設定,不是程式碼,
  // 介面據此給「打開設定」。
  command?: GateResult;
  // 檢查過幾個檔案(語法檢查)
  checked: number;
  // 有沒有真的做了任何檢查:沒有可檢查的檔案、也沒有設定指令時是 false
  ran: boolean;
  ok: boolean;
}

// 語法檢查只看「這次改動的檔案」:整個工作目錄可能有幾萬個檔案,而且別人的舊問題不是這次造成的
export async function verifyChanges(
  cwd: string,
  changed: string[] | null,
  command: string,
  locale: TextLocale = 'zh-Hant',
  stop?: (child: unknown) => void,
): Promise<VerifyResult> {
  const files = (changed || [])
    .filter((f) => SYNTAX_EXTS.has(path.extname(f).toLowerCase()))
    .slice(0, SYNTAX_MAX_FILES);
  const syntax: VerifyResult['syntax'] = [];
  let checked = 0;
  for (const file of files) {
    const full = path.join(cwd, file);
    // 刪掉的檔案不檢查:那不是「壞掉」,是這次任務刪的
    if (!fs.existsSync(full)) continue;
    checked++;
    const error = path.extname(file).toLowerCase() === '.json' ? checkJson(full) : await checkJs(full, locale);
    // 訊息裡的絕對路徑換成相對路徑:這段會進對話紀錄與匯出
    if (error) syntax.push({ file, error: truncate(relativize(error, full, file), 500) });
  }

  // 一行一道,依序跑:先 lint、再 type check、再測試。第一道沒過就停——
  // 後面那些多半是同一個錯的回音,而且模型一次修一件事比較有機會修對。
  const gates: GateResult[] = [];
  for (const line of command.split('\n').map((l) => l.trim()).filter(Boolean)) {
    let output = '';
    const r = await runProcess(line, [], { cwd, shell: true, timeoutMs: COMMAND_TIMEOUT_MS, locale }, {
      onProc: (child) => stop && stop(child),
      onLine: (text: string) => { output += `${text}\n`; if (output.length > OUTPUT_MAX * 2) output = output.slice(-OUTPUT_MAX * 2); },
    });
    const text = `${output}${r.stderr || ''}`.trim();
    gates.push({
      command: line,
      // 指令不存在時,shell 會以 127 結束(spawnError 只有連 shell 都起不來才會有);
      // 兩種都算失敗:使用者設了驗證指令卻沒有真的跑到,不能當成通過
      ok: !r.spawnError && !r.timedOut && r.code === 0,
      code: typeof r.code === 'number' ? r.code : null,
      timedOut: !!r.timedOut,
      output: truncate(text || (r.spawnError ? String((r.spawnError as Error).message || r.spawnError) : ''), OUTPUT_MAX),
      ...(!r.timedOut && (r.code === 127 || !!r.spawnError) ? { notFound: true } : {}),
    });
    if (!gates[gates.length - 1].ok) break;
  }
  const failed = gates.find((g) => !g.ok);

  const ran = checked > 0 || gates.length > 0;
  return {
    syntax,
    ...(gates.length ? { gates } : {}),
    ...(failed ? { command: failed } : {}),
    checked,
    ran,
    ok: syntax.length === 0 && !failed,
  };
}

// 錯誤訊息裡的絕對路徑換成相對路徑。要連實際路徑一起換:macOS 的 /var 是 /private/var 的
// 連結,子行程印出來的是 realpath,只比對原本那個路徑會留下半截「/private」黏在檔名前面。
function relativize(text: string, full: string, file: string): string {
  // 長的先換:/var/... 是 /private/var/... 的一部分,先換短的會把長的切斷,
  // 剩下半截「/private」黏在檔名前面(實測過的樣子:/privatebroken.js:2)
  const paths = [...new Set([full, realpathOrNull(full)])].filter(Boolean).sort((a, b) => b!.length - a!.length);
  let out = text;
  for (const p of paths) out = out.split(p as string).join(file);
  return out;
}

function realpathOrNull(full: string): string | null {
  try { return fs.realpathSync(full); } catch { return null; }
}

function checkJson(full: string): string | null {
  try { JSON.parse(fs.readFileSync(full, 'utf8')); return null; } catch (e) { return String((e as Error).message || e); }
}

// node --check 只解析、不執行:模組裡的程式碼不會被跑到,但語法錯誤一定抓得到。
//
// 這裡的環境是刻意寫死的,兩樣都實測過:
//   ELECTRON_RUN_AS_NODE:在 app 裡 process.execPath 是 Electron 本身,不是 node。少了它,
//     這行不是「檢查語法」而是「用 Electron 執行那個檔案」——後果是有語法錯誤的檔案被判成通過,
//     而成員自己寫的測試檔被實際執行、測試失敗被誤報成「載不起來」。
//   NODE_OPTIONS:子行程會繼承 process.env,而 app 是從使用者的登入 shell 匯進整份環境的
//     (main.ts importShellEnv)。使用者的 NODE_OPTIONS 只要有一個這顆 Node 不認得的參數,
//     檢查本身就以結束代碼 9 收場,然後每一個改動過的 .js 都被誣賴成語法錯誤。清掉它。
// 單元測試在純 node 底下跑,看不到這些差別;test/harness/scenarios/verify.ts 在真的 app 裡驗。
const CHECK_ENV = { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' };

// 回傳 null 代表「檢查本身沒跑成」——這種時候不能反過來說使用者的檔案壞了。
async function nodeCheck(args: string[], stdin: string | undefined, locale: TextLocale): Promise<{ ok: boolean; error: string } | null> {
  const r = await runProcess(process.execPath, args, { timeoutMs: SYNTAX_TIMEOUT_MS, locale, env: CHECK_ENV, ...(stdin != null ? { stdin } : {}) });
  if (r.spawnError || r.timedOut) return null;
  const stderr = (r.stderr || '').trim();
  if (/not allowed in NODE_OPTIONS/.test(stderr)) return null; // 環境的問題,不是檔案的問題
  return { ok: r.code === 0, error: stderr || `exit ${r.code}` };
}

// 一個 .js 檔要用哪一種解析方式,取決於最近的 package.json 有沒有 "type": "module"——
// 而 Electron 內建的 Node 20 預設不會去猜(新版 node 會)。結果是:同一個 ESM 寫法的 .js,
// 開發機上 node --check 過,在 app 裡卻被判成「Unexpected token 'export'」,
// 然後修復回合被派去修一個根本沒壞的檔案。所以兩種解析都試,兩種都不過才算壞。
async function checkJs(full: string, locale: TextLocale): Promise<string | null> {
  const r = await nodeCheck(['--check', full], undefined, locale);
  if (!r || r.ok) return null;
  if (path.extname(full).toLowerCase() !== '.js') return r.error;
  let source: string;
  try { source = fs.readFileSync(full, 'utf8'); } catch { return r.error; }
  const esm = await nodeCheck(['--input-type=module', '--check'], source, locale);
  if (!esm || esm.ok) return null;
  // 兩種都不過:如果 CommonJS 那次的錯就是在抱怨「這看起來是 ES module」,
  // 那段訊息對使用者沒有意義,報 ES module 解析出來的錯比較貼近真正的問題。
  if (!/ES module|import statement|Unexpected token '(export|import)'/.test(r.error)) return r.error;
  // 走 stdin 檢查的錯誤訊息裡檔名會變成 [stdin],對照不回原本那個檔
  return esm.error.split('[stdin]').join(path.basename(full));
}

// 給模型看的一段文字(審查提示與修復意見都用它);通過時回 null,沒什麼好說的
export function verifyNotes(result: VerifyResult, locale: TextLocale = 'zh-Hant'): string | null {
  if (result.ok) return null;
  const parts: string[] = [];
  if (result.syntax.length) {
    parts.push(tx(locale, 'verify.syntaxFailed', {
      list: result.syntax.map((s) => tx(locale, 'verify.syntaxItem', { file: s.file, error: s.error })).join('\n'),
    }));
  }
  if (result.command && !result.command.ok) {
    // 找不到指令要講成「找不到」:說成「失敗(結束代碼 127)」會讓人跑去翻程式碼
    const key = result.command.timedOut ? 'verify.commandTimeout' : result.command.notFound ? 'verify.commandNotFound' : 'verify.commandFailed';
    parts.push(tx(locale, key, {
      command: result.command.command,
      code: String(result.command.code ?? '?'),
      output: result.command.output || tx(locale, 'verify.noOutput'),
    }));
    // 前面幾道過了也要說:模型才知道是在哪一步壞的,不會整組重做
    const passed = (result.gates || []).filter((g) => g.ok).map((g) => `\`${g.command}\``);
    if (passed.length) parts.push(tx(locale, 'verify.gatesPassed', { list: passed.join('、') }));
  }
  return parts.join('\n\n');
}
