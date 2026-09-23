// 還原這次任務的改動。破壞性操作:一定先問過,結果照實說。
import { t } from './i18n';
import { cleanIpcError } from './util';
import { loadDiff } from './diff-view';

// scope:'task' 還原整個任務;'repair' 只收回修復回合(執行階段的成果留著)
export async function revertTask(button: HTMLButtonElement, scope: 'task' | 'repair' = 'task'): Promise<void> {
  if (!confirm(t(scope === 'repair' ? 'task.revertFixConfirm' : 'task.revertConfirm'))) return;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = t('task.reverting');
  try {
    const r = await window.api.revertTask(scope);
    // 還原不了的檔案要說出來,不能讓人以為工作目錄已經乾淨了
    const message = r.ok && !r.skipped.length
      ? t(scope === 'repair' ? 'task.revertFixDone' : 'task.revertDone', { restored: r.restored, deleted: r.deleted })
      : r.reason === 'running' ? t('task.revertRunning')
        : r.reason === 'busy' ? t('task.revertBusy')
        : r.reason === 'stale' ? t('task.revertStale')
        : r.reason === 'no-baseline' ? t('task.revertNoBaseline')
          : t('task.revertPartly', { restored: r.restored, deleted: r.deleted, list: [...r.skipped, ...r.failed.map((f) => f.file)].join('、') });
    alert(message);
    // 「檔案改動」開著的話順手重整,免得還停在還原前的畫面
    if (!document.querySelector<HTMLDivElement>('#diff-modal')?.classList.contains('hidden')) await loadDiff();
  } catch (error) {
    alert(t('task.revertFailed', { error: cleanIpcError(error) }));
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}
