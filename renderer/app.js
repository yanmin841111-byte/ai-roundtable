'use strict';
const $ = (s) => document.querySelector(s);
let config = null;
let cliTypes = {};
let cliStatus = {};
let extSummary = { entries: [], templates: [] };
let editingExtFile = null;
let editingId = null;
const msgEls = new Map();
let running = false;

marked.setOptions({ breaks: true, gfm: true });

const Marker = window.Shared || {
  hasMarker(text, tag) {
    const marker = `[${tag}]`;
    return String(text || '').trimEnd().split(/\r?\n/).slice(-3).some((line) => line.trim() === marker);
  },
  stripMarker(text, tag) {
    const marker = `[${tag}]`;
    return String(text || '').split(/\r?\n/).filter((line) => line.trim() !== marker).join('\n').trim();
  },
};

// ---------- 初始化 ----------
async function init() {
  [config, cliTypes, extSummary] = await Promise.all([window.api.getConfig(), window.api.cliTypes(), window.api.ext.list()]);
  renderSidebar();
  renderExtensions();
  const snap = await window.api.snapshot();
  snap.messages.forEach(renderMessage);
  setState(snap);
  checkClis();

  window.api.onMessage(renderMessage);
  window.api.onState(setState);
  window.api.onReset(() => { msgEls.clear(); $('#timeline').innerHTML = ''; $('#timeline').appendChild($('#empty') || emptyEl()); $('#empty').style.display = ''; });

  $('#send-btn').onclick = sendMessage;
  $('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); } });
  $('#stop-btn').onclick = () => window.api.stop();
  $('#reset-btn').onclick = () => { if (!running || confirm('目前仍在進行中,確定要停止並清空對話?')) window.api.reset(); };
  $('#add-agent').onclick = () => openModal(null);
  $('#modal-close').onclick = closeModal;
  $('#modal-save').onclick = saveModal;
  $('#modal-delete').onclick = deleteAgent;
  $('#f-cli').onchange = () => fillCliDependentFields($('#f-cli').value);
  $('#f-model-select').onchange = onModelSelect;
  $('#f-model').addEventListener('input', () => refreshModelDependents());
  $('#pick-dir').onclick = async () => { const d = await window.api.pickDir(); if (d) { $('#work-dir').value = d; saveSettings(); } };
  $('#open-dir').onclick = () => window.api.openPath($('#work-dir').value);
  for (const id of ['#work-dir', '#max-rounds', '#language', '#lead-agent']) $(id).addEventListener('change', saveSettings);
  $('#ext-add').onclick = openTemplatePicker;
  $('#ext-open-dir').onclick = () => window.api.ext.openDir();
  $('#ext-reload').onclick = () => reloadExtensions();
  $('#ext-docs').onclick = () => window.api.ext.openDocs();
  $('#ext-editor-docs').onclick = () => window.api.ext.openDocs();
  $('#ext-picker-close').onclick = () => $('#ext-picker').classList.add('hidden');
  $('#ext-editor-close').onclick = () => $('#ext-editor').classList.add('hidden');
  $('#ext-save').onclick = saveExtension;
  $('#ext-delete').onclick = deleteExtension;
  $('#ext-content').addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveExtension(); }
  });
  $('#mode').value = config.settings.mode || 'divide';
  $('#mode').onchange = () => { config.settings.mode = $('#mode').value; window.api.saveConfig(config); };
}

function emptyEl() {
  const d = document.createElement('div');
  d.id = 'empty'; d.className = 'empty';
  d.innerHTML = '<div class="empty-icon">◎</div><div class="empty-title">把任務丟給圓桌</div><div class="empty-sub">成員會輪流討論、達成共識後由主持人分工,各自在工作目錄執行,最後互相審查。</div>';
  return d;
}

async function checkClis() {
  cliStatus = await window.api.checkCli();
  renderExtensions();
}

// ---------- CLI 與擴充 ----------
const TYPE_LABEL = { builtin: '內建', cli: 'CLI', openai: 'API', js: 'JS 外掛' };

async function refreshCatalog() {
  [cliTypes, extSummary] = await Promise.all([window.api.cliTypes(), window.api.ext.list()]);
  renderSidebar();
  renderExtensions();
  checkClis();
}

async function reloadExtensions() {
  await window.api.ext.reload();
  await refreshCatalog();
}

function renderExtensions() {
  const list = $('#ext-list');
  if (!list) return;
  const rows = [];
  // 已載入的轉接器(內建 + 擴充)
  for (const t of Object.values(cliTypes)) {
    const st = cliStatus[t.id];
    const dot = !st ? '<span class="unknown">○</span>' : st.ok ? '<span class="ok">●</span>' : '<span class="bad">○</span>';
    const sub = st ? (st.ok ? st.version : st.error) : t.bin ? '檢查中…' : '不需檢查';
    const badges = [`<span class="badge">${TYPE_LABEL[t.type] || t.type}</span>`];
    if (!t.supportsEdit) badges.push('<span class="badge">只能討論</span>');
    const entry = extSummary.entries.find((e) => e.file === t.file);
    if (entry && entry.overrides) badges.push('<span class="badge warn">覆寫內建</span>');
    if (t.modelError) badges.push('<span class="badge warn">模型清單讀取失敗</span>');
    rows.push({ file: t.file, html: `${dot}<div class="ext-main"><div class="ext-title"><b>${escapeHtml(t.label)}</b>${badges.join('')}</div><div class="ext-sub" title="${escapeHtml(sub || '')}">${escapeHtml(sub || '')}</div>${t.modelError ? `<div class="ext-err">${escapeHtml(t.modelError)}</div>` : ''}</div>` });
  }
  // 載入失敗的擴充
  for (const e of extSummary.entries.filter((x) => x.error)) {
    rows.push({ file: e.file, broken: true, html: `<span class="bad">✕</span><div class="ext-main"><div class="ext-title"><b>${escapeHtml(e.file)}</b><span class="badge bad">載入失敗</span></div><div class="ext-err">${escapeHtml(e.error)}</div></div>` });
  }
  list.innerHTML = '';
  for (const r of rows) {
    const el = document.createElement('div');
    el.className = `ext-item${r.file ? ' clickable' : ''}${r.broken ? ' broken' : ''}`;
    el.innerHTML = r.html;
    if (r.file) { el.title = `點擊編輯 ${r.file}`; el.onclick = () => openExtEditor(r.file); }
    list.appendChild(el);
  }
}

function openTemplatePicker() {
  const box = $('#ext-templates');
  box.innerHTML = '';
  for (const t of extSummary.templates) {
    const el = document.createElement('button');
    el.className = 'template';
    el.innerHTML = `<span class="row"><b>${escapeHtml(t.label)}</b><span class="badge">${TYPE_LABEL[t.type] || t.type}</span></span><span class="hint">${escapeHtml(t.description)}</span>`;
    el.onclick = async () => {
      try {
        const { file } = await window.api.ext.install(t.file);
        $('#ext-picker').classList.add('hidden');
        await refreshCatalog();
        openExtEditor(file);
      } catch (e) { alert(`新增失敗:${cleanIpcError(e)}`); }
    };
    box.appendChild(el);
  }
  $('#ext-picker').classList.remove('hidden');
}

async function openExtEditor(file) {
  try {
    const content = await window.api.ext.read(file);
    editingExtFile = file;
    $('#ext-editor-title').textContent = `編輯擴充:${file}`;
    $('#ext-file').value = file;
    $('#ext-content').value = content;
    const entry = extSummary.entries.find((e) => e.file === file);
    showExtResult(entry && entry.error, null);
    $('#ext-editor').classList.remove('hidden');
  } catch (e) { alert(`無法開啟:${cleanIpcError(e)}`); }
}

function showExtResult(error, ok) {
  $('#ext-error').hidden = !error;
  $('#ext-error').textContent = error ? `⚠ ${error}` : '';
  $('#ext-ok').hidden = !ok;
  $('#ext-ok').textContent = ok || '';
}

async function saveExtension() {
  const file = $('#ext-file').value.trim();
  try {
    const { error } = await window.api.ext.write(file, $('#ext-content').value, editingExtFile);
    editingExtFile = file;
    $('#ext-editor-title').textContent = `編輯擴充:${file}`;
    await refreshCatalog();
    showExtResult(error, error ? null : '✓ 已儲存並載入。成員編輯視窗的 CLI 選單已更新。');
  } catch (e) {
    showExtResult(cleanIpcError(e), null);
  }
}

async function deleteExtension() {
  if (!editingExtFile || !confirm(`確定刪除 ${editingExtFile}?使用這個 CLI 的成員會無法發言。`)) return;
  await window.api.ext.remove(editingExtFile);
  $('#ext-editor').classList.add('hidden');
  editingExtFile = null;
  await refreshCatalog();
}

// Electron 會把主程序錯誤包成 "Error invoking remote method 'x': Error: 訊息"
function cleanIpcError(e) {
  return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ---------- 側欄 ----------
function renderSidebar() {
  const list = $('#agent-list');
  list.innerHTML = '';
  const lead = config.settings.leadAgentId || (config.agents.find((a) => a.enabled !== false) || {}).id;
  for (const a of config.agents) {
    const el = document.createElement('div');
    el.className = 'agent-card' + (a.enabled === false ? ' disabled' : '');
    el.innerHTML = `
      <div class="avatar" style="background:${a.color}">${initials(a.name)}</div>
      <div class="agent-info">
        <div class="agent-name">${escapeHtml(a.name)} ${a.id === lead ? '<span class="badge lead">主持人</span>' : ''} ${!cliTypes[a.cli] ? '<span class="badge bad">找不到 CLI</span>' : a.canEdit && cliTypes[a.cli].supportsEdit ? '' : '<span class="badge">唯讀</span>'}</div>
        <div class="agent-meta">${(cliTypes[a.cli] || {}).label || a.cli} · ${escapeHtml(a.model || '預設模型')} · ${escapeHtml(a.effort || '預設強度')}</div>
        <div class="agent-meta">${escapeHtml(a.persona || '')}</div>
      </div>`;
    el.onclick = () => openModal(a.id);
    list.appendChild(el);
  }
  $('#work-dir').value = config.settings.workDir || '';
  $('#max-rounds').value = config.settings.maxRounds || 3;
  $('#language').value = config.settings.language || '繁體中文';
  const sel = $('#lead-agent');
  sel.innerHTML = config.agents.filter((a) => a.enabled !== false).map((a) => `<option value="${a.id}" ${a.id === lead ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('');
}

function saveSettings() {
  config.settings.workDir = $('#work-dir').value.trim();
  config.settings.maxRounds = Number($('#max-rounds').value) || 3;
  config.settings.language = $('#language').value.trim() || '繁體中文';
  config.settings.leadAgentId = $('#lead-agent').value || null;
  window.api.saveConfig(config);
  renderSidebar();
}

// ---------- 成員編輯 ----------
async function openModal(id) {
  editingId = id;
  // 每次打開都重抓:CLI 更新模型快取後不用重開 app。主程序有依檔案修改時間快取,重抓很便宜。
  try { cliTypes = await window.api.cliTypes(); } catch {}
  const a = id ? config.agents.find((x) => x.id === id) : { name: '', cli: 'claude', model: '', effort: '', persona: '', color: randomColor(), canEdit: true, enabled: true, customCommand: '' };
  $('#modal-title').textContent = id ? '編輯成員' : '新增成員';
  const groups = [['內建', (t) => t.origin === 'builtin'], ['擴充', (t) => t.origin !== 'builtin']];
  let cliOptions = groups.map(([name, pick]) => {
    const opts = Object.values(cliTypes).filter(pick).map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)}${t.type !== 'builtin' ? `(${TYPE_LABEL[t.type] || t.type})` : ''}</option>`).join('');
    return opts ? `<optgroup label="${name}">${opts}</optgroup>` : '';
  }).join('');
  if (a.cli && !cliTypes[a.cli]) cliOptions += `<option value="${escapeHtml(a.cli)}">${escapeHtml(a.cli)}(找不到,請重新選擇)</option>`;
  $('#f-cli').innerHTML = cliOptions;
  $('#f-cli').value = a.cli;
  $('#f-name').value = a.name;
  $('#f-color').value = a.color;
  $('#f-persona').value = a.persona || '';
  $('#f-canEdit').checked = !!a.canEdit;
  $('#f-enabled').checked = a.enabled !== false;
  $('#f-custom').value = a.customCommand || '';
  fillCliDependentFields(a.cli, a.model, a.effort);
  $('#modal-delete').style.visibility = id ? 'visible' : 'hidden';
  $('#modal').classList.remove('hidden');
  $('#f-name').focus();
}
// ---------- 模型與強度 ----------
const CUSTOM_MODEL = '__custom__';
const modelsOf = (cli) => (cliTypes[cli] || {}).models || [];
const findModel = (cli, name) => ModelRules.findModel(modelsOf(cli), name);

function fillCliDependentFields(cli, model, effort) {
  const models = modelsOf(cli);
  const isCustomCli = !!(cliTypes[cli] && cliTypes[cli].usesCustomCommand);
  const sel = $('#f-model-select');
  sel.innerHTML = '<option value="">(CLI 預設模型)</option>'
    + models.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label !== m.id ? `${m.id}(${m.label})` : m.id)}</option>`).join('')
    + `<option value="${CUSTOM_MODEL}">其他(手動輸入)…</option>`;

  // model 為 undefined 代表剛切換 CLI:預設選清單第一個。舊設定存的別名(例如 opus)會對應到完整名稱。
  const raw = model === undefined ? (models[0] ? models[0].id : '') : String(model || '');
  const known = raw === '' ? null : findModel(cli, raw);
  const manual = isCustomCli || (raw !== '' && !known);
  sel.value = manual ? CUSTOM_MODEL : (known ? known.id : '');
  sel.style.display = isCustomCli ? 'none' : '';
  $('#f-model').value = manual ? raw : '';
  $('#f-model').style.display = manual ? '' : 'none';
  $('#f-custom-wrap').style.display = isCustomCli ? '' : 'none';
  updateEditCapability(cli);
  refreshModelDependents(effort);
}

// 轉接器不支援修改檔案時(例如 API),停用勾選框並說明原因;成員原本的設定保留不動。
function updateEditCapability(cli) {
  const t = cliTypes[cli];
  const supported = !t || t.supportsEdit;
  const box = $('#f-canEdit');
  box.disabled = !supported;
  let note = $('#f-canEdit-note');
  if (!note) {
    note = document.createElement('div');
    note.id = 'f-canEdit-note';
    note.className = 'field-note';
    $('#f-canEdit-wrap').after(note);
  }
  note.textContent = supported ? '' : `${t.label} 不能修改檔案,只能參與討論與審查`;
  note.hidden = supported;
}

function currentModel() {
  const v = $('#f-model-select').value;
  return v === CUSTOM_MODEL ? $('#f-model').value.trim() : v;
}

function onModelSelect() {
  const manual = $('#f-model-select').value === CUSTOM_MODEL;
  $('#f-model').style.display = manual ? '' : 'none';
  if (manual) $('#f-model').focus();
  refreshModelDependents();
}

// 依目前選的模型更新說明文字與強度選單。effort 未給時沿用畫面上的選擇。
function refreshModelDependents(effort) {
  const cli = $('#f-cli').value;
  const t = cliTypes[cli] || {};
  const source = t.modelSource;
  const info = findModel(cli, currentModel());
  const notes = [];
  if (info && info.description) notes.push(info.description);
  if (source === 'fallback') notes.push('(讀不到 CLI 的模型快取,顯示內建清單;先執行一次該 CLI 通常就會產生)');
  if (source === 'error') notes.push(`(模型清單讀取失敗:${t.modelError || '未知錯誤'};可以選「其他(手動輸入)」)`);
  if (source === 'loading') notes.push('(模型清單讀取中,稍後重新打開這個視窗)');
  if (t.description && t.origin !== 'builtin' && !info) notes.push(t.description);
  $('#f-model-desc').textContent = notes.join(' ');
  fillEfforts(cli, info, effort === undefined ? $('#f-effort').value : effort);
}

function fillEfforts(cli, info, wanted) {
  const eff = $('#f-effort');
  const t = cliTypes[cli] || {};
  const restricted = !!info && !info.unrestrictedEffort;
  // 認得且有限制的模型用它自己的強度清單;其他情況列出轉接器設定的強度與所有模型強度的聯集。
  let efforts;
  if (restricted) efforts = info.efforts;
  else {
    const pool = new Set([...(t.efforts || []), ...modelsOf(cli).flatMap((m) => m.efforts || [])]);
    efforts = [...ModelRules.EFFORT_RANK.filter((e) => pool.has(e)), ...[...pool].filter((e) => !ModelRules.EFFORT_RANK.includes(e))];
  }
  const unsupported = restricted && efforts.length === 0;
  eff.disabled = efforts.length === 0;
  eff.innerHTML = unsupported
    ? '<option value="">(此模型不支援強度設定)</option>'
    : efforts.length === 0
      ? '<option value="">(這個 CLI 沒有設定強度選項)</option>'
      : `<option value="">(預設${info && info.defaultEffort ? ':' + info.defaultEffort : ''})</option>` + efforts.map((e) => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join('');
  // 換模型時保留原本的強度;新模型不支援就降到最接近的等級,跟實際執行時的規則一致。
  const resolved = restricted ? ModelRules.resolveEffort([info], info.id, wanted).effort : wanted;
  eff.value = resolved && efforts.includes(resolved) ? resolved : '';
}

function closeModal() { $('#modal').classList.add('hidden'); }
function saveModal() {
  const name = $('#f-name').value.trim();
  if (!name) { $('#f-name').focus(); return; }
  const data = { name, cli: $('#f-cli').value, model: ModelRules.resolveModelId(modelsOf($('#f-cli').value), currentModel()), effort: $('#f-effort').value, persona: $('#f-persona').value.trim(), color: $('#f-color').value, canEdit: $('#f-canEdit').checked, enabled: $('#f-enabled').checked, customCommand: $('#f-custom').value.trim() };
  if (editingId) Object.assign(config.agents.find((x) => x.id === editingId), data);
  else config.agents.push({ id: crypto.randomUUID(), ...data });
  window.api.saveConfig(config);
  renderSidebar();
  closeModal();
}
function deleteAgent() {
  if (!editingId || !confirm('確定刪除這位成員?')) return;
  config.agents = config.agents.filter((x) => x.id !== editingId);
  if (config.settings.leadAgentId === editingId) config.settings.leadAgentId = null;
  window.api.saveConfig(config);
  renderSidebar();
  closeModal();
}

// ---------- 對話 ----------
async function sendMessage() {
  const text = $('#input').value.trim();
  if (!text) return;
  $('#input').value = '';
  await window.api.send(text, $('#mode').value);
}

function setState(s) {
  running = !!s.running;
  const pill = $('#phase-pill');
  pill.textContent = running ? s.phase : '閒置';
  pill.className = 'phase ' + (running ? 'busy' : 'idle');
  $('#stop-btn').disabled = !running;
  $('#hint').textContent = running ? '進行中,現在送出的訊息會在下一位成員發言時帶入' : '';
}

function renderMessage(m) {
  const tl = $('#timeline');
  const empty = $('#empty');
  if (empty) empty.style.display = 'none';
  let el = msgEls.get(m.id);
  const atBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 80;
  if (!el) {
    el = document.createElement('div');
    msgEls.set(m.id, el);
    tl.appendChild(el);
  }
  el.className = `msg ${m.kind} ${m.level || ''}`;
  if (m.kind === 'agent') renderAgentMessage(el, m);
  else el.innerHTML = m.kind === 'user' ? userHtml(m) : systemHtml(m);
  if (atBottom) tl.scrollTop = tl.scrollHeight;
}

function userHtml(m) {
  return `<div class="avatar" style="background:#3b4a7a">我</div><div class="bubble"><div class="body">${marked.parse(m.text || '')}</div></div>`;
}
function systemHtml(m) {
  return `<div class="bubble"><div class="body">${marked.parse(m.text || '')}</div></div>`;
}

function renderAgentMessage(el, m) {
  const agreed = Marker.hasMarker(m.text || '', 'AGREED');
  const text = Marker.stripMarker(m.text || '', 'AGREED');
  const status = m.status === 'running' ? '<span class="spinner" title="產生中"></span>' : '';
  const shell = ensureAgentShell(el);
  shell.avatar.style.background = m.color || '#6c8cff';
  setTextIfChanged(shell.avatar, initials(m.agentName));
  shell.bubble.style.setProperty('--c', m.color || '#6c8cff');
  setHtmlIfChanged(shell.head, `<b>${escapeHtml(m.agentName)}</b><span class="badge">${escapeHtml((cliTypes[m.cli] || {}).label || m.cli)}${m.model ? ' · ' + escapeHtml(m.model) : ''}</span>${m.phase ? `<span class="badge">${escapeHtml(m.phase)}</span>` : ''}${agreed ? '<span class="badge agreed">✓ 同意分工</span>' : ''}${status}`);
  renderThinking(shell.thinking, m.thinking || '');
  renderActivities(shell.activities, m.activities || []);
  const body = text ? marked.parse(text) : (m.status === 'running' ? '<span class="hint">…</span>' : '');
  if (!hasSelectionInside(shell.body)) setHtmlIfChanged(shell.body, body);
  shell.error.hidden = !m.error;
  setTextIfChanged(shell.error, m.error ? `⚠ ${m.error}` : '');
  const usage = usageText(m.usage);
  shell.usage.hidden = !usage;
  setTextIfChanged(shell.usage, usage);
}

function ensureAgentShell(el) {
  if (el.dataset.shell !== 'agent') {
    el.textContent = '';
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const head = document.createElement('div');
    head.className = 'bubble-head';
    const thinking = document.createElement('div');
    thinking.className = 'thinking-slot';
    const activities = document.createElement('div');
    activities.className = 'activities';
    const body = document.createElement('div');
    body.className = 'body';
    const error = document.createElement('div');
    error.className = 'error-text';
    const usage = document.createElement('div');
    usage.className = 'usage';
    bubble.append(head, thinking, activities, body, error, usage);
    el.append(avatar, bubble);
    el.dataset.shell = 'agent';
  }
  return {
    avatar: el.querySelector(':scope > .avatar'),
    bubble: el.querySelector(':scope > .bubble'),
    head: el.querySelector('.bubble-head'),
    thinking: el.querySelector('.thinking-slot'),
    activities: el.querySelector('.activities'),
    body: el.querySelector('.body'),
    error: el.querySelector('.error-text'),
    usage: el.querySelector('.usage'),
  };
}

function renderThinking(slot, thinking) {
  slot.hidden = !thinking;
  if (!thinking) return;
  let details = slot.querySelector('details.thinking');
  if (!details) {
    details = document.createElement('details');
    details.className = 'thinking';
    const summary = document.createElement('summary');
    summary.textContent = '💭 思考過程';
    const content = document.createElement('div');
    content.className = 'content';
    details.append(summary, content);
    slot.appendChild(details);
  }
  setTextIfChanged(details.querySelector('.content'), thinking);
}

function renderActivities(slot, activities) {
  slot.hidden = activities.length === 0;
  const seen = new Set();
  for (const activity of activities) {
    const id = String(activity.id || activity.title || seen.size);
    seen.add(id);
    let details = [...slot.children].find((el) => el.dataset.actId === id);
    if (!details) {
      details = document.createElement('details');
      details.dataset.actId = id;
      const summary = document.createElement('summary');
      const pre = document.createElement('pre');
      details.append(summary, pre);
      slot.appendChild(details);
    }
    details.className = `act ${activity.kind === 'note' ? 'note' : ''} ${activity.status || ''}`;
    setHtmlIfChanged(details.querySelector('summary'), `<span class="dot"></span>${escapeHtml(activity.title || '工具')}`);
    const detail = [activity.detail, activity.result ? '── 結果 ──\n' + activity.result : ''].filter(Boolean).join('\n');
    const pre = details.querySelector('pre');
    pre.hidden = !detail;
    setTextIfChanged(pre, detail);
  }
  for (const child of [...slot.children]) {
    if (!seen.has(child.dataset.actId)) child.remove();
  }
}

function setHtmlIfChanged(el, html) {
  if (el._lastHtml === html) return;
  el.innerHTML = html;
  el._lastHtml = html;
}
function setTextIfChanged(el, text) {
  if (el._lastText === text) return;
  el.textContent = text;
  el._lastText = text;
}
function hasSelectionInside(el) {
  const sel = window.getSelection && window.getSelection();
  return !!(sel && !sel.isCollapsed && el.contains(sel.anchorNode) && el.contains(sel.focusNode));
}
function usageText(u) {
  if (!u) return '';
  const parts = [];
  if (u.input_tokens != null) parts.push(`輸入 ${fmt(u.input_tokens + (u.cache_read_input_tokens || u.cached_input_tokens || 0))}`);
  if (u.output_tokens != null) parts.push(`輸出 ${fmt(u.output_tokens)}`);
  if (u.total_cost_usd != null) parts.push(`$${u.total_cost_usd.toFixed(3)}`);
  return parts.join(' · ');
}

// ---------- 小工具 ----------
function fmt(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
function initials(name) { return (name || '?').trim().slice(0, 1).toUpperCase(); }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function randomColor() { const c = ['#6c8cff', '#d97757', '#10a37f', '#c678dd', '#e5c07b', '#56b6c2', '#ff6b9d']; return c[Math.floor(Math.random() * c.length)]; }

init();
