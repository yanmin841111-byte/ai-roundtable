// 側欄的「陣容」選單:把目前誰上場、各自的角色、主持人、流程存起來,之後一鍵換回來。
// 套用、比對的規則在 src/lineups.ts;這裡只負責畫面。
import { t } from './i18n';
import { $ } from './util';
import { controlLabel } from './icons';
import { applyLineup, lineupFromConfig, lineupMatches, suggestLineupMembers, LINEUP_NAME_MAX, LINEUPS_MAX } from '../src/lineups';
import type { SuggestedMembers } from '../src/lineups';
import type { AppConfig, Lineup } from './api';

export interface LineupDeps {
  config: () => AppConfig;
  // 寫回設定、存檔、重畫側欄與流程選單
  commit: (next: AppConfig) => Promise<boolean>;
  running: () => boolean;
  availability: () => Record<string, { ready: boolean; writable: boolean; detail: string }>;
  refresh: () => Promise<void>;
  pickWorkDir: () => Promise<void>;
  openConnections: () => void;
  addMember: () => void;
  // 用同一個已連接的 Copilot CLI 建立三位不同模型的唯讀成員;不可用時為 null
  copilotTrio: (() => Promise<boolean>) | null;
}

let deps: LineupDeps;
let naming = false; // 選單底部正在輸入新陣容的名稱
let noteTimer: ReturnType<typeof setTimeout> | undefined;
let preset: 'code' | 'general' | null = null;
let selection: SuggestedMembers | null = null;
let saving = false;
let refreshing = false;

export function setupLineups(d: LineupDeps): void {
  deps = d;
  const btn = $<HTMLButtonElement>('#lineup-btn');
  btn.onclick = (e) => { e.stopPropagation(); toggleMenu(); };
  // 點選單以外的地方、按 Esc 都關掉
  document.addEventListener('mousedown', (e) => {
    const menu = $('#lineup-menu');
    if (!menu.hidden && !menu.contains(e.target as Node) && e.target !== btn && !btn.contains(e.target as Node)) closeLineupMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#lineup-menu').hidden) { e.preventDefault(); closeLineupMenu(); btn.focus(); }
  });
  renderLineupButton();
}

function lineups(): Lineup[] { return deps.config().lineups || []; }
function active(): Lineup | null { return lineups().find((l) => l.id === deps.config().settings.activeLineupId) || null; }

// 按鈕上寫目前的陣容;套用後又改過就加註「已修改」,不讓它看起來還是原本那組
export function renderLineupButton(): void {
  if (!deps) return;
  const btn = $<HTMLButtonElement>('#lineup-btn');
  const cur = active();
  const modified = !!cur && !lineupMatches(deps.config(), cur);
  btn.textContent = cur ? t('lineup.buttonActive', { name: cur.name }) + (modified ? t('lineup.modifiedMark') : '') : t('lineup.button');
  btn.title = cur ? t(modified ? 'lineup.buttonTitleModified' : 'lineup.buttonTitle', { name: cur.name }) : t('lineup.buttonTitleNone');
  btn.classList.toggle('active', !!cur);
  btn.setAttribute('aria-expanded', String(!$('#lineup-menu').hidden));
  // 正在輸入名稱時不重畫,否則打到一半的字會不見
  if (!$('#lineup-menu').hidden && !naming) renderMenu();
}

function toggleMenu(): void {
  if (saving) return;
  const menu = $('#lineup-menu');
  if (!menu.hidden) { closeLineupMenu(); return; }
  naming = false;
  menu.hidden = false;
  renderMenu();
  $<HTMLButtonElement>('#lineup-btn').setAttribute('aria-expanded', 'true');
  (menu.querySelector<HTMLElement>('.lineup-item:not(:disabled), .lineup-action') || menu).focus();
}

export function closeLineupMenu(): void {
  if (saving) return;
  $('#lineup-menu').hidden = true;
  naming = false;
  preset = null;
  selection = null;
  $<HTMLButtonElement>('#lineup-btn').setAttribute('aria-expanded', 'false');
}

function modeLabel(mode: string): string { return t(mode === 'guarded' ? 'lineup.mode.guarded' : mode === 'discuss' ? 'lineup.mode.discuss' : 'lineup.mode.divide'); }

function renderMenu(): void {
  const menu = $('#lineup-menu');
  const config = deps.config();
  const cur = active();
  const busy = deps.running();
  menu.replaceChildren();
  if (preset) { renderPreset(menu); return; }

  const quick = document.createElement('div');
  quick.className = 'lineup-menu-head';
  quick.textContent = t('lineup.quick.title');
  menu.appendChild(quick);
  for (const kind of ['code', 'general'] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lineup-action lineup-quick';
    button.dataset.preset = kind;
    button.disabled = busy || saving;
    controlLabel(button, kind === 'code' ? 'terminal' : 'result', t(`lineup.quick.${kind}`));
    button.onclick = () => {
      if (deps.running() || saving) return;
      preset = kind;
      selection = null;
      renderMenu();
      menu.querySelector<HTMLElement>('select, button')?.focus();
    };
    menu.appendChild(button);
  }

  const head = document.createElement('div');
  head.className = 'lineup-menu-head';
  head.textContent = t('lineup.menuTitle');
  menu.appendChild(head);

  const list = lineups();
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'lineup-empty';
    empty.textContent = t('lineup.empty');
    menu.appendChild(empty);
  }
  for (const l of list) {
    const present = l.members.filter((m) => config.agents.some((a) => a.id === m.id));
    const row = document.createElement('div');
    row.className = 'lineup-row' + (l === cur ? ' current' : '');
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'lineup-item';
    item.dataset.lineupId = l.id;
    item.disabled = busy || !present.length;
    item.title = busy ? t('lineup.running') : !present.length ? t('lineup.allMissing') : t('lineup.applyTitle');
    const check = document.createElement('span');
    check.className = 'lineup-check';
    check.textContent = l === cur ? '✓' : '';
    const main = document.createElement('span');
    main.className = 'lineup-main';
    const name = document.createElement('b');
    name.textContent = l.name;
    const meta = document.createElement('small');
    // 成員名稱照目前的設定顯示:改過名的成員不會顯示成舊名字
    const names = present.map((m) => config.agents.find((a) => a.id === m.id)!.name);
    const missing = l.members.length - present.length;
    meta.textContent = [t('lineup.meta', { names: names.join('、') || '—', mode: modeLabel(l.mode) }), missing ? t('lineup.metaMissing', { n: missing }) : ''].filter(Boolean).join(' · ');
    main.append(name, meta);
    item.append(check, main);
    if (l === cur && !lineupMatches(config, l)) {
      const mod = document.createElement('span');
      mod.className = 'badge warn lineup-modified';
      mod.textContent = t('lineup.modified');
      item.appendChild(mod);
    }
    item.onclick = () => apply(l);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'lineup-delete';
    del.textContent = '✕';
    del.title = t('lineup.delete', { name: l.name });
    del.setAttribute('aria-label', t('lineup.delete', { name: l.name }));
    del.onclick = () => remove(l);
    row.append(item, del);
    menu.appendChild(row);
  }

  const sep = document.createElement('div');
  sep.className = 'lineup-sep';
  menu.appendChild(sep);

  const enabledCount = config.agents.filter((a) => a.enabled !== false).length;
  if (cur && !lineupMatches(config, cur)) {
    const update = document.createElement('button');
    update.type = 'button';
    update.className = 'lineup-action';
    update.textContent = t('lineup.update', { name: cur.name });
    update.disabled = !enabledCount;
    update.onclick = () => save(cur.name, cur.id);
    menu.appendChild(update);
  }
  if (naming) {
    menu.appendChild(nameForm());
  } else {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'lineup-action';
    add.textContent = t('lineup.saveCurrent');
    add.disabled = !enabledCount;
    if (!enabledCount) add.title = t('lineup.noMembers');
    add.onclick = () => { naming = true; renderMenu(); };
    menu.appendChild(add);
  }
}

function nameForm(): HTMLElement {
  const form = document.createElement('form');
  form.className = 'lineup-form';
  const input = document.createElement('input');
  input.id = 'lineup-name';
  input.maxLength = LINEUP_NAME_MAX;
  input.placeholder = t('lineup.namePlaceholder');
  input.setAttribute('aria-label', t('lineup.namePlaceholder'));
  const hint = document.createElement('div');
  hint.className = 'lineup-hint';
  const ok = document.createElement('button');
  ok.type = 'submit';
  ok.className = 'primary small';
  ok.textContent = t('lineup.save');
  ok.disabled = true;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ghost small';
  cancel.textContent = t('lineup.cancel');
  cancel.onclick = () => { naming = false; renderMenu(); };
  // 同名的陣容會被取代,先講清楚
  input.oninput = () => {
    const name = input.value.trim();
    ok.disabled = !name;
    hint.textContent = name && lineups().some((l) => l.name === name) ? t('lineup.replaceHint') : '';
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    const same = lineups().find((l) => l.name === name);
    save(name, same ? same.id : newId());
  };
  const row = document.createElement('div');
  row.className = 'lineup-form-row';
  row.append(input, ok, cancel);
  form.append(row, hint);
  setTimeout(() => input.focus(), 0);
  return form;
}

function newId(): string {
  return (crypto.randomUUID && crypto.randomUUID()) || `lineup-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function save(name: string, id: string): Promise<void> {
  if (saving) return;
  const config = deps.config();
  const lineup = lineupFromConfig(config, name, id);
  if (!lineup.members.length || !lineup.name) return;
  const rest = lineups().filter((l) => l.id !== id);
  const replaced = rest.length !== lineups().length;
  // 設定檔載入時只留前 LINEUPS_MAX 個;多存的會在下次開啟時消失,所以在這裡就擋下來
  if (!replaced && lineups().length >= LINEUPS_MAX) { note(t('lineup.full', { max: LINEUPS_MAX }), true); return; }
  if (!await commit({ ...config, lineups: replaced ? lineups().map((l) => (l.id === id ? lineup : l)) : [...rest, lineup], settings: { ...config.settings, activeLineupId: id } })) return;
  naming = false;
  closeLineupMenu();
  note(t(replaced ? 'lineup.updated' : 'lineup.saved', { name: lineup.name }));
}

async function apply(l: Lineup): Promise<void> {
  if (deps.running() || saving) return;
  const result = applyLineup(deps.config(), l);
  if (!result) { note(t('lineup.allMissing'), true); return; }
  if (!await commit(result.config)) return;
  closeLineupMenu();
  note(result.missing ? t('lineup.appliedMissing', { name: l.name, n: result.missing }) : t('lineup.applied', { name: l.name }), !!result.missing);
}

async function remove(l: Lineup): Promise<void> {
  if (saving) return;
  if (!confirm(t('lineup.confirmDelete', { name: l.name }))) return;
  const config = deps.config();
  const settings = config.settings.activeLineupId === l.id ? { ...config.settings, activeLineupId: null } : config.settings;
  if (!await commit({ ...config, lineups: lineups().filter((x) => x.id !== l.id), settings })) return;
  renderMenu();
}

async function commit(next: AppConfig): Promise<boolean> {
  saving = true;
  $('#lineup-menu').querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select').forEach((control) => { control.disabled = true; });
  try {
    if (await deps.commit(next)) return true;
    note(t('lineup.quick.saveFailed'), true);
    return false;
  } catch {
    note(t('lineup.quick.saveFailed'), true);
    return false;
  } finally {
    saving = false;
    renderMenu();
  }
}

function renderPreset(menu: HTMLElement): void {
  const kind = preset!;
  const config = deps.config();
  const availability = deps.availability();
  const readyIds = config.agents.filter((agent) => availability[agent.id]?.ready).map((agent) => agent.id);
  const writableIds = config.agents.filter((agent) => availability[agent.id]?.writable).map((agent) => agent.id);
  const suggested = suggestLineupMembers(config, readyIds, writableIds, kind);
  if (!selection && !('reason' in suggested)) selection = suggested;
  const head = document.createElement('div');
  head.className = 'lineup-menu-head';
  head.textContent = t(`lineup.quick.${kind}`);
  menu.appendChild(head);
  const form = document.createElement('form');
  form.className = 'lineup-preset';
  const roles = ['leadId', 'authorId', 'reviewerId'] as const;
  const intro = document.createElement('p');
  intro.className = 'lineup-preset-intro';
  intro.textContent = t('lineup.quick.intro');
  form.appendChild(intro);
  if (selection) for (const [index, role] of roles.entries()) {
    const label = document.createElement('label');
    label.className = 'lineup-role';
    const title = document.createElement('span');
    title.className = 'lineup-role-title';
    const step = document.createElement('span');
    step.className = 'lineup-role-step';
    step.textContent = String(index + 1);
    title.append(step, t(`lineup.quick.${role}`));
    label.appendChild(title);
    const select = document.createElement('select');
    select.dataset.teamRole = role;
    select.setAttribute('aria-label', t(`lineup.quick.${role}`));
    for (const member of config.agents) {
      const option = document.createElement('option');
      option.value = member.id;
      option.textContent = `${member.name} · ${member.model || member.cli}`;
      option.disabled = !availability[member.id]?.ready || (kind === 'code' && role === 'authorId' && !availability[member.id]?.writable);
      select.appendChild(option);
    }
    select.value = selection[role];
    select.disabled = deps.running() || saving;
    select.onchange = () => {
      const previous = selection![role];
      const occupied = roles.find((other) => other !== role && selection![other] === select.value);
      if (occupied) selection![occupied] = previous;
      selection![role] = select.value;
      renderMenu();
      menu.querySelector<HTMLElement>(`[data-team-role="${role}"]`)?.focus();
    };
    const detail = document.createElement('small');
    const state = availability[selection[role]];
    detail.className = state?.writable ? 'lineup-role-detail writable' : 'lineup-role-detail';
    detail.textContent = [state?.detail || t('lineup.quick.unknown'), t(state?.writable ? 'lineup.quick.canEdit' : 'agent.readOnly')].join(' · ');
    label.append(select, detail);
    form.appendChild(label);
  }
  const selectedIds = selection ? roles.map((role) => selection![role]) : [];
  const enough = selectedIds.length === 3 && new Set(selectedIds).size === 3 && selectedIds.every((id) => readyIds.includes(id));
  const writer = !!selection && (kind === 'general' || writableIds.includes(selection.authorId));
  const folder = !!config.settings.workDir.trim();
  const needsWriter = !selection && 'reason' in suggested && suggested.reason === 'writer';
  const issue = deps.running() ? t('lineup.running') : needsWriter ? t('lineup.quick.writer') : !enough ? t('lineup.quick.members', { n: readyIds.length }) : !writer ? t('lineup.quick.writer') : !folder ? t('lineup.quick.folder') : '';
  if (issue) {
    const warning = document.createElement('div');
    warning.className = 'lineup-preset-warning';
    warning.setAttribute('role', 'status');
    warning.textContent = issue;
    form.appendChild(warning);
  }
  if (!enough) for (const member of config.agents.filter((agent) => !readyIds.includes(agent.id))) {
    const status = document.createElement('div');
    status.className = 'lineup-preset-status';
    status.textContent = `${member.name}: ${availability[member.id]?.detail || t('lineup.quick.unknown')}`;
    form.appendChild(status);
  }
  if (!folder) {
    const choose = document.createElement('button');
    choose.type = 'button';
    choose.className = 'lineup-action lineup-quick';
    controlLabel(choose, 'folderPlus', t('lineup.quick.chooseFolder'));
    choose.disabled = deps.running() || saving;
    choose.onclick = async () => { await deps.pickWorkDir(); if (preset) renderMenu(); };
    form.appendChild(choose);
  }
  if (!enough && deps.copilotTrio) {
    const trio = document.createElement('button');
    trio.type = 'button';
    trio.className = 'lineup-action lineup-quick lineup-trio';
    trio.dataset.teamAction = 'copilotTrio';
    controlLabel(trio, 'new', t('lineup.quick.copilotTrio'));
    trio.title = t('lineup.quick.copilotTrioTitle');
    trio.disabled = deps.running() || saving || refreshing;
    trio.onclick = async () => {
      if (saving || !deps.copilotTrio) return;
      saving = true;
      renderMenu();
      let ok = false;
      try { ok = await deps.copilotTrio(); } catch { ok = false; }
      saving = false;
      selection = null;
      if (!ok) note(t('lineup.quick.saveFailed'), true);
      renderMenu();
    };
    form.appendChild(trio);
  }
  if (!enough || !writer) {
    for (const action of ['connections', 'addMember', 'refresh'] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'lineup-action lineup-quick';
      button.dataset.teamAction = action;
      controlLabel(button, action === 'refresh' ? 'refresh' : action === 'connections' ? 'settings' : 'new', t(`lineup.quick.${action}`));
      button.disabled = deps.running() || saving || refreshing;
      button.onclick = async () => {
        if (action === 'refresh') {
          refreshing = true;
          renderMenu();
          try { await deps.refresh(); } catch { note(t('lineup.quick.refreshFailed'), true); }
          finally { refreshing = false; if (preset) renderMenu(); }
        } else {
          closeLineupMenu();
          if (action === 'connections') deps.openConnections(); else deps.addMember();
        }
      };
      form.appendChild(button);
    }
  }
  const actions = document.createElement('div');
  actions.className = 'lineup-preset-actions';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'ghost small';
  back.textContent = t('lineup.cancel');
  back.disabled = saving;
  back.onclick = () => { preset = null; selection = null; renderMenu(); menu.querySelector<HTMLElement>('[data-preset]')?.focus(); };
  const apply = document.createElement('button');
  apply.type = 'submit';
  apply.className = 'primary small lineup-quick';
  apply.id = 'lineup-preset-apply';
  controlLabel(apply, 'accept', t('lineup.quick.apply'));
  apply.disabled = !!issue || saving || refreshing;
  actions.append(back, apply);
  form.appendChild(actions);
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!selection || saving || refreshing || deps.running()) return;
    const current = deps.config();
    const states = deps.availability();
    const ids = roles.map((role) => selection![role]);
    if (new Set(ids).size !== 3 || !ids.every((id) => states[id]?.ready) || !current.settings.workDir.trim() || (kind === 'code' && !states[selection.authorId]?.writable)) { renderMenu(); return; }
    if (lineups().length >= LINEUPS_MAX) { note(t('lineup.full', { max: LINEUPS_MAX }), true); return; }
    const baseName = t(`lineup.quick.${kind}`);
    let name = baseName;
    for (let suffix = 2; lineups().some((lineup) => lineup.name === name); suffix++) name = `${baseName} ${suffix}`;
    const author = current.agents.find((agent) => agent.id === selection!.authorId)!;
    const members = roles.map((role) => ({ id: selection![role], persona: t(`lineup.quick.persona.${kind}.${role}`, { author: author.name }) }));
    const lineup: Lineup = { id: newId(), name, members, leadAgentId: selection.leadId, mode: 'guarded', maxRounds: Math.max(2, Math.min(10, current.settings.maxRounds || 3)), discussionMode: 'independent-first', workStyle: kind };
    const result = applyLineup(current, lineup);
    if (!result || result.missing) { renderMenu(); return; }
    if (!await commit({ ...result.config, lineups: [...lineups(), lineup] })) return;
    closeLineupMenu();
    note(t('lineup.applied', { name }));
  };
  menu.appendChild(form);
}

// 側欄成員清單上方的一行提示,幾秒後消失。換陣容會改掉整份成員清單,一定要說出剛剛發生了什麼
function note(text: string, warn = false): void {
  const el = $('#lineup-note');
  el.textContent = text;
  el.classList.toggle('warn', warn);
  el.hidden = false;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { el.hidden = true; }, warn ? 7000 : 4000);
}
