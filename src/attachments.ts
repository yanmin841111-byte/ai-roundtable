// 附件儲存層。
//
// 權威儲存一律放在 userData/attachments/<conversationId>/,不寫進使用者的工作目錄:
//   1. 工作目錄通常是使用者的真實 repo,寫進去會被 git status 掃到,
//      在「本回合改了哪些檔案」的摘要裡被誤報成成員的變更。
//   2. 工作目錄可以隨時被換掉,附件會立刻變成孤兒。
//   3. 送出當下還沒有 session 檔,沒有可對齊的 id。
// 沙箱型 CLI(adapter 宣告 capabilities.attachmentsNeedCwd)才在執行前把副本
// 暫存到 workDir/.roundtable-runtime/<conversationId>/,回合結束立刻刪掉;
// 絕不修改使用者的 .gitignore 或 .git/info/exclude。

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Adapter, AdapterCapabilities } from './adapters/types';
import type { AttachmentMeta } from './ipc-types';

// renderer 或紀錄檔傳來的附件 metadata 不可信:欄位可能缺漏或型別不對,使用前一律逐項檢查
type UntrustedMeta = Partial<AttachmentMeta> | null | undefined;
type StagedAttachment = AttachmentMeta & { cwdPath: string };
type Result = { ok: true } | { ok: false; error: string };
// addAttachments 的輸入:拖放給 path,IPC 讀檔給 data(main 端可能收到 Buffer / Uint8Array)
type AttachmentSource = { name?: string; path?: string; data?: ArrayBuffer | Uint8Array | Buffer | null };
type Magic = number[][] | 'webp' | null;

interface FileType {
  mime: string;
  kind: 'image' | 'pdf' | 'text';
  magic: Magic;
}

// ---------- 產品拍板的上限 ----------
const LIMITS = {
  maxFiles: 10,                        // 單次最多 10 個檔
  maxFileBytes: 20 * 1024 * 1024,      // 單檔 20 MB
  maxTotalBytes: 50 * 1024 * 1024,     // 單次合計 50 MB
};

const THUMB_MAX = 256;                 // 縮圖最長邊
const TEXT_INLINE_MAX_CHARS = 20000;   // textInline 單檔內嵌上限
const TEXT_INLINE_TOTAL_MAX_CHARS = 40000; // 單次提示詞的文字附件總上限,避免 10 檔灌入 20 萬字
const SNIFF_BYTES = 64 * 1024;         // magic bytes / NUL 掃描的取樣長度
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000; // 沒對應 session 的附件目錄至少留 24 小時
const RUNTIME_DIR = '.roundtable-runtime';   // 沙箱 CLI 的暫存目錄名(orchestrator 的 git 比對要排除)

// 只接受 id 形狀的目錄 / 檔名成分,和 session-log 的 ID_PATTERN 同一個思路
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

// ---------- 白名單 ----------
// magic 為 null 代表純文字型別,改用 NUL / UTF-8 檢查
const TYPES: Record<string, FileType> = {
  '.png':  { mime: 'image/png',  kind: 'image', magic: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  '.jpg':  { mime: 'image/jpeg', kind: 'image', magic: [[0xff, 0xd8, 0xff]] },
  '.jpeg': { mime: 'image/jpeg', kind: 'image', magic: [[0xff, 0xd8, 0xff]] },
  '.webp': { mime: 'image/webp', kind: 'image', magic: 'webp' },
  '.gif':  { mime: 'image/gif',  kind: 'image', magic: [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]] },
  '.pdf':  { mime: 'application/pdf', kind: 'pdf', magic: [[0x25, 0x50, 0x44, 0x46, 0x2d]] },
  '.txt':  { mime: 'text/plain',    kind: 'text', magic: null },
  '.md':   { mime: 'text/markdown', kind: 'text', magic: null },
  '.json': { mime: 'application/json', kind: 'text', magic: null },
  '.csv':  { mime: 'text/csv',      kind: 'text', magic: null },
  '.log':  { mime: 'text/plain',    kind: 'text', magic: null },
};

const ALLOWED_EXTS = Object.keys(TYPES);

// 副檔名說是文字、內容卻是這些格式時要擋下來:最後拿到路徑的是有 canEdit 權限的 CLI
const BINARY_SIGNATURES = [
  { name: 'ELF 執行檔', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: 'Mach-O 執行檔', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: 'Mach-O 執行檔', bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { name: 'Mach-O 通用二進位', bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { name: 'Windows 執行檔', bytes: [0x4d, 0x5a] },
  { name: 'ZIP / Office 壓縮檔', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { name: 'gzip 壓縮檔', bytes: [0x1f, 0x8b] },
];

// ---------- 錯誤 ----------
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---------- 路徑安全 ----------
const attachmentsRoot = (userDataDir: string) => path.join(userDataDir, 'attachments');

// 三層防護,和 session-log.resolveSessionPath 同一個模式:
//   1. basename 砍掉所有目錄成分,且必須和原字串完全相同(帶目錄就直接拒絕,不默默修正)
//   2. 白名單正規式
//   3. 解析後的 dirname 必須嚴格等於預期的父目錄
// 任何一層不過就回 null,呼叫端不得碰任何檔案。
function resolveInDir(parentDir: string, name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const dir = path.resolve(parentDir);
  const base = path.basename(name);
  if (base !== name) return null;
  if (!COMPONENT_PATTERN.test(base)) return null;
  const full = path.resolve(dir, base);
  if (path.dirname(full) !== dir) return null;
  return full;
}

function conversationDir(userDataDir: string, conversationId: unknown) {
  if (typeof conversationId !== 'string' || !ID_PATTERN.test(conversationId)) return null;
  return resolveInDir(attachmentsRoot(userDataDir), conversationId);
}

// null = 不存在;false = 無法檢查(權限等),呼叫端要當成不安全
function lstat(pathname: string): fs.Stats | null | false {
  try { return fs.lstatSync(pathname); } catch (error) { return errorCode(error) === 'ENOENT' ? null : false; }
}

// app 管理的 attachments / runtime 目錄不允許是符號連結。只做字串 containment
// 仍可能被 <conversationId> -> /tmp/elsewhere 這類連結繞過。
function ensureManagedDir(dir: string) {
  const stat = lstat(dir);
  if (stat === false) throw new Error('無法檢查附件目錄');
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('附件目錄不可是符號連結或一般檔案');
    return;
  }
  fs.mkdirSync(dir);
}

function safeRegularFile(file: string) {
  const stat = lstat(file);
  return !!(stat && stat.isFile() && !stat.isSymbolicLink());
}

function sanitizeOriginalName(value: unknown) {
  const raw = String(value || '').split(/[\\/]/).pop() || '未命名檔案';
  return raw.replace(/[\u0000-\u001f\u007f]/g, '_').slice(0, 200) || '未命名檔案';
}

// 儲存檔名是「<id>__<清理過的原檔名>」:既保證安全,CLI 讀到路徑時也看得出這是什麼檔
function storedName(id: string, originalName: string, ext: string) {
  const raw = sanitizeOriginalName(originalName);
  const stem = raw.slice(0, raw.length - path.extname(raw).length);
  const safe = stem.replace(/[^\w.-]+/g, '_').replace(/^[._-]+/, '').slice(0, 48);
  return safe ? `${id}__${safe}${ext}` : `${id}${ext}`;
}

function newConversationId() { return crypto.randomUUID(); }

// ---------- 內容檢查 ----------
function startsWith(buf: Buffer, bytes: readonly number[]) {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
  return true;
}

function matchesMagic(buf: Buffer, magic: number[][] | 'webp') {
  if (magic === 'webp') {
    // RIFF....WEBP:長度欄位在中間,只能分兩段比對
    return buf.length >= 12 && startsWith(buf, [0x52, 0x49, 0x46, 0x46])
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
  }
  return magic.some((sig) => startsWith(buf, sig));
}

// 純 UTF-8 判定:無效序列會被解碼成 U+FFFD,再編碼回去就對不上原 buffer
function isValidUtf8(buf: Buffer) {
  const decoded = buf.toString('utf8');
  return Buffer.byteLength(decoded, 'utf8') === buf.length && Buffer.from(decoded, 'utf8').equals(buf);
}

// 回傳 null 代表通過;回傳字串是要顯示給使用者的拒絕原因
function verifyContent(buf: Buffer, ext: string, type: FileType) {
  const head = buf.subarray(0, Math.min(buf.length, SNIFF_BYTES));
  if (type.magic) {
    if (!matchesMagic(head, type.magic)) return `內容不是 ${ext.slice(1).toUpperCase()} 格式(副檔名與實際內容不符)`;
    return null;
  }
  // 文字檔:先擋掉偽裝成 .txt / .md 的二進位檔
  for (const sig of BINARY_SIGNATURES) {
    if (startsWith(head, sig.bytes)) return `內容看起來是${sig.name},不是文字檔`;
  }
  if (head.includes(0x00)) return '文字檔不可包含 NUL 位元組(內容看起來是二進位檔)';
  if (!isValidUtf8(buf)) return '文字檔必須是有效的 UTF-8 編碼';
  if (ext === '.json') {
    try { JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, '')); } catch { return '內容不是有效的 JSON 格式(副檔名與實際內容不符)'; }
  }
  return null;
}

// ---------- 縮圖 ----------
// 測試與純 node 環境沒有 electron,取不到就安靜略過,附件本身照常可用
function nativeImage(): typeof import('electron').nativeImage | null {
  try { return require('electron').nativeImage || null; } catch { return null; }
}

function writeThumb(dir: string, id: string, absPath: string, kind: string) {
  if (kind !== 'image') return null;
  const ni = nativeImage();
  if (!ni) return null;
  try {
    const img = ni.createFromPath(absPath); // GIF 取靜態首幀
    if (!img || img.isEmpty()) return null;
    const { width, height } = img.getSize();
    if (!width || !height) return null;
    const scale = Math.min(1, THUMB_MAX / Math.max(width, height));
    const resized = scale < 1
      ? img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' })
      : img;
    const thumbsDir = path.join(dir, 'thumbs');
    ensureManagedDir(thumbsDir);
    const file = path.join(thumbsDir, `${id}.png`);
    fs.writeFileSync(file, resized.toPNG());
    return `thumbs/${id}.png`;
  } catch {
    return null; // 縮圖只是體驗,失敗不該讓附件整個加不進來
  }
}

// ---------- 新增 ----------
function readSource(item: AttachmentSource | null | undefined): Buffer {
  if (item && item.data != null) {
    const data = item.data;
    const size = Buffer.isBuffer(data) || data instanceof Uint8Array || data instanceof ArrayBuffer ? data.byteLength : 0;
    if (size > LIMITS.maxFileBytes) throw new Error(`超過單檔上限 ${formatBytes(LIMITS.maxFileBytes)}(這個檔 ${formatBytes(size)})`);
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    throw new Error('附件內容格式無法辨識');
  }
  if (item && typeof item.path === 'string' && item.path) {
    const stat = fs.statSync(item.path);
    if (!stat.isFile()) throw new Error('不是一般檔案');
    // 先看 stat 再讀檔:20 MB 的上限不該靠「先整個讀進記憶體」才發現
    if (stat.size > LIMITS.maxFileBytes) throw new Error(`超過單檔上限 ${formatBytes(LIMITS.maxFileBytes)}(這個檔 ${formatBytes(stat.size)})`);
    return fs.readFileSync(item.path);
  }
  throw new Error('缺少檔案內容或路徑');
}

function formatBytes(n: number) {
  if (!Number.isFinite(n)) return '未知大小';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// items: [{ name, path? , data? }]
// 回傳 { added: [metadata], errors: [{ name, error }] };單一檔案不合規只擋那一個,不整批失敗
function addAttachments(
  userDataDir: string,
  conversationId: string,
  items: unknown,
  { existingCount = 0, existingBytes = 0 }: { existingCount?: number; existingBytes?: number } = {},
): { added: AttachmentMeta[]; errors: Array<{ name: string; error: string }> } {
  const dir = conversationDir(userDataDir, conversationId);
  if (!dir) return { added: [], errors: [{ name: '', error: '無效的對話代號' }] };
  const list: Array<AttachmentSource | null> = Array.isArray(items) ? items : [];
  const added: AttachmentMeta[] = [];
  const errors: Array<{ name: string; error: string }> = [];
  let count = Math.max(0, existingCount);
  let total = Math.max(0, existingBytes);

  for (const item of list) {
    const name = sanitizeOriginalName((item && item.name) || (item && item.path && path.basename(item.path)) || '未命名檔案');
    try {
      if (count >= LIMITS.maxFiles) throw new Error(`一次最多 ${LIMITS.maxFiles} 個檔案`);
      const ext = path.extname(name).toLowerCase();
      const type = TYPES[ext];
      if (!type) throw new Error(`不支援的檔案類型「${ext || '無副檔名'}」,目前只收 ${ALLOWED_EXTS.join('、')}`);

      const buf = readSource(item);
      if (buf.length === 0) throw new Error('檔案是空的');
      if (buf.length > LIMITS.maxFileBytes) throw new Error(`超過單檔上限 ${formatBytes(LIMITS.maxFileBytes)}(這個檔 ${formatBytes(buf.length)})`);
      if (total + buf.length > LIMITS.maxTotalBytes) throw new Error(`超過單次合計上限 ${formatBytes(LIMITS.maxTotalBytes)}`);

      const bad = verifyContent(buf, ext, type);
      if (bad) throw new Error(bad);

      const id = crypto.randomUUID();
      const file = storedName(id, name, ext);
      const abs = resolveInDir(dir, file);
      if (!abs) throw new Error('無法產生安全的儲存檔名');
      ensureManagedDir(attachmentsRoot(userDataDir));
      ensureManagedDir(dir);
      if (lstat(abs)) throw new Error('附件儲存路徑已存在');
      fs.writeFileSync(abs, buf);

      const meta: AttachmentMeta = {
        id,
        name,
        mime: type.mime,
        kind: type.kind,
        size: buf.length,
        relPath: `${conversationId}/${file}`,
        thumb: writeThumb(dir, id, abs, type.kind),
      };
      added.push(meta);
      count++;
      total += buf.length;
    } catch (error) {
      errors.push({ name, error: errorMessage(error) });
    }
  }
  return { added, errors };
}

// ---------- 讀取與刪除 ----------
function absolutePath(userDataDir: string, meta: UntrustedMeta): string | null {
  if (!meta || typeof meta.relPath !== 'string') return null;
  const parts = meta.relPath.split('/');
  if (parts.length !== 2) return null;
  const dir = conversationDir(userDataDir, parts[0]);
  if (!dir) return null;
  const full = resolveInDir(dir, parts[1]);
  if (!full || !safeRegularFile(full)) return null;
  const rootStat = lstat(attachmentsRoot(userDataDir));
  const dirStat = lstat(dir);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
  if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null;
  return full;
}

function thumbPath(userDataDir: string, meta: UntrustedMeta): string | null {
  if (!meta || typeof meta.id !== 'string' || !ID_PATTERN.test(meta.id) || typeof meta.thumb !== 'string' || typeof meta.relPath !== 'string') return null;
  const rel = meta.thumb.split('/');
  const attachmentParts = meta.relPath.split('/');
  if (rel.length !== 2 || rel[0] !== 'thumbs' || rel[1] !== `${meta.id}.png` || attachmentParts.length !== 2) return null;
  const dir = conversationDir(userDataDir, attachmentParts[0]);
  if (!dir) return null;
  const thumbsDir = path.join(dir, 'thumbs');
  const file = resolveInDir(thumbsDir, rel[1]);
  const rootStat = lstat(attachmentsRoot(userDataDir));
  const dirStat = lstat(dir);
  const thumbsStat = lstat(thumbsDir);
  if (!file || !safeRegularFile(file) || !rootStat || rootStat.isSymbolicLink()
    || !dirStat || dirStat.isSymbolicLink()
    || !thumbsStat || thumbsStat.isSymbolicLink()) return null;
  return file;
}

function removeAttachment(userDataDir: string, meta: UntrustedMeta): Result {
  const abs = absolutePath(userDataDir, meta);
  if (!abs) return { ok: false, error: '無效的附件' };
  try {
    fs.rmSync(abs, { force: true });
    if (meta?.thumb) {
      const thumb = thumbPath(userDataDir, meta);
      if (thumb) fs.rmSync(thumb, { force: true });
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

// 縮圖以 data URL 回傳:CSP 是 img-src 'self' data:,不需要為了顯示本機圖放寬成 file:
function thumbDataUrl(userDataDir: string, meta: UntrustedMeta): string | null {
  const file = thumbPath(userDataDir, meta);
  if (!file) return null;
  try {
    return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
  } catch {
    return null;
  }
}

function deleteConversation(userDataDir: string, conversationId: unknown): Result {
  const dir = conversationDir(userDataDir, conversationId);
  if (!dir) return { ok: false, error: '無效的對話代號' };
  try {
    const rootStat = lstat(attachmentsRoot(userDataDir));
    if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { ok: false, error: '附件目錄不安全' };
    const dirStat = lstat(dir);
    if (dirStat && dirStat.isSymbolicLink()) {
      fs.unlinkSync(dir);
      return { ok: true };
    }
    if (dirStat === false) return { ok: false, error: '無法檢查附件目錄' };
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

// 只清「從未成功寫入 session 的暫存對話」:已存檔的附件不因時間自動刪除(產品拍板)。
// keepIds 由呼叫端從 session 紀錄掃出來,activeId 是目前進行中的對話。
function cleanupOrphans(
  userDataDir: string,
  { keepIds = [], activeId = null, graceMs = ORPHAN_GRACE_MS, now = Date.now() }: { keepIds?: string[]; activeId?: string | null; graceMs?: number; now?: number } = {},
): { removed: string[]; error?: string } {
  const root = attachmentsRoot(userDataDir);
  const keep = new Set([...keepIds, activeId].filter(Boolean));
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try {
    const rootStat = lstat(root);
    if (rootStat === false) return { removed, error: '無法檢查附件目錄' };
    if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) return { removed, error: '附件目錄不安全' };
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { removed } : { removed, error: errorMessage(error) };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || keep.has(entry.name)) continue;
    const dir = resolveInDir(root, entry.name);
    if (!dir) continue;
    try {
      // 還在寬限期內的可能是使用者剛拖進來、還沒送出的附件,不能清
      if (now - fs.statSync(dir).mtimeMs < graceMs) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(entry.name);
    } catch {}
  }
  return { removed };
}

// ---------- 沙箱 CLI 的工作目錄暫存 ----------
// 只有 adapter 宣告 attachmentsNeedCwd 時才會用到;回合結束一定要呼叫 clearRuntime。
function runtimeRoot(workDir: string) { return path.join(workDir, RUNTIME_DIR); }

function stageToCwd(
  userDataDir: string,
  conversationId: string,
  workDir: string | null | undefined,
  attachments: AttachmentMeta[],
): { staged: StagedAttachment[]; error?: string } {
  const list = Array.isArray(attachments) ? attachments : [];
  if (!workDir || list.length === 0) return { staged: [] };
  const dir = resolveInDir(runtimeRoot(workDir), conversationId);
  if (!dir) return { staged: [], error: '無效的對話代號' };
  const staged: StagedAttachment[] = [];
  try {
    ensureManagedDir(runtimeRoot(workDir));
    ensureManagedDir(dir);
    for (const meta of list) {
      const src = absolutePath(userDataDir, meta);
      if (!src) continue;
      const dest = resolveInDir(dir, path.basename(meta.relPath || ''));
      if (!dest) continue;
      const destStat = lstat(dest);
      if (destStat === false || (destStat && (destStat.isSymbolicLink() || !destStat.isFile()))) throw new Error('附件暫存路徑不安全');
      fs.copyFileSync(src, dest);
      staged.push({ ...meta, cwdPath: dest });
    }
  } catch (error) {
    return { staged, error: errorMessage(error) };
  }
  return { staged };
}

// 一併清掉空的 .roundtable-runtime,不在使用者的 repo 裡留下痕跡
function clearRuntime(workDir: string | null | undefined, conversationId: string | null = null): Result {
  if (!workDir) return { ok: true };
  const root = runtimeRoot(workDir);
  try {
    const rootStat = lstat(root);
    if (rootStat === false) return { ok: false, error: '無法檢查附件暫存目錄' };
    if (!rootStat) return { ok: true };
    if (rootStat.isSymbolicLink()) {
      fs.unlinkSync(root); // 只移除連結本身,絕不沿著它刪除外部目錄
      return { ok: true };
    }
    if (conversationId) {
      const dir = resolveInDir(root, conversationId);
      if (dir) {
        const dirStat = lstat(dir);
        if (dirStat && dirStat.isSymbolicLink()) fs.unlinkSync(dir);
        else if (dirStat === false) return { ok: false, error: '無法檢查附件暫存目錄' };
        else fs.rmSync(dir, { recursive: true, force: true });
      }
      const rest = fs.readdirSync(root);
      if (rest.length === 0) fs.rmSync(root, { recursive: true, force: true });
    } else {
      fs.rmSync(root, { recursive: true, force: true });
    }
    return { ok: true };
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { ok: true } : { ok: false, error: errorMessage(error) };
  }
}

// ---------- 提示詞組裝 ----------
// adapter 的 capabilities 由 Codex 那條線加進 spec/registry;這裡讀不到就依既有欄位推斷,
// 兩邊可以獨立合併,不必等對方先落地。
function attachmentCapabilities(adapter: Pick<Adapter, 'capabilities' | 'supportsEdit'> | null | undefined) {
  const caps: Partial<AdapterCapabilities> = (adapter && adapter.capabilities) || {};
  const list = Array.isArray(caps.attachments) ? caps.attachments.filter((c) => typeof c === 'string') : null;
  if (list) return { modes: new Set(list), needCwd: !!caps.attachmentsNeedCwd };
  // 退路:能改檔案的多半是本機 CLI,讀得到絕對路徑;其餘只當作能吃純文字
  const fallback = adapter && adapter.supportsEdit ? ['filePath', 'textInline'] : ['textInline'];
  return { modes: new Set(fallback), needCwd: false };
}

function readTextForInline(userDataDir: string, meta: AttachmentMeta, maxChars = TEXT_INLINE_MAX_CHARS) {
  const abs = absolutePath(userDataDir, meta);
  if (!abs) return null;
  try {
    const text = fs.readFileSync(abs, 'utf8');
    return text.length > maxChars
      ? `${text.slice(0, maxChars)}\n…(檔案過長或已達附件總量上限,已截斷;完整內容見原始檔案)…`
      : text;
  } catch {
    return null;
  }
}

// 依 adapter 能力把附件組成提示詞片段。
// filePath  → 給絕對路徑,讓有讀檔能力的 CLI 自己去讀(最省 token,也最不失真)
// textInline→ 直接內嵌文字內容
// imageInline→ 只列出清單,實際影像由 adapter 從 ctx.attachments 取用
// 都不支援  → 退成檔名清單,並明講模型看不到內容,避免它憑檔名編造
function buildAttachmentPrompt(
  userDataDir: string,
  attachments: AttachmentMeta[],
  adapter: Pick<Adapter, 'capabilities' | 'supportsEdit'> | null | undefined,
  { staged = [] }: { staged?: StagedAttachment[] } = {},
) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) return '';
  const { modes, needCwd } = attachmentCapabilities(adapter);
  const cwdPaths = new Map(staged.map((s) => [s.id, s.cwdPath]));
  const lines: string[] = [];
  const inlines: string[] = [];
  const unreadable: string[] = [];
  let inlineRemaining = TEXT_INLINE_TOTAL_MAX_CHARS;

  for (const meta of list) {
    const label = `${meta.name}(${meta.mime}, ${formatBytes(meta.size)})`;
    // needCwd 代表 adapter 明確讀不到 userData;暫存失敗時不可假裝絕對路徑可用。
    const abs = needCwd ? cwdPaths.get(meta.id) : absolutePath(userDataDir, meta);
    if (modes.has('filePath') && abs) {
      lines.push(`- ${label}\n  路徑:${abs}`);
      continue;
    }
    if (meta.kind === 'image' && modes.has('imageInline')) {
      lines.push(`- ${label}(影像已隨訊息附上)`);
      continue;
    }
    if (meta.kind === 'text' && modes.has('textInline')) {
      const allowance = Math.min(TEXT_INLINE_MAX_CHARS, inlineRemaining);
      const text = allowance > 0 ? readTextForInline(userDataDir, meta, allowance) : null;
      if (text != null) {
        lines.push(`- ${label}(內容如下)`);
        inlines.push(`--- ${meta.name} ---\n${text}`);
        inlineRemaining = Math.max(0, inlineRemaining - Math.min(text.length, allowance));
        continue;
      }
      if (allowance === 0) {
        lines.push(`- ${label}(已達文字附件總內嵌上限,內容省略)`);
        continue;
      }
    }
    lines.push(`- ${label}`);
    unreadable.push(meta.name);
  }

  const parts = [`【附件】使用者提供了 ${list.length} 個附件:`, lines.join('\n')];
  if (inlines.length) parts.push(inlines.join('\n\n'));
  if (unreadable.length) {
    parts.push(`注意:你無法讀取 ${unreadable.join('、')} 的內容,請不要憑檔名臆測,必要時請在回覆中說明。`);
  }
  return parts.join('\n\n');
}

export { LIMITS, RUNTIME_DIR, ALLOWED_EXTS, newConversationId, conversationDir, resolveInDir, addAttachments, removeAttachment, absolutePath, thumbDataUrl, deleteConversation, cleanupOrphans, stageToCwd, clearRuntime, attachmentCapabilities, buildAttachmentPrompt, formatBytes };
