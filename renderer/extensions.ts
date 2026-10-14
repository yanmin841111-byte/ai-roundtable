// 設定 → CLI 與擴充(本機 Ollama 一鍵連接、擴充清單、範本選擇器、擴充編輯器與金鑰測試)。
import { t } from './i18n';
import { controlLabel, icon } from './icons';
import { $, escapeHtml, cleanIpcError } from './util';
import { envFixHtml, bindEnvFix, describeCliHealth } from './env-fix';
import type { CliHealth, CliType, EnvFix, ExtSpec, ExtSummary, ExtTemplate } from './api';

export interface ExtensionsOptions {
  cliTypes: () => Record<string, CliType>;
  cliStatus: () => Record<string, CliHealth>;
  extSummary: () => ExtSummary;
  refreshCatalog: () => Promise<void>;
  showSettingsTab: (tab: string) => void;
}

const TIMEOUT_MAX_MINUTES = 600;
const PROVIDER_KEY_PAGES: Record<string, string> = {
  'api.deepseek.com': 'https://platform.deepseek.com/api_keys',
  'api.x.ai': 'https://console.x.ai/',
  'api.moonshot.cn': 'https://platform.moonshot.cn/console/api-keys',
  'api.moonshot.ai': 'https://platform.moonshot.ai/console/api-keys',
  'openrouter.ai': 'https://openrouter.ai/settings/keys',
};

let opts: ExtensionsOptions | null = null;
let editingExtFile: string | null = null;
let editingExtSpec: ExtSpec | null = null;
let extTemplateFilter = 'all';

// 內建的「自訂指令」轉接器 label 由主程序給中文,介面上依語言顯示;其他轉接器的 label 原樣用
export const cliLabel = (type: Partial<CliType> | undefined, fallback: string): string =>
  (type?.id === 'custom' && type.origin === 'builtin' ? t('adapter.custom') : type?.label || fallback);
export const typeLabel = (type: string): string =>
  (['builtin', 'cli', 'openai', 'js'].includes(type) ? t(`type.${type}`) : type);

export function setupExtensions(options: ExtensionsOptions): void {
  opts = options;
  $<HTMLButtonElement>('#quick-detect').onclick = () => { void detectOllama(); };
  $<HTMLButtonElement>('#quick-apply').onclick = () => { void applyOllamaModel(); };
  $<HTMLButtonElement>('#ext-add').onclick = openTemplatePicker;
  $<HTMLButtonElement>('#ext-open-dir').onclick = () => { void window.api.ext.openDir(); };
  $<HTMLButtonElement>('#ext-reload').onclick = () => { void reloadExtensions(); };
  $<HTMLButtonElement>('#ext-docs').onclick = () => { void window.api.ext.openDocs(); };
  $<HTMLButtonElement>('#ext-editor-docs').onclick = () => { void window.api.ext.openDocs(); };
  $<HTMLButtonElement>('#ext-picker-close').onclick = () => $<HTMLDivElement>('#ext-picker').classList.add('hidden');
  $<HTMLButtonElement>('#ext-picker-local').onclick = () => {
    $('#ext-picker').classList.add('hidden');
    opts?.showSettingsTab('clis');
    $('#quick-ollama').scrollIntoView({ block: 'nearest' });
    $('#quick-detect').focus();
    void detectOllama();
  };
  const extFilterButtons = [...document.querySelectorAll<HTMLButtonElement>('.template-filters [data-filter]')];
  extFilterButtons.forEach((button, index) => {
    button.onclick = () => {
      extTemplateFilter = button.dataset.filter || 'all';
      extFilterButtons.forEach((item) => {
        const active = item === button;
        item.classList.toggle('active', active);
        item.setAttribute('aria-checked', String(active));
        item.tabIndex = active ? 0 : -1;
      });
      renderExtTemplates();
    };
    button.onkeydown = (event: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? extFilterButtons.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + extFilterButtons.length) % extFilterButtons.length;
      extFilterButtons[nextIndex].focus();
      extFilterButtons[nextIndex].click();
    };
  });
  $<HTMLInputElement>('#ext-search').addEventListener('input', renderExtTemplates);
  $<HTMLButtonElement>('#ext-editor-close').onclick = () => $<HTMLDivElement>('#ext-editor').classList.add('hidden');
  $<HTMLButtonElement>('#ext-cancel').onclick = () => $<HTMLDivElement>('#ext-editor').classList.add('hidden');
  $<HTMLButtonElement>('#ext-save').onclick = () => { void saveExtension(); };
  $<HTMLButtonElement>('#ext-delete').onclick = () => { void deleteExtension(); };
  $<HTMLButtonElement>('#ext-tab-basic').onclick = () => showExtEditorTab('basic');
  $<HTMLButtonElement>('#ext-tab-advanced').onclick = () => showExtEditorTab('advanced');
  $<HTMLButtonElement>('#ext-edit-args').onclick = () => { showExtEditorTab('advanced'); $('#ext-content').focus(); };
  $<HTMLButtonElement>('#ext-key-reveal').onclick = () => {
    const input = $<HTMLInputElement>('#ext-api-key');
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    const button = $('#ext-key-reveal');
    button.setAttribute('aria-pressed', String(reveal));
    controlLabel(button, reveal ? 'hide' : 'show', t(reveal ? 'extEditor.hideKey' : 'extEditor.showKey'));
  };
  $<HTMLButtonElement>('#ext-pick-bin').onclick = () => { void pickExtensionExecutable(); };
  $<HTMLButtonElement>('#ext-key-clear').onclick = () => { void clearExtensionSecret(); };
  $<HTMLButtonElement>('#ext-key-test').onclick = () => { void testExtensionConnection(); };
  $<HTMLButtonElement>('#ext-get-key').onclick = () => {
    const url = $('#ext-get-key').dataset.url;
    if (url) window.open(url, '_blank');
  };
  for (const id of ['#ext-id', '#ext-label', '#ext-type', '#ext-bin', '#ext-args', '#ext-base-url', '#ext-api-env', '#ext-models', '#ext-timeout']) {
    $(id).addEventListener('input', syncExtBasicToJson);
  }
  $<HTMLSelectElement>('#ext-type').addEventListener('change', () => {
    syncExtBasicToJson();
    $<HTMLDetailsElement>('#ext-connection-fields').open = true;
    void refreshExtensionSecretStatus();
  });
  $<HTMLTextAreaElement>('#ext-content').addEventListener('blur', () => {
    if (!editingExtFile || editingExtFile.endsWith('.js')) return;
    try { fillExtBasic(JSON.parse($<HTMLTextAreaElement>('#ext-content').value)); } catch {}
  });
  $<HTMLTextAreaElement>('#ext-content').addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void saveExtension(); }
  });
}

async function reloadExtensions(): Promise<void> {
  await window.api.ext.reload();
  if (opts) await opts.refreshCatalog();
}

// ---------- 一鍵連接本機模型(Ollama) ----------
// 有下一步時,狀態底下多一張和其他地方一樣的修復卡片(例如「在終端執行 ollama serve」)
function setQuickStatus(message: string, kind: 'ok' | 'warn' | 'error' | '' = '', fix?: EnvFix | null): void {
  const el = $<HTMLDivElement>('#quick-status');
  el.hidden = !message;
  el.innerHTML = `<div>${escapeHtml(message)}</div>${envFixHtml(fix)}`;
  el.className = `quick-status${kind ? ' ' + kind : ''}`;
  bindEnvFix(el);
}

export async function detectOllama(): Promise<void> {
  const btn = $<HTMLButtonElement>('#quick-detect');
  btn.disabled = true;
  $<HTMLDivElement>('#quick-pick').hidden = true;
  setQuickStatus(t('quick.detecting'));
  try {
    const r = await window.api.quickSetupOllama();
    if (!r.ok) {
      setQuickStatus(r.hint || t('quick.notFound'), 'warn', r.fix);
      return;
    }
    if (!r.models.length) {
      setQuickStatus(t('quick.noModels'), 'warn');
      return;
    }
    const select = $<HTMLSelectElement>('#quick-model');
    select.innerHTML = '';
    for (const m of r.models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.id;
      select.appendChild(opt);
    }
    if (r.recommendedModel) select.value = r.recommendedModel;
    $<HTMLDivElement>('#quick-pick').hidden = false;
    setQuickStatus(t('quick.found', { count: r.models.length }), 'ok');
  } catch (error) {
    setQuickStatus(`${t('quick.notFound')}\n${cleanIpcError(error)}`, 'warn');
  } finally {
    btn.disabled = false;
  }
}

async function applyOllamaModel(): Promise<void> {
  const btn = $<HTMLButtonElement>('#quick-apply');
  const model = $<HTMLSelectElement>('#quick-model').value;
  if (!model) return;
  btn.disabled = true;
  setQuickStatus(t('quick.applying'));
  try {
    const r = await window.api.quickSetupOllama(model);
    if (!r.installed) {
      setQuickStatus(r.hint || r.error || t('quick.failed'), 'error');
      return;
    }
    setQuickStatus(t('quick.done', { model: r.selectedModel || model }), 'ok');
    $<HTMLDivElement>('#quick-pick').hidden = true;
    await reloadExtensions();
  } catch (error) {
    setQuickStatus(`${t('quick.failed')}\n${cleanIpcError(error)}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

export function renderExtensions(): void {
  if (!opts) return;
  const list = $<HTMLDivElement>('#ext-list');
  if (!list) return;
  const cliTypes = opts.cliTypes();
  const cliStatus = opts.cliStatus();
  const extSummary = opts.extSummary();
  const rows = [];
  for (const type of Object.values(cliTypes)) {
    const st = cliStatus[type.id];
    const described = describeCliHealth(st, type);
    const dot = `<span class="status-dot ${described.tone}"></span>`;
    const sub = described.text;
    const subTitle = described.detail ? ` title="${escapeHtml(described.detail)}"` : '';
    const auth = envFixHtml(described.fix);
    const badges = [`<span class="badge">${escapeHtml(typeLabel(type.type))}</span>`];
    if (!type.supportsEdit) badges.push(`<span class="badge">${escapeHtml(t('ext.discussOnly'))}</span>`);
    const entry = extSummary.entries.find((e) => e.file === type.file);
    if (entry && entry.overrides) badges.push(`<span class="badge warn">${escapeHtml(t('ext.overrides'))}</span>`);
    const modelError = st?.state === 'missing' ? '' : type.modelError;
    if (modelError) badges.push(`<span class="badge warn">${escapeHtml(t('ext.modelListFailed'))}</span>`);
    rows.push({ file: type.file, html: `${dot}<div class="ext-main"><div class="ext-title"><b>${escapeHtml(cliLabel(type, type.id))}</b>${badges.join('')}</div><div class="ext-sub"${subTitle || ` title="${escapeHtml(sub || '')}"`}>${escapeHtml(sub || '')}</div>${auth}${modelError ? `<div class="ext-err">${escapeHtml(modelError)}</div>` : ''}</div>` });
  }
  for (const e of extSummary.entries.filter((x) => x.error)) {
    rows.push({ file: e.file, broken: true, html: `<span class="status-dot bad"></span><div class="ext-main"><div class="ext-title"><b>${escapeHtml(e.file)}</b><span class="badge bad">${escapeHtml(t('ext.loadFailed'))}</span></div><div class="ext-err">${escapeHtml(e.error)}</div></div>` });
  }
  list.innerHTML = '';
  for (const r of rows) {
    const el = document.createElement('div');
    el.className = `ext-item${r.file ? ' clickable' : ''}${r.broken ? ' broken' : ''}`;
    el.innerHTML = r.html;
    if (r.file) { const file = r.file; el.title = t('ext.clickToEdit', { file }); el.onclick = () => { void openExtEditor(file); }; }
    bindEnvFix(el);
    list.appendChild(el);
  }
}

function openTemplatePicker(): void {
  $<HTMLInputElement>('#ext-search').value = '';
  renderExtTemplates();
  $<HTMLDivElement>('#ext-picker').classList.remove('hidden');
}

export function renderExtTemplates(): void {
  if (!opts) return;
  const extSummary = opts.extSummary();
  const box = $<HTMLDivElement>('#ext-templates');
  box.innerHTML = '';
  const query = $<HTMLInputElement>('#ext-search').value.trim().toLocaleLowerCase();
  const templates = extSummary.templates.filter((template) => {
    const kind = template.type === 'cli' ? 'cli' : template.type === 'openai' ? 'api' : 'other';
    const matchesFilter = extTemplateFilter === 'all' || kind === extTemplateFilter;
    const haystack = `${template.label || ''} ${template.description || ''}`.toLocaleLowerCase();
    return matchesFilter && (!query || haystack.includes(query));
  });

  if (!templates.length) {
    box.innerHTML = `<div class="template-empty"><b>${escapeHtml(t('extPicker.noMatch'))}</b><span>${escapeHtml(t('extPicker.noMatchHint'))}</span></div>`;
    return;
  }

  const readyTemplates = templates.filter((template) => template.type === 'openai' && !template.file.startsWith('ollama-') && !isBlankTemplate(template));
  const advancedTemplates = templates.filter((template) => !readyTemplates.includes(template));
  appendTemplateGroup(box, t('extPicker.ready'), readyTemplates);
  if (advancedTemplates.length) {
    const advanced = document.createElement('details');
    advanced.className = 'ext-template-advanced';
    advanced.open = !!query || extTemplateFilter !== 'all';
    const summary = document.createElement('summary');
    summary.textContent = t('extPicker.custom');
    advanced.appendChild(summary);
    appendTemplateGroup(advanced, t('extPicker.other'), advancedTemplates.filter((template) => !isBlankTemplate(template)));
    appendTemplateGroup(advanced, t('extPicker.blank'), advancedTemplates.filter(isBlankTemplate));
    box.appendChild(advanced);
  }
}

function isBlankTemplate(template: ExtTemplate): boolean {
  return template.file.startsWith('blank-') || template.id.startsWith('my-');
}

function appendTemplateGroup(container: HTMLElement, title: string, templates: ExtTemplate[]): void {
  if (!templates.length) return;
  const section = document.createElement('section');
  section.className = 'template-group';
  const heading = document.createElement('div');
  heading.className = 'template-group-title';
  heading.textContent = title;
  const list = document.createElement('div');
  list.className = 'template-list';
  for (const tpl of templates) {
    const el = document.createElement('button');
    el.className = 'template';
    el.dataset.template = tpl.file;
    el.title = tpl.description;
    el.innerHTML = `<span class="row"><b>${escapeHtml(tpl.label)}</b></span><span class="hint">${escapeHtml(t(tpl.type === 'openai' ? 'extPicker.apiCredential' : 'extPicker.installedProgram'))}</span><span class="template-action">${escapeHtml(t('extPicker.use'))}</span>`;
    el.querySelector('.row')!.prepend(icon(tpl.type === 'openai' ? 'cloud' : 'terminal'));
    el.onclick = async () => {
      el.disabled = true;
      try {
        const { file } = await window.api.ext.install(tpl.file);
        $<HTMLDivElement>('#ext-picker').classList.add('hidden');
        if (opts) await opts.refreshCatalog();
        await openExtEditor(file);
      } catch (e) {
        el.disabled = false;
        alert(t('extPicker.installFailed', { reason: cleanIpcError(e) }));
      }
    };
    list.appendChild(el);
  }
  section.append(heading, list);
  container.appendChild(section);
}

async function openExtEditor(file: string): Promise<void> {
  try {
    const result = await window.api.ext.read(file);
    const content = typeof result === 'string' ? result : result.content;
    const migration = typeof result === 'object' && result ? result.migration : '';
    const migrationError = typeof result === 'object' && result ? result.migrationError : '';
    editingExtFile = file;
    $('#ext-editor-title').textContent = t('extEditor.title');
    $<HTMLInputElement>('#ext-file').value = file;
    $<HTMLTextAreaElement>('#ext-content').value = content;
    $<HTMLInputElement>('#ext-api-key').value = '';
    $<HTMLInputElement>('#ext-api-key').type = 'password';
    $('#ext-key-reveal').setAttribute('aria-pressed', 'false');
    controlLabel($('#ext-key-reveal'), 'show', t('extEditor.showKey'));
    $<HTMLDetailsElement>('#ext-extra-fields').open = false;
    $<HTMLDetailsElement>('#ext-file-settings').open = false;
    $<HTMLDetailsElement>('#ext-connection-fields').open = true;
    if (file.endsWith('.json')) {
      editingExtSpec = null;
      showExtEditorTab('basic');
      const spec = editingExtSpec as ExtSpec | null;
      $<HTMLDetailsElement>('#ext-connection-fields').open = !spec || spec.type !== 'openai' || !spec.baseUrl || spec.baseUrl.includes('api.example.com') || spec.models == null || (Array.isArray(spec.models) && !spec.models.length);
      if (spec?.label) $('#ext-editor-title').textContent = spec.label;
      await refreshExtensionSecretStatus();
    } else {
      editingExtSpec = null;
      showExtEditorTab('advanced');
    }
    if (migration && opts) await opts.refreshCatalog();
    const entry = opts?.extSummary().entries.find((e) => e.file === file);
    showExtResult(migrationError || (migration ? null : entry && entry.error), migration || null);
    $<HTMLDivElement>('#ext-editor').classList.remove('hidden');
  } catch (e) { alert(t('extEditor.openFailed', { reason: cleanIpcError(e) })); }
}

function showExtEditorTab(tab: string): void {
  if (tab === 'basic' && editingExtFile && editingExtFile.endsWith('.js')) tab = 'advanced';
  if (tab === 'basic') {
    try {
      editingExtSpec = JSON.parse($<HTMLTextAreaElement>('#ext-content').value);
      fillExtBasic(editingExtSpec);
    } catch (e) {
      showExtResult(t('extEditor.jsonError', { reason: (e as Error).message }), null);
      tab = 'advanced';
    }
  }
  const basic = tab === 'basic';
  $<HTMLDivElement>('#ext-basic').hidden = !basic;
  $<HTMLDivElement>('#ext-advanced').hidden = basic;
  $<HTMLDetailsElement>('#ext-file-settings').open = !basic;
  $<HTMLButtonElement>('#ext-tab-basic').classList.toggle('active', basic);
  $<HTMLButtonElement>('#ext-tab-advanced').classList.toggle('active', !basic);
  $<HTMLButtonElement>('#ext-tab-basic').setAttribute('aria-selected', String(basic));
  $<HTMLButtonElement>('#ext-tab-advanced').setAttribute('aria-selected', String(!basic));
  $<HTMLButtonElement>('#ext-tab-basic').disabled = !!(editingExtFile && editingExtFile.endsWith('.js'));
}

function fillExtBasic(spec: ExtSpec | null | undefined): void {
  const isJson = !!spec && typeof spec === 'object' && !Array.isArray(spec);
  $<HTMLDivElement>('#ext-basic-unavailable').hidden = isJson;
  $<HTMLDivElement>('#ext-basic-fields').hidden = !isJson;
  if (!isJson) return;
  $<HTMLInputElement>('#ext-id').value = spec.id || '';
  $<HTMLInputElement>('#ext-label').value = spec.label || '';
  $<HTMLSelectElement>('#ext-type').value = spec.type === 'openai' ? 'openai' : 'cli';
  $<HTMLInputElement>('#ext-bin').value = spec.bin || '';
  const simpleArgs = Array.isArray(spec.args) && spec.args.every((arg) => typeof arg === 'string');
  $<HTMLTextAreaElement>('#ext-args').disabled = Array.isArray(spec.args) && !simpleArgs;
  $<HTMLTextAreaElement>('#ext-args').value = simpleArgs ? (spec.args as string[]).join('\n') : '';
  const structuredArgs = $<HTMLTextAreaElement>('#ext-args').disabled;
  $('#ext-simple-args').hidden = structuredArgs;
  $('#ext-structured-args').hidden = !structuredArgs;
  $<HTMLInputElement>('#ext-base-url').value = spec.baseUrl || '';
  $<HTMLInputElement>('#ext-api-env').value = spec.apiKeyEnv || '';
  $<HTMLInputElement>('#ext-models').disabled = false;
  $<HTMLInputElement>('#ext-models').dataset.original = JSON.stringify(spec.models == null ? [] : spec.models);
  $<HTMLInputElement>('#ext-models').value = spec.models === 'auto' ? 'auto' : Array.isArray(spec.models) ? spec.models.map((model) => typeof model === 'string' ? model : model.id).filter(Boolean).join(', ') : '';
  $('#ext-models-help').textContent = Array.isArray(spec.models) && spec.models.some((model) => model && typeof model === 'object') ? t('extEditor.modelsKept') : '';
  const timeout = typeof spec.timeoutMs === 'number' && spec.timeoutMs > 0 ? spec.timeoutMs / 60000 : 0;
  const timeoutField = $<HTMLInputElement>('#ext-timeout');
  timeoutField.value = timeout ? String(Math.round(timeout * 10) / 10) : '';
  timeoutField.dataset.shown = timeoutField.value;
  updateExtTypeFields();
}

function updateExtTypeFields(): void {
  const api = $<HTMLSelectElement>('#ext-type').value === 'openai';
  $<HTMLDivElement>('#ext-cli-fields').hidden = api;
  $<HTMLDivElement>('#ext-api-fields').hidden = !api;
  $<HTMLDivElement>('#ext-cli-options').hidden = api;
  $<HTMLDivElement>('#ext-api-options').hidden = !api;
  $('#ext-url-field').hidden = !api;
  const keyPage = $('#ext-get-key');
  let url = '';
  try { url = PROVIDER_KEY_PAGES[new URL($<HTMLInputElement>('#ext-base-url').value).hostname] || ''; } catch {}
  keyPage.dataset.url = url;
  keyPage.hidden = !api || !url;
}

function syncExtBasicToJson(): void {
  if (!editingExtFile || editingExtFile.endsWith('.js')) return;
  let spec;
  try { spec = JSON.parse($<HTMLTextAreaElement>('#ext-content').value); } catch { spec = editingExtSpec || {}; }
  spec.id = $<HTMLInputElement>('#ext-id').value.trim();
  spec.label = $<HTMLInputElement>('#ext-label').value.trim();
  spec.type = $<HTMLSelectElement>('#ext-type').value;
  if (!$<HTMLTextAreaElement>('#ext-args').disabled) spec.args = $<HTMLTextAreaElement>('#ext-args').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  spec.bin = $<HTMLInputElement>('#ext-bin').value.trim();
  spec.baseUrl = $<HTMLInputElement>('#ext-base-url').value.trim();
  const env = $<HTMLInputElement>('#ext-api-env').value.trim();
  if (env) spec.apiKeyEnv = env; else delete spec.apiKeyEnv;
  const modelText = $<HTMLInputElement>('#ext-models').value.trim();
  if (modelText === 'auto') spec.models = 'auto';
  else {
    const ids = modelText.split(',').map((id) => id.trim()).filter(Boolean);
    let original = [];
    try { original = JSON.parse($<HTMLInputElement>('#ext-models').dataset.original || '[]'); } catch {}
    const byId = new Map((Array.isArray(original) ? original : []).filter((item) => item && typeof item === 'object').map((item) => [item.id, item]));
    spec.models = ids.map((id) => byId.get(id) || id);
  }
  const timeoutField = $<HTMLInputElement>('#ext-timeout');
  if (timeoutField.value !== timeoutField.dataset.shown) {
    const minutes = Number(timeoutField.value);
    if (timeoutField.value.trim() && Number.isFinite(minutes) && minutes > 0) spec.timeoutMs = Math.round(Math.min(Math.max(minutes, 1), TIMEOUT_MAX_MINUTES) * 60000);
    else delete spec.timeoutMs;
    timeoutField.dataset.shown = timeoutField.value;
  }
  if (!spec.capabilities) spec.capabilities = { attachments: spec.type === 'openai' ? ['textInline'] : ['filePath'], attachmentsNeedCwd: false };
  editingExtSpec = spec;
  $<HTMLTextAreaElement>('#ext-content').value = JSON.stringify(spec, null, 2) + '\n';
  updateExtTypeFields();
}

function extensionSecretRef(spec: ExtSpec | null = editingExtSpec): string {
  return (spec && spec.secretRef) || `adapter:${(spec && spec.id) || $<HTMLInputElement>('#ext-id').value.trim()}`;
}

async function refreshExtensionSecretStatus(): Promise<void> {
  if (!editingExtSpec || editingExtSpec.type !== 'openai') return;
  try {
    const status = await window.api.secrets.status(extensionSecretRef(), editingExtSpec.apiKeyEnv || '');
    const badge = $('#ext-key-status');
    badge.classList.toggle('configured', status.configured);
    badge.textContent = status.configured ? `${t('extEditor.keySet', { hint: status.hint })}${status.source === 'environment' ? t('extEditor.keyEnv') : ''}` : t('extEditor.keyUnset');
    $<HTMLButtonElement>('#ext-key-clear').disabled = status.source !== 'safeStorage';
  } catch (e) { showExtResult(cleanIpcError(e), null); }
}

async function pickExtensionExecutable(): Promise<void> {
  const file = await window.api.pickExecutable();
  if (!file) return;
  $<HTMLInputElement>('#ext-bin').value = file;
  syncExtBasicToJson();
}

async function clearExtensionSecret(): Promise<void> {
  try {
    await window.api.secrets.clear(extensionSecretRef());
    const spec = JSON.parse($<HTMLTextAreaElement>('#ext-content').value);
    delete spec.secretRef;
    editingExtSpec = spec;
    $<HTMLTextAreaElement>('#ext-content').value = JSON.stringify(spec, null, 2) + '\n';
    $<HTMLInputElement>('#ext-api-key').value = '';
    syncExtBasicToJson();
    await refreshExtensionSecretStatus();
    showExtResult(null, t('extEditor.keyCleared'));
  } catch (e) { showExtResult(cleanIpcError(e), null); }
}

async function testExtensionConnection(): Promise<void> {
  const button = $<HTMLButtonElement>('#ext-key-test');
  button.disabled = true;
  button.textContent = t('extEditor.testing');
  try {
    const saved = await saveExtension({ quiet: true });
    if (!saved) return;
    const result = await window.api.secrets.test(editingExtSpec?.id || '');
    showExtResult(result.ok ? null : result.hint || result.error, result.ok ? `✓ ${result.version || t('extEditor.connected')}` : null, result.ok ? null : result.fix);
  } catch (e) { showExtResult(cleanIpcError(e), null); }
  finally { button.disabled = false; button.textContent = t('extEditor.keyTest'); }
}

function showExtResult(error: string | null | undefined | false, ok: string | null, fix?: EnvFix | null): void {
  const box = $<HTMLDivElement>('#ext-error');
  box.hidden = !error;
  box.innerHTML = error ? `<div>⚠ ${escapeHtml(error)}</div>${envFixHtml(fix)}` : '';
  bindEnvFix(box);
  $<HTMLDivElement>('#ext-ok').hidden = !ok;
  $<HTMLDivElement>('#ext-ok').textContent = ok || '';
}

async function saveExtension({ quiet = false }: { quiet?: boolean } = {}): Promise<boolean> {
  const file = $<HTMLInputElement>('#ext-file').value.trim();
  try {
    if (!file.endsWith('.js')) {
      if (!$<HTMLDivElement>('#ext-basic').hidden) syncExtBasicToJson();
      const spec = JSON.parse($<HTMLTextAreaElement>('#ext-content').value);
      const key = $<HTMLInputElement>('#ext-api-key').value.trim();
      if (spec.type === 'openai' && key) {
        spec.secretRef = extensionSecretRef(spec);
        await window.api.secrets.set(spec.secretRef, key);
        $<HTMLInputElement>('#ext-api-key').value = '';
        editingExtSpec = spec;
        $<HTMLTextAreaElement>('#ext-content').value = JSON.stringify(spec, null, 2) + '\n';
      }
    }
    const { error } = await window.api.ext.write(file, $<HTMLTextAreaElement>('#ext-content').value, editingExtFile);
    editingExtFile = file;
    $('#ext-editor-title').textContent = editingExtSpec?.label || t('extEditor.title');
    if (opts) await opts.refreshCatalog();
    await refreshExtensionSecretStatus();
    if (error || !quiet) showExtResult(error, error ? null : t('extEditor.saved'));
    return !error;
  } catch (e) {
    showExtResult(cleanIpcError(e), null);
    return false;
  }
}

async function deleteExtension(): Promise<void> {
  if (!editingExtFile || !confirm(t('extEditor.confirmDelete', { file: editingExtFile }))) return;
  try {
    await window.api.ext.remove(editingExtFile);
  } catch (e) {
    alert(t('extEditor.deleteFailed', { reason: cleanIpcError(e) }));
    return;
  }
  $<HTMLDivElement>('#ext-editor').classList.add('hidden');
  editingExtFile = null;
  if (opts) await opts.refreshCatalog();
}
