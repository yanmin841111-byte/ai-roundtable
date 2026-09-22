import { ReviewTimer } from '../src/task-review';
import { t } from './i18n';
import { controlLabel } from './icons';
import type { TaskSummary, TaskVerificationStatus } from './api';

let active: { id: string; stop: () => void } | null = null;
window.addEventListener('beforeunload', () => active?.stop());

export function renderReviewTiming(taskId: string, summary: TaskSummary, onOutcome: (outcome: ReviewTimer['data']['outcome']) => void, checkVersion: () => Promise<TaskVerificationStatus>) {
  if (active?.id === taskId) active.stop();
  const timer = new ReviewTimer(taskId, summary.endedAt, summary.endedAt - summary.startedAt, {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
  });
  const section = document.createElement('section');
  section.className = 'ts-review';
  const status = document.createElement('span');
  status.className = 'ts-review-status';
  status.setAttribute('aria-live', 'polite');
  const time = document.createElement('span');
  time.className = 'ts-review-time';
  time.title = t('task.review.timeTitle');
  const actions = document.createElement('div');
  actions.className = 'ts-review-actions';
  const error = document.createElement('span');
  error.className = 'ts-review-error';
  error.setAttribute('role', 'alert');
  let interval: ReturnType<typeof setInterval> | undefined;
  let freshness: TaskVerificationStatus['freshness'] = 'unknown';
  let accepting = false;
  const evidence = summary.verification?.revision ? `${summary.verification.revision}:${summary.verification.checkedAt}` : undefined;
  const acceptanceCurrent = () => timer.data.outcome === 'accepted' && !!evidence && timer.data.acceptedEvidence === evidence && freshness === 'current';

  function button(action: string, onClick: () => void): HTMLButtonElement {
    const control = document.createElement('button');
    control.type = 'button';
    control.dataset.action = action;
    controlLabel(control, action, t(`task.review.${action}`));
    if (action === 'export') control.className = 'icon-only';
    control.onclick = onClick;
    actions.appendChild(control);
    return control;
  }

  function update(): void {
    const state = timer.running ? 'running' : timer.data.outcome === 'pending' ? timer.data.startedAt === null ? 'notStarted' : 'paused' : timer.data.outcome === 'accepted' && !summary.verification ? 'manualAccepted' : timer.data.outcome === 'accepted' && !acceptanceCurrent() ? 'previousAccepted' : timer.data.outcome;
    section.dataset.state = state;
    status.textContent = t(`task.review.${state}`);
    const seconds = Math.floor(timer.data.reviewMs / 1000);
    time.textContent = t('task.review.time', { time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` });
    controlLabel(toggle, timer.running ? 'pause' : 'start', t(timer.running ? 'task.review.pause' : timer.data.startedAt === null ? 'task.review.start' : 'task.review.resume'));
    const accepted = state === 'accepted' || state === 'manualAccepted';
    accept.disabled = accepting || accepted;
    controlLabel(accept, 'accept', t(accepted ? 'task.review.accepted' : 'task.review.accept'));
    error.textContent = timer.saved ? '' : t('task.review.saveFailed');
    onOutcome(timer.data.outcome === 'accepted' && !acceptanceCurrent() ? 'pending' : timer.data.outcome);
  }

  function stop(): void {
    timer.pause();
    clearInterval(interval);
    if (active?.id === taskId) active = null;
    update();
  }

  const toggle = button('start', () => {
    if (timer.running) { stop(); return; }
    active?.stop();
    timer.start();
    active = { id: taskId, stop };
    interval = setInterval(() => {
      if (!section.isConnected) { stop(); return; }
      timer.checkpoint();
      update();
    }, 1000);
    update();
  });
  const accept = button('accept', async () => {
    accepting = true;
    accept.disabled = true;
    try {
      const result = await checkVersion();
      freshness = result.freshness;
      if (summary.verification && (freshness !== 'current' || !evidence)) {
        update();
        error.textContent = t('task.review.needsVerification');
        return;
      }
      stop(); timer.decide('accepted', evidence); update();
    } finally { accepting = false; accept.disabled = acceptanceCurrent() || (!summary.verification && timer.data.outcome === 'accepted'); }
  });
  button('incomplete', () => { stop(); timer.decide('incomplete'); update(); });
  button('export', async () => {
    freshness = (await checkVersion()).freshness;
    timer.checkpoint();
    update();
    const record = {
      timing: timer.data,
      measurement: 'Manually timed intervals; not automatic active-work tracking. Execution excludes planning. Human acceptance is not independent correctness verification.',
      verification: summary.verify ?? 'none',
      verificationEvidence: summary.verification ?? null,
      verificationHistory: summary.verificationHistory ?? [],
      reviewStale: summary.reviewStale === true,
      evidenceRevision: summary.verification?.revision ?? null,
      evidenceCheckedAt: summary.verification?.checkedAt ?? null,
      freshness,
      acceptanceCurrent: acceptanceCurrent(),
      rollback: summary.rollback ?? null,
      usage: summary.usage,
      memberOutcomes: summary.members.map((member) => member.outcome),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `review-${taskId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  section.append(status, time, actions, error);
  update();
  return { section, setFreshness: (value: TaskVerificationStatus['freshness']) => { freshness = value; update(); } };
}