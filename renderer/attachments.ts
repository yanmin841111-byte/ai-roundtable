// Composer 附件管理(拖放、選擇檔案、縮圖、限制與錯誤提示)。
import { t } from './i18n';
import { icon } from './icons';
import { $, escapeHtml, cleanIpcError, cssEscape } from './util';
import type { AttachLimits, AttachmentInput, AttachmentMeta, AttachmentsResult, PendingAttachment, RendererApi } from './api';

export interface AttachmentsOptions {
  isSwitchingJobs: () => boolean;
  shownJobId: () => string | null;
  onChanged: () => void;
}

const ATTACH_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'txt', 'md', 'json', 'csv', 'log', 'pdf']);
const ATTACH_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

export const pendingAttachments: PendingAttachment[] = [];
const attachLimits: AttachLimits = { maxFiles: 10, maxFileBytes: 20 * 1024 * 1024, maxTotalBytes: 50 * 1024 * 1024 };
let opts: AttachmentsOptions | null = null;

function attachmentsApi(): RendererApi['attachments'] | null {
  return (window.api && window.api.attachments) || null;
}

function applyAttachLimits(limits: unknown): void {
  if (!limits || typeof limits !== 'object') return;
  const raw = limits as Partial<AttachLimits>;
  const maxFiles = Number(raw.maxFiles);
  const maxFileBytes = Number(raw.maxFileBytes);
  const maxTotalBytes = Number(raw.maxTotalBytes);
  if (Number.isFinite(maxFiles) && maxFiles > 0) attachLimits.maxFiles = maxFiles;
  if (Number.isFinite(maxFileBytes) && maxFileBytes > 0) attachLimits.maxFileBytes = maxFileBytes;
  if (Number.isFinite(maxTotalBytes) && maxTotalBytes > 0) attachLimits.maxTotalBytes = maxTotalBytes;
}

export function setupComposerAttachments(options: AttachmentsOptions): void {
  opts = options;
  const box = document.querySelector<HTMLElement>('.composer-box');
  const bar = document.querySelector<HTMLElement>('.composer-bar');
  if (!box || !bar || $<HTMLButtonElement>('#attach-btn')) return;

  const hint = document.createElement('div');
  hint.className = 'composer-drop-hint';
  hint.textContent = t('composer.dropHint');
  box.prepend(hint);

  const chips = document.createElement('div');
  chips.id = 'attach-chips';
  chips.className = 'attach-chips';
  chips.setAttribute('aria-live', 'polite');
  const error = document.createElement('div');
  error.id = 'attach-error';
  error.className = 'attach-error';
  error.setAttribute('role', 'alert');
  const input = $<HTMLTextAreaElement>('#input');
  input.after(chips);
  chips.after(error);

  const button = document.createElement('button');
  button.id = 'attach-btn';
  button.type = 'button';
  button.className = 'ghost small icon';
  button.title = t('composer.attach');
  button.setAttribute('aria-label', t('composer.attach'));
  button.appendChild(icon('attach'));
  button.onclick = () => { void pickAttachments(); };
  bar.insertBefore(button, bar.querySelector<HTMLElement>('.spacer'));

  const api = attachmentsApi();
  if (!api || typeof api.pick !== 'function') {
    const fileInput = document.createElement('input');
    fileInput.id = 'attach-input';
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.hidden = true;
    fileInput.accept = '.png,.jpg,.jpeg,.webp,.gif,.txt,.md,.json,.csv,.log,.pdf';
    fileInput.addEventListener('change', async () => {
      await addAttachmentFiles(fileInput.files);
      fileInput.value = '';
    });
    box.appendChild(fileInput);
  }

  box.addEventListener('dragenter', (event) => { if (isFileDrag(event)) { event.preventDefault(); box.classList.add('dragover'); } });
  box.addEventListener('dragover', (event) => { if (isFileDrag(event)) { event.preventDefault(); box.classList.add('dragover'); } });
  box.addEventListener('dragleave', (event) => { if (!(event.relatedTarget instanceof Node) || !box.contains(event.relatedTarget)) box.classList.remove('dragover'); });
  box.addEventListener('drop', async (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    box.classList.remove('dragover');
    await addAttachmentFiles(event.dataTransfer?.files);
  });
  void syncPendingAttachments();
}

export function attachmentsMarkup(list: AttachmentMeta[] | undefined): string {
  if (!Array.isArray(list) || !list.length) return '';
  return `<div class="msg-attachments">${list.map((item) => attachmentChipMarkup(item, false)).join('')}</div>`;
}

function attachmentChipMarkup(item: AttachmentMeta | PendingAttachment, removable: boolean): string {
  const kind = item.kind || kindFromName(item.name, item.mime);
  const isImage = kind === 'image' || kind === 'imageInline';
  const thumb = item.thumbUrl
    ? `<img class="attach-thumb" alt="" src="${escapeHtml(item.thumbUrl)}">`
    : `<span class="attach-thumb file">${isImage ? '🖼' : '📄'}</span>`;
  const remove = removable
    ? `<button type="button" class="ghost small icon attach-remove" data-attach-id="${escapeHtml(item.id)}" title="${escapeHtml(t('attach.remove'))}" aria-label="${escapeHtml(t('attach.removeNamed', { name: item.name }))}">✕</button>`
    : '';
  return `<div class="attach-chip" data-attach-id="${escapeHtml(item.id || '')}">${thumb}<span class="attach-meta"><span class="attach-name" title="${escapeHtml(item.name || '')}">${escapeHtml(item.name || t('attach.unnamed'))}</span><span class="attach-size">${escapeHtml(formatBytes(item.size))}</span></span>${remove}</div>`;
}

export function hydrateAttachmentThumbs(root: HTMLElement | null, list: Array<AttachmentMeta | PendingAttachment> | undefined): void {
  if (!root || !Array.isArray(list)) return;
  for (const raw of list) {
    const item = normalizeAttachment(raw);
    if (!item.id) continue;
    const img = root.querySelector(`.attach-chip[data-attach-id="${cssEscape(item.id)}"] img.attach-thumb`);
    if (img && img.getAttribute('src')) continue;
    loadAttachmentThumb(item).then((url) => {
      if (!url) return;
      const chip = root.querySelector(`.attach-chip[data-attach-id="${cssEscape(item.id)}"]`);
      if (!chip) return;
      const current = chip.querySelector('.attach-thumb');
      const next = document.createElement('img');
      next.className = 'attach-thumb';
      next.alt = '';
      next.src = url;
      if (current) current.replaceWith(next);
    }).catch(() => {});
  }
}

function isFileDrag(event: DragEvent): boolean {
  return !!(event.dataTransfer && [...event.dataTransfer.types].includes('Files'));
}

export async function syncPendingAttachments(): Promise<void> {
  const currentOwner = opts ? opts.shownJobId() : null;
  const api = attachmentsApi();
  if (!api || typeof api.list !== 'function') return;
  try {
    const result = await api.list();
    if (currentOwner === (opts ? opts.shownJobId() : null) && currentOwner === window.api.jobs.current()) {
      applyPendingFromResult(result, { keepError: true });
    }
  } catch {}
}

async function pickAttachments(): Promise<void> {
  if (opts?.isSwitchingJobs()) return;
  const owner = opts ? opts.shownJobId() : null;
  const api = attachmentsApi();
  if (api && typeof api.pick === 'function') {
    try {
      const result = await api.pick();
      if (owner === (opts ? opts.shownJobId() : null) && owner === window.api.jobs.current()) applyPendingFromResult(result);
    } catch (error) {
      if (owner === (opts ? opts.shownJobId() : null) && owner === window.api.jobs.current()) {
        showAttachError(formatAttachError('', cleanIpcError(error)));
      }
    }
    return;
  }
  const input = $<HTMLInputElement>('#attach-input');
  if (input) input.click();
}

function applyPendingFromResult(result: AttachmentsResult | null | undefined, { keepError = false }: { keepError?: boolean } = {}): void {
  if (!result) return;
  applyAttachLimits(result.limits);
  if (Array.isArray(result.attachments)) {
    pendingAttachments.splice(0, pendingAttachments.length, ...result.attachments.map((item) => normalizeAttachment(item)));
  } else if (Array.isArray(result.added)) {
    for (const item of result.added) pendingAttachments.push(normalizeAttachment(item));
  }
  renderAttachChips();
  if (result.canceled) return;
  const errors = Array.isArray(result.errors) ? result.errors : [];
  if (errors.length) {
    showAttachError(formatAttachResultError(errors[0]));
  } else if (!keepError) {
    clearAttachError();
  }
}

async function addAttachmentFiles(fileList: FileList | null | undefined): Promise<void> {
  if (opts?.isSwitchingJobs()) return;
  const owner = opts ? opts.shownJobId() : null;
  const files = [...(fileList || [])].filter(Boolean);
  if (!files.length) return;
  const api = attachmentsApi();
  if (api && typeof api.add === 'function') {
    try {
      const items = [];
      for (const file of files) {
        items.push(await fileToAddItem(file, api));
      }
      if (owner !== (opts ? opts.shownJobId() : null) || owner !== window.api.jobs.current()) return;
      const result = await api.add(items);
      if (owner === (opts ? opts.shownJobId() : null) && owner === window.api.jobs.current()) applyPendingFromResult(result);
    } catch (error) {
      if (owner !== (opts ? opts.shownJobId() : null) || owner !== window.api.jobs.current()) return;
      const names = files.map((file) => file && file.name).filter(Boolean);
      showAttachError(formatAttachError(names[0] || '', cleanIpcError(error)));
    }
    return;
  }
  const errors = [];
  let total = pendingAttachments.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
  for (const file of files) {
    const name = file.name || t('attach.unnamedFile');
    const ext = extensionOf(name);
    const size = Number(file.size) || 0;
    if (pendingAttachments.length >= attachLimits.maxFiles) {
      errors.push(formatAttachError(name, t('attach.tooMany', { n: attachLimits.maxFiles })));
      continue;
    }
    if (!ATTACH_EXTS.has(ext)) {
      errors.push(formatAttachError(name, t('attach.unsupported')));
      continue;
    }
    if (size > attachLimits.maxFileBytes) {
      errors.push(formatAttachError(name, t('attach.tooLarge', { size: formatBytes(attachLimits.maxFileBytes) })));
      continue;
    }
    if (total + size > attachLimits.maxTotalBytes) {
      errors.push(formatAttachError(name, t('attach.totalTooLarge', { size: formatBytes(attachLimits.maxTotalBytes) })));
      continue;
    }
    const mismatch = mimeConflictsWithName(name, file.type);
    if (mismatch) {
      errors.push(formatAttachError(name, mismatch));
      continue;
    }
    try {
      const added = await storeAttachmentStub(file);
      pendingAttachments.push(added);
      total += added.size || size;
    } catch (error) {
      errors.push(formatAttachError(name, cleanIpcError(error)));
    }
  }
  renderAttachChips();
  if (errors.length) showAttachError(errors[0]);
  else clearAttachError();
}

async function fileToAddItem(file: File, api: RendererApi['attachments']): Promise<AttachmentInput> {
  const name = file.name || t('attach.unnamed');
  const filePath = typeof api.pathForFile === 'function' ? String(api.pathForFile(file) || '') : '';
  if (filePath) return { name, path: filePath };
  const data = await file.arrayBuffer();
  return { name, data };
}

async function storeAttachmentStub(file: File): Promise<PendingAttachment> {
  const id = (crypto.randomUUID && crypto.randomUUID()) || `att-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const item = normalizeAttachment({
    id,
    name: file.name,
    mime: file.type || mimeFromName(file.name),
    size: file.size,
    kind: kindFromName(file.name, file.type),
    file,
  }, file);
  if (item.kind === 'image' && file instanceof Blob) item.thumbUrl = await readFileDataUrl(file);
  return item;
}

function normalizeAttachment(item: Partial<PendingAttachment> & { type?: string } | null | undefined, file?: File): PendingAttachment {
  const src = item || {};
  const name = src.name || (file && file.name) || t('attach.unnamed');
  const mime = src.mime || src.type || (file && file.type) || mimeFromName(name);
  const kind = src.kind || kindFromName(name, mime);
  return {
    id: src.id || '',
    name,
    mime,
    size: Number(src.size != null ? src.size : file && file.size) || 0,
    kind,
    path: src.path || null,
    relPath: src.relPath || null,
    thumb: src.thumb || null,
    thumbUrl: src.thumbUrl || null,
    file: src.file || file || null,
  };
}

export function renderAttachChips(): void {
  const row = $<HTMLDivElement>('#attach-chips');
  const button = $<HTMLButtonElement>('#attach-btn');
  if (!row) return;
  row.innerHTML = pendingAttachments.map((item) => attachmentChipMarkup(item, true)).join('');
  row.querySelectorAll<HTMLButtonElement>('.attach-remove').forEach((btn) => {
    btn.onclick = () => { void removePendingAttachment(btn.dataset.attachId); };
  });
  if (button) button.disabled = pendingAttachments.length >= attachLimits.maxFiles;
  hydrateAttachmentThumbs(row, pendingAttachments);
  opts?.onChanged();
}

async function removePendingAttachment(id: string | undefined): Promise<void> {
  const index = pendingAttachments.findIndex((item) => item.id === id);
  if (index < 0) return;
  const [item] = pendingAttachments.splice(index, 1);
  await forgetAttachments([item]);
  renderAttachChips();
  clearAttachError();
}

export async function clearPendingAttachments(): Promise<void> {
  const items = pendingAttachments.splice(0, pendingAttachments.length);
  await forgetAttachments(items);
  renderAttachChips();
  clearAttachError();
}

export function revokeThumbUrls(items: PendingAttachment[] | undefined): void {
  for (const item of items || []) {
    if (item.thumbUrl && String(item.thumbUrl).startsWith('blob:')) URL.revokeObjectURL(item.thumbUrl);
  }
}

async function forgetAttachments(items: PendingAttachment[] | undefined): Promise<void> {
  revokeThumbUrls(items);
  const api = attachmentsApi();
  if (!api || typeof api.remove !== 'function') return;
  for (const item of items || []) {
    if (!item.id) continue;
    try { await api.remove(item.id); } catch {}
  }
}

async function loadAttachmentThumb(item: AttachmentMeta | PendingAttachment | null): Promise<string> {
  if (!item) return '';
  if (item.thumbUrl) return item.thumbUrl;
  const kind = item.kind || kindFromName(item.name, item.mime);
  if (kind !== 'image' && kind !== 'imageInline') return '';
  const api = attachmentsApi();
  if (api && typeof api.thumb === 'function' && (item.relPath || item.thumb || item.id)) {
    return (await api.thumb(item)) || '';
  }
  if (item.file instanceof Blob) return readFileDataUrl(item.file);
  return '';
}

function formatAttachResultError(entry: string | { name?: string; error?: string; message?: string } | null | undefined): string {
  if (entry == null) return formatAttachError('', '');
  if (typeof entry === 'string') return formatAttachError('', entry);
  return formatAttachError(entry.name || '', entry.error || entry.message || '');
}

function formatAttachError(name: string, reason: string): string {
  const file = String(name || '').trim();
  let detail = String(reason || '').trim();
  detail = detail.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const prefix = t('attach.cannotPrefix');
  if (file && (detail.includes(`「${file}」`) || detail.includes(`"${file}"`) || detail.startsWith(prefix))) return detail;
  if (file && detail) return t('attach.cannotReason', { name: file, reason: detail.replace(/^[:：,，]\s*/, '') });
  if (file) return t('attach.cannot', { name: file });
  if (detail) return detail.startsWith(prefix) ? detail : t('attach.cannotFile', { reason: detail });
  return t('attach.unknown');
}

function mimeConflictsWithName(name: string, mime: string): string {
  const type = String(mime || '').toLowerCase();
  if (!type || type === 'application/octet-stream') return '';
  const ext = extensionOf(name);
  if (!ATTACH_EXTS.has(ext)) return '';
  if (ATTACH_IMAGE_EXTS.has(ext)) {
    const expected = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : mimeFromName(name);
    return type === expected ? '' : t('attach.mismatch', { ext: ext.toUpperCase() });
  }
  if (ext === 'pdf') return type === 'application/pdf' ? '' : t('attach.mismatch', { ext: 'PDF' });
  if (type.startsWith('image/') || type === 'application/pdf' || /executable|zip|octet/.test(type)) {
    return t('attach.mismatch', { ext: ext.toUpperCase() });
  }
  return '';
}

export function showAttachError(message: string): void {
  const el = $<HTMLDivElement>('#attach-error');
  if (!el) return;
  el.textContent = message;
}

export function clearAttachError(): void {
  const el = $<HTMLDivElement>('#attach-error');
  if (el) el.textContent = '';
}

function extensionOf(name: string | undefined): string {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function kindFromName(name: string | undefined, mime?: string | null): string {
  const ext = extensionOf(name);
  if (ATTACH_IMAGE_EXTS.has(ext) || (mime && String(mime).startsWith('image/'))) return 'image';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  return 'text';
}

function mimeFromName(name: string | undefined): string {
  const ext = extensionOf(name);
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'json') return 'application/json';
  if (ext === 'csv') return 'text/csv';
  if (ext === 'md') return 'text/markdown';
  return 'text/plain';
}

function formatBytes(value: number | undefined): string {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function readFileDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error(t('attach.previewFailed')));
    reader.readAsDataURL(file);
  });
}
