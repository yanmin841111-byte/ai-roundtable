// 側欄的「陣容」選單:把目前誰上場、各自的角色、主持人、流程存起來,之後一鍵換回來。
// 套用、比對的規則在 src/lineups.ts;這裡只負責畫面。
import { t } from './i18n';
import { $ } from './util';
import { applyLineup, lineupFromConfig, lineupMatches, LINEUP_NAME_MAX, LINEUPS_MAX } from '../src/lineups';
import type { AppConfig, Lineup } from './api';

export interface LineupDeps {
  config: () => AppConfig;
  // 寫回設定、存檔、重畫側欄與流程選單
  commit: (next: AppConfig) => void;
  running: () => boolean;
}

let deps: LineupDeps;
let naming = false; // 選單底部正在輸入新陣容的名稱
let noteTimer: ReturnType<typeof setTimeout> | undefined;

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
  const menu = $('#lineup-menu');
  if (!menu.hidden) { closeLineupMenu(); return; }
  naming = false;
  menu.hidden = false;
  renderMenu();
  $<HTMLButtonElement>('#lineup-btn').setAttribute('aria-expanded', 'true');
  (menu.querySelector<HTMLElement>('.lineup-item:not(:disabled), .lineup-action') || menu).focus();
}

export function closeLineupMenu(): void {
  $('#lineup-menu').hidden = true;
  naming = false;
  $<HTMLButtonElement>('#lineup-btn').setAttribute('aria-expanded', 'false');
}

function modeLabel(mode: string): string { return t(mode === 'discuss' ? 'lineup.mode.discuss' : mode === 'relay' ? 'lineup.mode.relay' : 'lineup.mode.divide'); }

function renderMenu(): void {
  const menu = $('#lineup-menu');
  const config = deps.config();
  const cur = active();
  const busy = deps.running();
  menu.replaceChildren();

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

function save(name: string, id: string): void {
  const config = deps.config();
  const lineup = lineupFromConfig(config, name, id);
  if (!lineup.members.length || !lineup.name) return;
  const rest = lineups().filter((l) => l.id !== id);
  const replaced = rest.length !== lineups().length;
  // 設定檔載入時只留前 LINEUPS_MAX 個;多存的會在下次開啟時消失,所以在這裡就擋下來
  if (!replaced && lineups().length >= LINEUPS_MAX) { note(t('lineup.full', { max: LINEUPS_MAX }), true); return; }
  deps.commit({ ...config, lineups: replaced ? lineups().map((l) => (l.id === id ? lineup : l)) : [...rest, lineup], settings: { ...config.settings, activeLineupId: id } });
  naming = false;
  closeLineupMenu();
  note(t(replaced ? 'lineup.updated' : 'lineup.saved', { name: lineup.name }));
}

function apply(l: Lineup): void {
  if (deps.running()) return;
  const result = applyLineup(deps.config(), l);
  if (!result) { note(t('lineup.allMissing'), true); return; }
  deps.commit(result.config);
  closeLineupMenu();
  note(result.missing ? t('lineup.appliedMissing', { name: l.name, n: result.missing }) : t('lineup.applied', { name: l.name }), !!result.missing);
}

function remove(l: Lineup): void {
  if (!confirm(t('lineup.confirmDelete', { name: l.name }))) return;
  const config = deps.config();
  const settings = config.settings.activeLineupId === l.id ? { ...config.settings, activeLineupId: null } : config.settings;
  deps.commit({ ...config, lineups: lineups().filter((x) => x.id !== l.id), settings });
  renderMenu();
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
