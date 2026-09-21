// 給 OpenAI-compatible 本地模型使用的受限檔案工具。
// 這層只允許 workDir 內的 UTF-8 文字檔，沒有 shell，也不會猜測修改位置。

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { tx } from '../text';
import type { TextLocale } from '../text';

// 錯誤先用字串代號丟出,由 execute 依這個回合的語言翻成文字:底層的檢查不必各自知道語言。
// 這些訊息模型會讀(決定下一步怎麼做),工具紀錄裡使用者也看得到,所以要跟著介面語言。
class ToolError extends Error {
  constructor(readonly key: string, readonly params: Record<string, string | number> = {}) { super(key); }
}
const fail = (key: string, params?: Record<string, string | number>) => new ToolError(key, params);

export const FILE_TOOL_MAX_BYTES = 256 * 1024;
export const FILE_TOOL_MAX_READ_CHARS = 64 * 1024;
export const FILE_TOOL_MAX_CALLS = 20;
export const FILE_TOOL_MAX_OUTPUT_CHARS = 128 * 1024;
export const FILE_TOOL_MAX_ARGUMENT_CHARS = 300 * 1024;
export const REPLACE_TEXT_MIN_CHARS = 24;
const REPLACEMENT_EXCERPT_CHARS = 2000;
// 寫入結果（含兩段 excerpt）最壞仍小於此值。先保留額度，避免檔案已落盤後才回報「輸出超限」。
const MUTATION_RESULT_RESERVE_CHARS = 16 * 1024;

export type FileToolName = 'read_file' | 'write_file' | 'replace_text';

export interface FileToolResult {
  ok: boolean;
  error?: string;
  path?: string;
  content?: string;
  sha256?: string;
  shaBefore?: string;
  shaAfter?: string;
  truncated?: boolean;
  added?: number;
  removed?: number;
  // 只在極端大且高度重排的檔案觸發演算法保護時為 true；此時數字是變動區段上界。
  statsApproximate?: boolean;
  replacements?: number;
  newSha256?: string;
  reason?: string;
  replaced?: { before: string; after: string; truncated: boolean };
  // 檔案已寫入,但結果本身放不進本回合輸出額度,excerpt 被拿掉。
  // 修改一定要照實回報,不能因為額度不足就變成「失敗」。
  resultTruncated?: boolean;
}

export interface FileToolTranscriptEntry {
  toolCallId: string;
  // Adapter 事件的正式工具名稱欄位；orchestrator 轉成 ToolAuditEntry.tool。
  name: string;
  path?: string;
  ok: boolean;
  summary: string;
  result: Omit<FileToolResult, 'content'>;
}

// 工具說明是模型讀的:跟著這個回合的語言,英文會議裡才不會混進中文的工具說明
export function fileToolDefinitions(locale: TextLocale = 'zh-Hant') {
  const d = (key: string) => tx(locale, key);
  return [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: d('ft.def.read'),
      parameters: {
        type: 'object', additionalProperties: false, required: ['path'],
        properties: {
          path: { type: 'string', description: d('ft.def.path') },
          offset: { type: 'integer', minimum: 0, description: d('ft.def.offset') },
          limit: { type: 'integer', minimum: 1, maximum: FILE_TOOL_MAX_READ_CHARS, description: d('ft.def.limit') },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: d('ft.def.write'),
      parameters: {
        type: 'object', additionalProperties: false, required: ['path', 'content', 'reason'],
        properties: {
          path: { type: 'string', description: d('ft.def.path') },
          content: { type: 'string', description: d('ft.def.content') },
          expectedSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
          createOnly: { type: 'boolean', description: d('ft.def.createOnly') },
          reason: { type: 'string', minLength: 1, maxLength: 500, description: d('ft.def.reason') },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_text',
      description: d('ft.def.replace'),
      parameters: {
        type: 'object', additionalProperties: false, required: ['path', 'oldText', 'newText', 'expectedSha256'],
        properties: {
          path: { type: 'string', description: d('ft.def.path') },
          oldText: { type: 'string', minLength: REPLACE_TEXT_MIN_CHARS, description: d('ft.def.oldText') },
          newText: { type: 'string', description: d('ft.def.newText') },
          expectedSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
          replaceAll: { type: 'boolean', description: d('ft.def.replaceAll') },
        },
      },
    },
  },
] as const;
}

// 審查回合只給讀取工具:定義裡沒有寫入工具,模型就不會以為自己該改檔。
export function fileToolReadDefinitions(locale: TextLocale = 'zh-Hant') {
  return fileToolDefinitions(locale).filter((d) => d.function.name === 'read_file');
}

function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

const VCS_INTERNAL_NAMES = new Set(['.git', '.hg', '.svn']);

// 會被自動執行的路徑。與 VCS 規則不同,這組只擋「寫入」:讀 package.json 或 .husky/pre-commit
// 是理解專案的正當需求,寫進去才會讓程式碼在使用者機器上真的跑起來。
// 這些檔案的共同點是「使用者不會特地去看,但某個日常動作會執行它」——
// git commit、npm install、開啟資料夾、下一次 CI。改動藏在這裡最不可能被發現。
const AUTO_EXEC_DIR_NAMES = new Set([
  '.husky',        // core.hooksPath,每次 git commit / push
  '.vscode',       // tasks.json 的 runOn: folderOpen
  '.idea',         // JetBrains 的 run configuration
  '.claude',       // settings.json 的 hooks
  '.github',       // workflows,下一次 push 就跑
  '.devcontainer', // postCreateCommand
  'node_modules',  // 直接被 require/import
]);

// 根層才擋:專案深處剛好叫 Makefile 的測試素材不該被牽連。
const AUTO_EXEC_ROOT_FILES = new Set([
  'package.json',            // scripts.preinstall / postinstall / prepare
  '.npmrc', '.yarnrc', '.yarnrc.yml',
  '.pnpmfile.cjs',
  'makefile', 'gnumakefile',
  '.pre-commit-config.yaml', '.pre-commit-config.yml',
]);
const AUTO_EXEC_ROOT_PREFIXES = ['lefthook.'];

function assertNotAutoExecuted(root: string, target: string): void {
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  const dirHit = parts.find((part) => AUTO_EXEC_DIR_NAMES.has(part.toLowerCase()));
  if (dirHit) throw fail('ft.autoExecDir', { dir: dirHit });
  if (parts.length === 1) {
    const name = parts[0].toLowerCase();
    if (AUTO_EXEC_ROOT_FILES.has(name) || AUTO_EXEC_ROOT_PREFIXES.some((p) => name.startsWith(p))) {
      throw fail('ft.autoExecFile', { file: parts[0] });
    }
  }
}

// 已經帶執行位元的檔案改了就是改了執行中的程式。atomicWrite 會保留原權限,
// 所以覆寫一個 0755 的 shell script 等同直接換掉一支會被跑起來的指令。
function assertNotExecutable(mode: number, relPath: string): void {
  if (mode & 0o111) throw fail('ft.executable', { file: relPath });
}

function assertNotVcsInternal(root: string, candidate: string): void {
  if (!isInside(root, candidate)) return;
  const parts = path.relative(root, candidate).split(path.sep).filter(Boolean);
  if (parts.some((part) => VCS_INTERNAL_NAMES.has(part.toLowerCase()))) {
    throw fail('ft.vcs');
  }
}

function assertPlainRelativePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw fail('ft.pathEmpty');
  if (path.isAbsolute(value)) throw fail('ft.pathAbsolute');
  if (value.includes('\0')) throw fail('ft.pathNul');
  return value;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

// 精確文字編輯用不到 C0 控制字元與 DEL(\t \n \r 除外),但它們在 JSON 序列化時
// 會膨脹成 6 倍(U+0001 → "\u0001"),足以把寫入結果撐破輸出額度預留。
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function decodeUtf8(buffer: Buffer): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (text.includes('\0')) throw fail('ft.textNul');
    return text;
  }
  catch { throw fail('ft.textInvalid'); }
}

function validateTextContent(value: unknown): { text: string; buffer: Buffer } {
  if (typeof value !== 'string') throw fail('ft.contentString');
  if (hasUnpairedSurrogate(value)) throw fail('ft.contentUtf8');
  if (value.includes('\0')) throw fail('ft.contentNul');
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length > FILE_TOOL_MAX_BYTES) throw fail('ft.contentTooBig', { max: FILE_TOOL_MAX_BYTES });
  return { text: value, buffer };
}

function readSmallUtf8(file: string): { buffer: Buffer; text: string; mode: number } {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw fail('ft.notRegular');
  if (stat.size > FILE_TOOL_MAX_BYTES) throw fail('ft.fileTooBig', { max: FILE_TOOL_MAX_BYTES });
  const buffer = fs.readFileSync(file);
  return { buffer, text: decodeUtf8(buffer), mode: stat.mode & 0o7777 };
}

function splitLinesPreservingEndings(value: string): string[] {
  if (!value) return [];
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\n') { lines.push(value.slice(start, i + 1)); start = i + 1; }
  }
  if (start < value.length) lines.push(value.slice(start));
  return lines;
}

// Myers shortest-edit-script：回傳逐行 diff 的精確新增／刪除數。
// 先剝共同首尾與完全無交集的情況，讓一般程式碼修改接近線性。
function countChangedLines(before: string, after: string): { added: number; removed: number; statsApproximate?: boolean } {
  let a = splitLinesPreservingEndings(before);
  let b = splitLinesPreservingEndings(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let aEnd = a.length - 1;
  let bEnd = b.length - 1;
  while (aEnd >= start && bEnd >= start && a[aEnd] === b[bEnd]) { aEnd--; bEnd--; }
  a = a.slice(start, aEnd + 1);
  b = b.slice(start, bEnd + 1);
  if (!a.length || !b.length) return { removed: a.length, added: b.length };

  const smaller = a.length < b.length ? a : b;
  const larger = a.length < b.length ? b : a;
  const values = new Set(smaller);
  if (!larger.some((line) => values.has(line))) return { removed: a.length, added: b.length };

  const max = a.length + b.length;
  const offset = max + 1;
  const frontier = new Int32Array(max * 2 + 3);
  frontier.fill(-1);
  frontier[offset + 1] = 0;
  // 病態的超大重排可能讓 Myers 退化成平方時間；超過預算就誠實回傳上界，不能卡死主程序。
  const operationBudget = 12_000_000;
  let operations = 0;
  for (let distance = 0; distance <= max; distance++) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (++operations > operationBudget) return { removed: a.length, added: b.length, statsApproximate: true };
      let x: number;
      if (diagonal === -distance || (diagonal !== distance && frontier[offset + diagonal - 1] < frontier[offset + diagonal + 1])) {
        x = frontier[offset + diagonal + 1];
      } else x = frontier[offset + diagonal - 1] + 1;
      let y = x - diagonal;
      while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++; }
      frontier[offset + diagonal] = x;
      if (x >= a.length && y >= b.length) {
        const removed = (distance + a.length - b.length) / 2;
        return { removed, added: distance - removed };
      }
    }
  }
  return { removed: a.length, added: b.length, statsApproximate: true };
}

function excerpt(value: string): { text: string; truncated: boolean } {
  if (value.length <= REPLACEMENT_EXCERPT_CHARS) return { text: value, truncated: false };
  return { text: value.slice(0, REPLACEMENT_EXCERPT_CHARS), truncated: true };
}

function atomicWrite(target: string, buffer: Buffer, mode: number, createOnly: boolean, verifyCurrent?: () => void) {
  const dir = path.dirname(target);
  const temp = path.join(dir, `.${path.basename(target)}.roundtable-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, 'wx', mode);
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.chmodSync(temp, mode);
    verifyCurrent?.();
    if (createOnly) {
      // link 是「目標已存在就失敗」的原子建立；rename 在 POSIX 會覆蓋，不能用於 createOnly。
      fs.linkSync(temp, target);
      fs.unlinkSync(temp);
    } else fs.renameSync(temp, target);
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temp); } catch {}
  }
}

export class FileToolSession {
  readonly root: string;
  // 審查者只需要「看」,不該能改。工具定義只給 read_file 還不夠——模型仍可能照記憶
  // 呼叫 write_file,所以在這裡再擋一次,不靠模型守規矩。
  readonly readOnly: boolean;
  readonly locked: Set<string>;
  // 錯誤訊息的語言
  readonly locale: TextLocale;
  private calls = 0;
  private outputChars = 0;

  constructor(workDir: string, { readOnly = false, locale = 'zh-Hant', locked = [] }: { readOnly?: boolean; locale?: TextLocale; locked?: string[] } = {}) {
    if (!workDir || !fs.existsSync(workDir)) throw new Error(tx(locale, 'ft.noWorkdir'));
    const root = fs.realpathSync.native(workDir);
    if (!fs.statSync(root).isDirectory()) throw new Error(tx(locale, 'ft.workdirNotDir'));
    this.root = root;
    this.readOnly = readOnly;
    // 鎖住的檔案(修復回合的既有測試檔):讀得到,寫不了
    this.locked = new Set(locked.map((p) => p.replace(/^\.\//, '')));
    this.locale = locale;
  }

  get remainingCalls(): number {
    return Math.max(0, FILE_TOOL_MAX_CALLS - this.calls);
  }

  private candidate(input: unknown): string {
    const rel = assertPlainRelativePath(input);
    const candidate = path.resolve(this.root, rel);
    if (!isInside(this.root, candidate)) throw fail('ft.outside');
    assertNotVcsInternal(this.root, candidate);
    return candidate;
  }

  private existingPath(input: unknown, { rejectFinalSymlink = false }: { rejectFinalSymlink?: boolean } = {}): string {
    const candidate = this.candidate(input);
    const lst = fs.lstatSync(candidate);
    if (rejectFinalSymlink && lst.isSymbolicLink()) throw fail('ft.symlinkWrite');
    const real = fs.realpathSync.native(candidate);
    if (!isInside(this.root, real)) throw fail('ft.symlinkOutside');
    assertNotVcsInternal(this.root, real);
    return real;
  }

  private newPath(input: unknown): string {
    const candidate = this.candidate(input);
    const parent = path.dirname(candidate);
    if (!fs.existsSync(parent)) throw fail('ft.noParent');
    const realParent = fs.realpathSync.native(parent);
    if (!isInside(this.root, realParent)) throw fail('ft.symlinkOutside');
    const target = path.join(realParent, path.basename(candidate));
    assertNotVcsInternal(this.root, target);
    return target;
  }

  // committed=true 代表檔案已經落盤。這種結果永遠不可以被改寫成失敗:
  // reviewer 會把「失敗」讀成「沒有改動」，於是沒人去看那次真實的修改，
  // 而畫面上跟順利跑完一模一樣。額度不足時寧可捨棄 excerpt，也要保住 ok:true。
  private finish(result: FileToolResult, committed = false): FileToolResult {
    let candidate = result;
    if (committed && candidate.ok && this.outputChars + JSON.stringify(candidate).length > FILE_TOOL_MAX_OUTPUT_CHARS) {
      const { replaced: _dropped, ...rest } = candidate;
      candidate = { ...rest, resultTruncated: true };
    }
    const size = JSON.stringify(candidate).length;
    if (this.outputChars + size > FILE_TOOL_MAX_OUTPUT_CHARS) {
      if (!(committed && candidate.ok)) return { ok: false, error: tx(this.locale, 'ft.outputFull') };
      // 連精簡後的結果都放不下:照實記帳並回報成功，超出軟上限也好過謊報未修改。
    }
    this.outputChars += size;
    return candidate;
  }

  execute(name: unknown, rawArgs: unknown): FileToolResult {
    this.calls++;
    if (this.calls > FILE_TOOL_MAX_CALLS) return { ok: false, error: tx(this.locale, 'ft.tooManyCalls', { n: FILE_TOOL_MAX_CALLS }) };
    try {
      if (typeof rawArgs === 'string' && rawArgs.length > FILE_TOOL_MAX_ARGUMENT_CHARS) {
        throw fail('ft.argsTooBig', { max: FILE_TOOL_MAX_ARGUMENT_CHARS });
      }
      if ((name === 'write_file' || name === 'replace_text')
        && this.outputChars + MUTATION_RESULT_RESERVE_CHARS > FILE_TOOL_MAX_OUTPUT_CHARS) {
        throw fail('ft.outputReserve');
      }
      let args: any = rawArgs;
      if (typeof rawArgs === 'string') {
        try { args = JSON.parse(rawArgs); }
        catch { throw fail('ft.argsJson'); }
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('ft.argsObject');
      if (name === 'read_file') return this.finish(this.readFile(args));
      if (this.readOnly && (name === 'write_file' || name === 'replace_text')) throw fail('ft.readOnly');
      // 測試鎖:讓測試通過要改實作,不是改測試(見 src/test-lock.ts)
      if (this.locked.size && (name === 'write_file' || name === 'replace_text')) {
        const target = String((args as any).path || '').replace(/^\.\//, '');
        if (this.locked.has(target)) throw fail('ft.lockedTest', { path: target });
      }
      // 這兩個工具回傳時檔案已經寫入,結果必須標成 committed。
      if (name === 'write_file') return this.finish(this.writeFile(args), true);
      if (name === 'replace_text') return this.finish(this.replaceText(args), true);
      return this.finish({ ok: false, error: tx(this.locale, 'ft.unknownTool', { name: String(name) }) });
    } catch (error) {
      const message = error instanceof ToolError ? tx(this.locale, error.key, error.params) : error instanceof Error ? error.message : String(error);
      return this.finish({ ok: false, error: message });
    }
  }

  private readFile(args: any): FileToolResult {
    const target = this.existingPath(args.path);
    const { buffer, text } = readSmallUtf8(target);
    const offset = args.offset == null ? 0 : args.offset;
    const limit = args.limit == null ? FILE_TOOL_MAX_READ_CHARS : args.limit;
    if (!Number.isInteger(offset) || offset < 0) throw fail('ft.offset');
    if (!Number.isInteger(limit) || limit < 1 || limit > FILE_TOOL_MAX_READ_CHARS) throw fail('ft.limit', { max: FILE_TOOL_MAX_READ_CHARS });
    const end = Math.min(text.length, offset + limit);
    const currentSha = sha256(buffer);
    return {
      ok: true,
      path: path.relative(this.root, target),
      content: text.slice(offset, end),
      sha256: currentSha,
      shaBefore: currentSha,
      shaAfter: currentSha,
      truncated: offset > 0 || end < text.length,
    };
  }

  private writeFile(args: any): FileToolResult {
    const rel = assertPlainRelativePath(args.path);
    const candidate = this.candidate(rel);
    const exists = fs.existsSync(candidate);
    const createOnly = args.createOnly === true;
    if (typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 500) throw fail('ft.reason');
    const { text, buffer } = validateTextContent(args.content);
    if (exists && createOnly) throw fail('ft.createExists');
    if (!exists && !createOnly) throw fail('ft.createNeedsFlag');

    if (!exists) {
      if (args.expectedSha256 != null && args.expectedSha256 !== '') throw fail('ft.createNoSha');
      const target = this.newPath(rel);
      assertNotAutoExecuted(this.root, target);
      atomicWrite(target, buffer, 0o644, true);
      const stats = countChangedLines('', text);
      const newSha = sha256(buffer);
      return { ok: true, path: path.relative(this.root, target), ...stats, newSha256: newSha, shaAfter: newSha, reason: args.reason.trim() };
    }

    if (typeof args.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(args.expectedSha256)) throw fail('ft.overwriteNeedsSha');
    const target = this.existingPath(rel, { rejectFinalSymlink: true });
    assertNotAutoExecuted(this.root, target);
    const before = readSmallUtf8(target);
    assertNotExecutable(before.mode, path.relative(this.root, target));
    if (sha256(before.buffer) !== args.expectedSha256.toLowerCase()) throw fail('ft.shaMismatch');
    const verify = () => {
      const current = readSmallUtf8(target);
      if (sha256(current.buffer) !== args.expectedSha256.toLowerCase()) throw fail('ft.changedBeforeWrite');
    };
    atomicWrite(target, buffer, before.mode, false, verify);
    const stats = countChangedLines(before.text, text);
    const newSha = sha256(buffer);
    return {
      ok: true,
      path: path.relative(this.root, target),
      ...stats,
      newSha256: newSha,
      shaBefore: args.expectedSha256.toLowerCase(),
      shaAfter: newSha,
      reason: args.reason.trim(),
    };
  }

  private replaceText(args: any): FileToolResult {
    if (typeof args.oldText !== 'string' || Array.from(args.oldText).length < REPLACE_TEXT_MIN_CHARS || !args.oldText.trim()) throw fail('ft.oldTextShort', { n: REPLACE_TEXT_MIN_CHARS });
    if (typeof args.newText !== 'string') throw fail('ft.newTextString');
    if (hasUnpairedSurrogate(args.oldText) || hasUnpairedSurrogate(args.newText) || args.oldText.includes('\0') || args.newText.includes('\0')) throw fail('ft.replaceUtf8');
    if (CONTROL_CHARS.test(args.oldText) || CONTROL_CHARS.test(args.newText)) throw fail('ft.controlChars');
    if (typeof args.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(args.expectedSha256)) throw fail('ft.replaceNeedsSha');
    const target = this.existingPath(args.path, { rejectFinalSymlink: true });
    assertNotAutoExecuted(this.root, target);
    const before = readSmallUtf8(target);
    assertNotExecutable(before.mode, path.relative(this.root, target));
    if (sha256(before.buffer) !== args.expectedSha256.toLowerCase()) throw fail('ft.shaMismatch');

    let count = 0;
    let at = 0;
    while ((at = before.text.indexOf(args.oldText, at)) >= 0) { count++; at += args.oldText.length; }
    if (!count) throw fail('ft.notFound');
    if (count > 1 && args.replaceAll !== true) throw fail('ft.multiple', { n: count });
    // 兩個分支都用 split/join:String.replace 會把 newText 裡的 $&、$`、$'、$$ 當成
    // 替換樣式展開,寫進磁碟的內容就會跟稽核紀錄的 newText 不一致——那等於讓成員把
    // 自己沒寫出來的內容搬進檔案,而 reviewer 只看得到字面上的 "$'"。
    // 走到這裡時,非 replaceAll 的情況已經確認 count === 1,所以 split/join 完全等價。
    const afterText = before.text.split(args.oldText).join(args.newText);
    const validated = validateTextContent(afterText);
    const verify = () => {
      const current = readSmallUtf8(target);
      if (sha256(current.buffer) !== args.expectedSha256.toLowerCase()) throw fail('ft.changedBeforeWrite');
    };
    atomicWrite(target, validated.buffer, before.mode, false, verify);
    const stats = countChangedLines(before.text, afterText);
    const oldExcerpt = excerpt(args.oldText);
    const newExcerpt = excerpt(args.newText);
    return {
      ok: true,
      path: path.relative(this.root, target),
      replacements: args.replaceAll === true ? count : 1,
      ...stats,
      newSha256: sha256(validated.buffer),
      shaBefore: args.expectedSha256.toLowerCase(),
      shaAfter: sha256(validated.buffer),
      replaced: { before: oldExcerpt.text, after: newExcerpt.text, truncated: oldExcerpt.truncated || newExcerpt.truncated },
    };
  }
}

export function toTranscriptEntry(toolCallId: string, name: string, args: unknown, result: FileToolResult, locale: TextLocale = 'zh-Hant'): FileToolTranscriptEntry {
  let parsed: any = args;
  if (typeof args === 'string') try { parsed = JSON.parse(args); } catch { parsed = {}; }
  const summary = result.ok
    ? tx(locale, 'ft.summaryOk', { name, path: result.path || parsed?.path || '', counts: result.added != null ? ` (+${result.added}/-${result.removed || 0})` : '' })
    : tx(locale, 'ft.summaryFail', { name, path: parsed?.path || '', error: result.error || tx(locale, 'ft.unknownError') });
  const { content: _content, ...safeResult } = result;
  return { toolCallId, name, path: result.path || parsed?.path, ok: result.ok, summary, result: safeResult };
}
