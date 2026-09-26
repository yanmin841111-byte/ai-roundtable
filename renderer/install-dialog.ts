// 內建 CLI 的安裝視窗:安裝 → 登入 → 開始使用。指令由主程序決定,這裡只顯示並回報進度。
import type { CliHealth, CliInstallPlan, CliInstallResult, InstallTool } from './api';
import { t } from './i18n';
import { $, escapeHtml } from './util';
import { envFixHtml, bindEnvFix } from './env-fix';

type Step = 'install' | 'login' | 'ready';

let plan: CliInstallPlan | null = null;
let tool: InstallTool | null = null;
let running = false;
let refresh: () => Promise<Record<string, CliHealth>> = async () => ({});

const OS_NAMES: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
const TOOL_NAMES: Record<string, string> = { brew: 'Homebrew', winget: 'WinGet', npm: 'npm' };
const MAX_LOG_LINES = 400;

export const isInstallRunning = (): boolean => running;

export function setupInstallDialog(refreshHealth: () => Promise<Record<string, CliHealth>>): void {
  refresh = refreshHealth;
  $<HTMLButtonElement>('#install-start').onclick = () => { void start(); };
  $<HTMLButtonElement>('#install-cancel').onclick = () => { void window.api.cliInstall.cancel(); };
  $<HTMLButtonElement>('#install-recheck').onclick = () => { void recheck(); };
  $<HTMLButtonElement>('#install-close').onclick = close;
  $<HTMLButtonElement>('#install-done').onclick = close;
  $<HTMLButtonElement>('#install-docs').onclick = () => { if (plan) window.open(plan.docsUrl, '_blank'); };
  $<HTMLButtonElement>('#install-copy').onclick = () => {
    const button = $<HTMLButtonElement>('#install-copy');
    void navigator.clipboard.writeText($('#install-command-text').textContent || '').then(() => {
      button.textContent = t('fix.copied');
      setTimeout(() => { button.textContent = t('fix.copy'); }, 1600);
    }).catch(() => {});
  };
  window.api.cliInstall.onOutput(({ cliId, line }) => { if (plan && cliId === plan.cliId) appendLog(line); });
}

export async function openInstallDialog(cliId: string): Promise<void> {
  if (running) { $('#install-modal').classList.remove('hidden'); return; }
  plan = await window.api.cliInstall.plan(cliId);
  if (!plan) return;
  const methods = plan.methods;
  tool = methods[0]?.tool || null;
  $('#install-title').textContent = t('install.title', { name: plan.label });
  $('#install-system').textContent = t('install.system', { os: OS_NAMES[plan.platform] || plan.platform });
  $('#install-requirement').textContent = t(`install.req.${plan.cliId}`);
  renderMethods();
  $('#install-choice').hidden = !methods.length;
  $<HTMLPreElement>('#install-log').textContent = '';
  $('#install-log-box').hidden = true;
  setStatus(methods.length ? '' : t('install.noMethod'), methods.length ? '' : 'warn');
  setStep('install');
  setButtons({ start: !!methods.length, startLabel: t('install.start') });
  $('#install-modal').classList.remove('hidden');
  $<HTMLButtonElement>(methods.length ? '#install-start' : '#install-docs').focus();
}

function renderMethods(): void {
  const box = $('#install-methods');
  box.innerHTML = '';
  for (const method of plan?.methods || []) {
    const label = document.createElement('label');
    label.className = 'install-method';
    const name = TOOL_NAMES[method.tool] || t('install.tool.official');
    label.innerHTML = `<input type="radio" name="install-method" value="${escapeHtml(method.tool)}"${method.tool === tool ? ' checked' : ''}>`
      + `<span><b>${escapeHtml(name)}</b>${method.recommended ? `<em>${escapeHtml(t('install.recommended'))}</em>`: ''}<small>${escapeHtml(t(`install.tool.${method.tool}Desc`))}</small></span>`;
    label.querySelector('input')!.onchange = () => { tool = method.tool; renderCommand(); };
    box.appendChild(label);
  }
  box.hidden = (plan?.methods.length || 0) < 2;
  renderCommand();
}

function renderCommand(): void {
  const method = plan?.methods.find((item) => item.tool === tool);
  $('#install-command-text').textContent = method?.command || '';
  $('#install-command-note').textContent = method ? t(`install.note.${method.tool}`) : '';
}

function appendLog(line: string): void {
  const log = $<HTMLPreElement>('#install-log');
  const lines = `${log.textContent ? `${log.textContent}\n` : ''}${line}`.split('\n');
  log.textContent = lines.slice(-MAX_LOG_LINES).join('\n');
  $('#install-log-box').hidden = false;
  log.scrollTop = log.scrollHeight;
}

function setStep(step: Step, failed = false): void {
  const order: Step[] = ['install', 'login', 'ready'];
  document.querySelectorAll<HTMLElement>('#install-steps [data-step]').forEach((item) => {
    const index = order.indexOf(item.dataset.step as Step);
    const current = order.indexOf(step);
    item.classList.toggle('done', index < current || (step === 'ready' && index === current));
    item.classList.toggle('current', index === current && step !== 'ready');
    item.classList.toggle('failed', failed && index === current);
    item.toggleAttribute('aria-current', index === current);
  });
}

function setStatus(message: string, tone: '' | 'ok' | 'warn' | 'error' | 'busy', extra = ''): void {
  const box = $('#install-status');
  box.hidden = !message && !extra;
  box.className = `install-status${tone ? ` ${tone}` : ''}`;
  box.innerHTML = `${message ? `<div class="install-status-line">${tone === 'busy' ? '<span class="spinner"></span>' : ''}<span>${escapeHtml(message)}</span></div>` : ''}${extra}`;
  bindEnvFix(box);
  // 登入指令送進內建終端時,視窗不能擋在終端前面;設定是改完就存,一起收起不會遺失內容
  box.querySelectorAll('[data-env-run]').forEach((button) => button.addEventListener('click', () => {
    close();
    $('#settings').classList.add('hidden');
  }));
}

function setButtons({ start = false, startLabel = t('install.start'), recheck = false }: { start?: boolean; startLabel?: string; recheck?: boolean } = {}): void {
  $('#install-start').hidden = !start || running;
  $('#install-start').textContent = startLabel;
  $('#install-cancel').hidden = !running;
  $('#install-recheck').hidden = !recheck || running;
  $<HTMLButtonElement>('#install-close').disabled = running;
  $<HTMLButtonElement>('#install-done').disabled = running;
  document.querySelectorAll<HTMLInputElement>('#install-methods input').forEach((input) => { input.disabled = running; });
}

async function start(): Promise<void> {
  if (!plan || !tool || running) return;
  running = true;
  $<HTMLPreElement>('#install-log').textContent = '';
  setStep('install');
  setStatus(t('install.running'), 'busy');
  setButtons();
  let result: CliInstallResult;
  try { result = await window.api.cliInstall.run(plan.cliId, tool); }
  catch (error) { result = { ok: false, reason: 'failed', detail: String(error) }; }
  running = false;
  if (!result.ok) {
    setStep('install', true);
    setStatus(t(`install.error.${result.reason || 'failed'}`, { code: result.code ?? '?' }), result.reason === 'canceled' ? 'warn' : 'error');
    setButtons({ start: result.reason !== 'unavailable', startLabel: t('install.retry') });
    if (result.reason === 'failed') $<HTMLDetailsElement>('#install-log-box').open = true;
    return;
  }
  const all = await refresh();
  showHealth(all[plan.cliId] || result.health);
}

async function recheck(): Promise<void> {
  if (!plan) return;
  setStatus(t('install.checking'), 'busy');
  setButtons();
  showHealth((await refresh())[plan.cliId]);
}

function showHealth(health: CliHealth | undefined): void {
  if (!plan) return;
  const version = health?.version ? ` ${health.version}` : '';
  const loginFix = envFixHtml(health?.fix?.command ? health.fix : { command: plan.loginCommand });
  if (health?.state === 'ready' && plan.detectsLogin) {
    setStep('ready');
    setStatus(t('install.ready', { version }), 'ok');
    setButtons();
  } else if (health?.state === 'ready') {
    setStep('login');
    setStatus(t('install.installedLogin', { version }), 'ok', loginFix);
    setButtons();
  } else if (health?.state === 'unauthenticated') {
    setStep('login');
    setStatus(health.hint || t('install.needLogin'), 'warn', loginFix);
    setButtons({ recheck: true });
  } else {
    setStep('install', true);
    setStatus(t('install.notFound'), 'warn');
    setButtons({ recheck: true });
  }
}

function close(): void {
  if (running) return;
  $('#install-modal').classList.add('hidden');
}
