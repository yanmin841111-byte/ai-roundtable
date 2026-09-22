import { t } from './i18n';
import { controlLabel } from './icons';
import type { TaskSummary, TaskVerificationStatus } from './api';

const views = new Map<string, { section: HTMLElement; refresh: () => Promise<TaskVerificationStatus> }>();
const unknown: TaskVerificationStatus = { freshness: 'unknown', canReverify: false, command: '', cwd: '' };

export function refreshTaskVerifications(): void {
  for (const [id, view] of views) {
    if (!view.section.isConnected) views.delete(id);
    else void view.refresh();
  }
}

window.addEventListener('focus', refreshTaskVerifications);

export function renderTaskVerification(taskId: string, summary: TaskSummary, onStatus: (value: TaskVerificationStatus) => void) {
  const section = document.createElement('section');
  section.className = 'ts-freshness';
  const status = document.createElement('span');
  status.className = 'ts-freshness-status';
  status.setAttribute('aria-live', 'polite');
  const scope = document.createElement('span');
  scope.className = 'ts-freshness-scope';
  scope.textContent = t('task.freshness.scope');
  const actions = document.createElement('div');
  actions.className = 'ts-review-actions';
  const compare = document.createElement('button');
  compare.type = 'button';
  compare.className = 'ts-compare icon-only';
  controlLabel(compare, 'refresh', t('task.freshness.compare'));
  const rerun = document.createElement('button');
  rerun.type = 'button';
  rerun.className = 'ts-reverify';
  controlLabel(rerun, 'start', t('task.freshness.rerun'));
  rerun.disabled = true;
  const error = document.createElement('span');
  error.className = 'ts-review-error';
  error.setAttribute('role', 'alert');
  actions.append(compare, rerun);
  section.append(status, scope, actions, error);
  let inFlight: Promise<TaskVerificationStatus> | null = null;
  let running = false;

  function display(value: TaskVerificationStatus): TaskVerificationStatus {
    section.dataset.freshness = value.freshness;
    status.textContent = t(`task.freshness.${value.freshness}`);
    status.title = new Date().toLocaleString(document.documentElement.lang || 'en');
    rerun.disabled = running || !value.canReverify;
    rerun.title = value.canReverify ? t('task.freshness.rerun') : t('task.freshness.unavailable');
    onStatus(value);
    return value;
  }

  function refresh(): Promise<TaskVerificationStatus> {
    if (inFlight) return inFlight;
    compare.disabled = true;
    inFlight = window.api.taskVerification(taskId).then(display).catch(() => display(unknown)).finally(() => {
      inFlight = null;
      compare.disabled = running;
    });
    return inFlight;
  }

  compare.onclick = () => { void refresh(); };
  rerun.onclick = async () => {
    const value = await refresh();
    if (!value.canReverify || running) return;
    if (!window.confirm(t('task.freshness.confirm', { cwd: value.cwd, commands: value.command || t('task.freshness.syntaxOnly') }))) return;
    running = true;
    compare.disabled = rerun.disabled = true;
    error.textContent = '';
    controlLabel(rerun, 'refresh', t('task.freshness.running'));
    try {
      const result = await window.api.reverifyTask(taskId, value.command);
      if (!result.ok) error.textContent = result.error || t('task.freshness.unavailable');
    } catch { error.textContent = t('task.freshness.unavailable'); }
    finally {
      running = false;
      controlLabel(rerun, 'start', t('task.freshness.rerun'));
      await refresh();
    }
  };
  display({ ...unknown, freshness: summary.verification?.freshness === 'stale' ? 'stale' : 'unknown' });
  const view = { section, refresh };
  views.set(taskId, view);
  queueMicrotask(() => { if (section.isConnected) void refresh(); });
  return view;
}