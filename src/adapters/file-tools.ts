// 給 OpenAI-compatible 本地模型使用的受限檔案工具。
// 這層只允許 workDir 內的 UTF-8 文字檔，沒有 shell，也不會猜測修改位置。

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

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

export const FILE_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '讀取工作目錄內的 UTF-8 文字檔。修改既有檔案前必須先呼叫，並把 sha256 傳給寫入工具。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['path'],
        properties: {
          path: { type: 'string', description: '相對於工作目錄的路徑' },
          offset: { type: 'integer', minimum: 0, description: '從第幾個字元開始，預設 0' },
          limit: { type: 'integer', minimum: 1, maximum: FILE_TOOL_MAX_READ_CHARS, description: '最多回傳字元數' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '建立小型文字檔，或在 sha256 未改變時整檔覆寫。既有檔案必須提供 expectedSha256；新檔必須 createOnly=true。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['path', 'content', 'reason'],
        properties: {
          path: { type: 'string', description: '相對於工作目錄的路徑' },
          content: { type: 'string', description: '完整 UTF-8 文字內容，上限 256KB' },
          expectedSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
          createOnly: { type: 'boolean', description: '建立新檔時必須為 true；檔案已存在就失敗' },
          reason: { type: 'string', minLength: 1, maxLength: 500, description: '本次修改目的，會進入審查紀錄' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_text',
      description: '以精確文字做局部替換。預設要求 oldText 只出現一次；多處替換必須明確指定 replaceAll=true。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['path', 'oldText', 'newText', 'expectedSha256'],
        properties: {
          path: { type: 'string', description: '相對於工作目錄的路徑' },
          oldText: { type: 'string', minLength: REPLACE_TEXT_MIN_CHARS, description: '至少 24 個字元的精確原文' },
          newText: { type: 'string', description: '替換後文字' },
          expectedSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
          replaceAll: { type: 'boolean', description: '明確允許替換全部匹配；預設 false' },
        },
      },
    },
  },
] as const;

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
  if (dirHit) throw new Error(`不可寫入 ${dirHit} 底下的檔案:這裡的內容會被自動執行`);
  if (parts.length === 1) {
    const name = parts[0].toLowerCase();
    if (AUTO_EXEC_ROOT_FILES.has(name) || AUTO_EXEC_ROOT_PREFIXES.some((p) => name.startsWith(p))) {
      throw new Error(`不可寫入 ${parts[0]}:這個檔案會被自動執行`);
    }
  }
}

// 已經帶執行位元的檔案改了就是改了執行中的程式。atomicWrite 會保留原權限,
// 所以覆寫一個 0755 的 shell script 等同直接換掉一支會被跑起來的指令。
function assertNotExecutable(mode: number, relPath: string): void {
  if (mode & 0o111) throw new Error(`不可寫入 ${relPath}:這個檔案帶有執行權限`);
}

function assertNotVcsInternal(root: string, candidate: string): void {
  if (!isInside(root, candidate)) return;
  const parts = path.relative(root, candidate).split(path.sep).filter(Boolean);
  if (parts.some((part) => VCS_INTERNAL_NAMES.has(part.toLowerCase()))) {
    throw new Error('不可讀取或修改版本控制內部檔案（.git、.hg、.svn）');
  }
}

function assertPlainRelativePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('path 必須是非空白相對路徑');
  if (path.isAbsolute(value)) throw new Error('path 必須是相對於工作目錄的路徑');
  if (value.includes('\0')) throw new Error('path 不可包含 NUL');
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
    if (text.includes('\0')) throw new Error('只允許 UTF-8 文字檔，不可包含 NUL');
    return text;
  }
  catch { throw new Error('只允許有效的 UTF-8 文字檔'); }
}

function validateTextContent(value: unknown): { text: string; buffer: Buffer } {
  if (typeof value !== 'string') throw new Error('content 必須是字串');
  if (hasUnpairedSurrogate(value)) throw new Error('content 必須是有效的 UTF-8 文字');
  if (value.includes('\0')) throw new Error('content 不可包含 NUL');
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length > FILE_TOOL_MAX_BYTES) throw new Error(`檔案內容超過 ${FILE_TOOL_MAX_BYTES} bytes 上限`);
  return { text: value, buffer };
}

function readSmallUtf8(file: string): { buffer: Buffer; text: string; mode: number } {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('只允許一般檔案');
  if (stat.size > FILE_TOOL_MAX_BYTES) throw new Error(`檔案超過 ${FILE_TOOL_MAX_BYTES} bytes 上限`);
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
  private calls = 0;
  private outputChars = 0;

  constructor(workDir: string) {
    if (!workDir || !fs.existsSync(workDir)) throw new Error('工作目錄不存在');
    const root = fs.realpathSync.native(workDir);
    if (!fs.statSync(root).isDirectory()) throw new Error('工作目錄不是資料夾');
    this.root = root;
  }

  get remainingCalls(): number {
    return Math.max(0, FILE_TOOL_MAX_CALLS - this.calls);
  }

  private candidate(input: unknown): string {
    const rel = assertPlainRelativePath(input);
    const candidate = path.resolve(this.root, rel);
    if (!isInside(this.root, candidate)) throw new Error('路徑超出工作目錄');
    assertNotVcsInternal(this.root, candidate);
    return candidate;
  }

  private existingPath(input: unknown, { rejectFinalSymlink = false }: { rejectFinalSymlink?: boolean } = {}): string {
    const candidate = this.candidate(input);
    const lst = fs.lstatSync(candidate);
    if (rejectFinalSymlink && lst.isSymbolicLink()) throw new Error('不允許透過符號連結寫入');
    const real = fs.realpathSync.native(candidate);
    if (!isInside(this.root, real)) throw new Error('符號連結指向工作目錄外');
    assertNotVcsInternal(this.root, real);
    return real;
  }

  private newPath(input: unknown): string {
    const candidate = this.candidate(input);
    const parent = path.dirname(candidate);
    if (!fs.existsSync(parent)) throw new Error('新檔案的父資料夾不存在');
    const realParent = fs.realpathSync.native(parent);
    if (!isInside(this.root, realParent)) throw new Error('符號連結指向工作目錄外');
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
      if (!(committed && candidate.ok)) return { ok: false, error: '本回合工具輸出已達上限' };
      // 連精簡後的結果都放不下:照實記帳並回報成功，超出軟上限也好過謊報未修改。
    }
    this.outputChars += size;
    return candidate;
  }

  execute(name: unknown, rawArgs: unknown): FileToolResult {
    this.calls++;
    if (this.calls > FILE_TOOL_MAX_CALLS) return { ok: false, error: `本回合工具呼叫不可超過 ${FILE_TOOL_MAX_CALLS} 次` };
    try {
      if (typeof rawArgs === 'string' && rawArgs.length > FILE_TOOL_MAX_ARGUMENT_CHARS) {
        throw new Error(`工具參數超過 ${FILE_TOOL_MAX_ARGUMENT_CHARS} 字元上限`);
      }
      if ((name === 'write_file' || name === 'replace_text')
        && this.outputChars + MUTATION_RESULT_RESERVE_CHARS > FILE_TOOL_MAX_OUTPUT_CHARS) {
        throw new Error('本回合工具輸出額度不足，未修改檔案');
      }
      let args: any = rawArgs;
      if (typeof rawArgs === 'string') {
        try { args = JSON.parse(rawArgs); }
        catch { throw new Error('工具參數不是有效 JSON'); }
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具參數必須是物件');
      if (name === 'read_file') return this.finish(this.readFile(args));
      // 這兩個工具回傳時檔案已經寫入,結果必須標成 committed。
      if (name === 'write_file') return this.finish(this.writeFile(args), true);
      if (name === 'replace_text') return this.finish(this.replaceText(args), true);
      return this.finish({ ok: false, error: `不支援的工具:${String(name)}` });
    } catch (error) {
      return this.finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private readFile(args: any): FileToolResult {
    const target = this.existingPath(args.path);
    const { buffer, text } = readSmallUtf8(target);
    const offset = args.offset == null ? 0 : args.offset;
    const limit = args.limit == null ? FILE_TOOL_MAX_READ_CHARS : args.limit;
    if (!Number.isInteger(offset) || offset < 0) throw new Error('offset 必須是非負整數');
    if (!Number.isInteger(limit) || limit < 1 || limit > FILE_TOOL_MAX_READ_CHARS) throw new Error(`limit 必須是 1–${FILE_TOOL_MAX_READ_CHARS} 的整數`);
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
    if (typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 500) throw new Error('reason 必須是 1–500 字元');
    const { text, buffer } = validateTextContent(args.content);
    if (exists && createOnly) throw new Error('createOnly=true，但檔案已存在');
    if (!exists && !createOnly) throw new Error('建立新檔案必須指定 createOnly=true');

    if (!exists) {
      if (args.expectedSha256 != null && args.expectedSha256 !== '') throw new Error('建立新檔案不可提供 expectedSha256');
      const target = this.newPath(rel);
      assertNotAutoExecuted(this.root, target);
      atomicWrite(target, buffer, 0o644, true);
      const stats = countChangedLines('', text);
      const newSha = sha256(buffer);
      return { ok: true, path: path.relative(this.root, target), ...stats, newSha256: newSha, shaAfter: newSha, reason: args.reason.trim() };
    }

    if (typeof args.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(args.expectedSha256)) throw new Error('覆寫既有檔案前必須提供 read_file 回傳的 expectedSha256');
    const target = this.existingPath(rel, { rejectFinalSymlink: true });
    assertNotAutoExecuted(this.root, target);
    const before = readSmallUtf8(target);
    assertNotExecutable(before.mode, path.relative(this.root, target));
    if (sha256(before.buffer) !== args.expectedSha256.toLowerCase()) throw new Error('檔案已被其他成員修改，sha256 不符；請重新 read_file');
    const verify = () => {
      const current = readSmallUtf8(target);
      if (sha256(current.buffer) !== args.expectedSha256.toLowerCase()) throw new Error('寫入前檔案又被修改，請重新 read_file');
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
    if (typeof args.oldText !== 'string' || Array.from(args.oldText).length < REPLACE_TEXT_MIN_CHARS || !args.oldText.trim()) throw new Error(`oldText 至少需要 ${REPLACE_TEXT_MIN_CHARS} 個非空白文字字元`);
    if (typeof args.newText !== 'string') throw new Error('newText 必須是字串');
    if (hasUnpairedSurrogate(args.oldText) || hasUnpairedSurrogate(args.newText) || args.oldText.includes('\0') || args.newText.includes('\0')) throw new Error('替換文字必須是有效且不含 NUL 的 UTF-8');
    if (CONTROL_CHARS.test(args.oldText) || CONTROL_CHARS.test(args.newText)) throw new Error('替換文字不可包含控制字元(tab、換行、歸位除外)');
    if (typeof args.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(args.expectedSha256)) throw new Error('replace_text 必須提供 read_file 回傳的 expectedSha256');
    const target = this.existingPath(args.path, { rejectFinalSymlink: true });
    assertNotAutoExecuted(this.root, target);
    const before = readSmallUtf8(target);
    assertNotExecutable(before.mode, path.relative(this.root, target));
    if (sha256(before.buffer) !== args.expectedSha256.toLowerCase()) throw new Error('檔案已被其他成員修改，sha256 不符；請重新 read_file');

    let count = 0;
    let at = 0;
    while ((at = before.text.indexOf(args.oldText, at)) >= 0) { count++; at += args.oldText.length; }
    if (!count) throw new Error('找不到 oldText，未修改檔案');
    if (count > 1 && args.replaceAll !== true) throw new Error(`oldText 出現 ${count} 次；請提供更長的唯一內容，或明確設定 replaceAll=true`);
    // 兩個分支都用 split/join:String.replace 會把 newText 裡的 $&、$`、$'、$$ 當成
    // 替換樣式展開,寫進磁碟的內容就會跟稽核紀錄的 newText 不一致——那等於讓成員把
    // 自己沒寫出來的內容搬進檔案,而 reviewer 只看得到字面上的 "$'"。
    // 走到這裡時,非 replaceAll 的情況已經確認 count === 1,所以 split/join 完全等價。
    const afterText = before.text.split(args.oldText).join(args.newText);
    const validated = validateTextContent(afterText);
    const verify = () => {
      const current = readSmallUtf8(target);
      if (sha256(current.buffer) !== args.expectedSha256.toLowerCase()) throw new Error('寫入前檔案又被修改，請重新 read_file');
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

export function toTranscriptEntry(toolCallId: string, name: string, args: unknown, result: FileToolResult): FileToolTranscriptEntry {
  let parsed: any = args;
  if (typeof args === 'string') try { parsed = JSON.parse(args); } catch { parsed = {}; }
  const summary = result.ok
    ? `${name} ${result.path || parsed?.path || ''} 完成${result.added != null ? ` (+${result.added}/-${result.removed || 0})` : ''}`
    : `${name} ${parsed?.path || ''} 失敗:${result.error || '未知錯誤'}`;
  const { content: _content, ...safeResult } = result;
  return { toolCallId, name, path: result.path || parsed?.path, ok: result.ok, summary, result: safeResult };
}
