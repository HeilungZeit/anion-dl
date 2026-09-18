import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';

interface FinishedTask {
  title: string;
  episode: string;
}

export interface Notice {
  title: string;
  body: string;
}

function describe(task: FinishedTask): string {
  return `${task.title} — серия ${task.episode}`;
}

/**
 * Итог прогона очереди одним уведомлением. По штуке на серию «Скачать все»
 * засыпало бы центр уведомлений двумя десятками карточек.
 */
export function summarizeDownloads(
  done: readonly FinishedTask[],
  failed: readonly FinishedTask[]
): Notice | null {
  if (done.length === 0 && failed.length === 0) {
    return null;
  }

  if (failed.length === 0) {
    return done.length === 1
      ? { title: 'Серия скачана', body: describe(done[0]) }
      : { title: 'Загрузки завершены', body: `Скачано серий: ${done.length}` };
  }

  if (done.length === 0) {
    return failed.length === 1
      ? { title: 'Загрузка не удалась', body: describe(failed[0]) }
      : {
          title: 'Загрузки не удались',
          body: `Не скачано серий: ${failed.length}`,
        };
  }

  return {
    title: 'Загрузки завершены с ошибками',
    body: `Скачано: ${done.length}, с ошибкой: ${failed.length}`,
  };
}

/**
 * Разрешение спрашивается в момент, когда человек сам поставил серии в
 * очередь: тогда понятно, о чём будут уведомления. Спросить при запуске —
 * значит получить отказ «на всякий случай».
 */
export async function ensureNoticePermission(): Promise<void> {
  try {
    if (!(await isPermissionGranted())) {
      await requestPermission();
    }
  } catch {
    // Нет плагина или ОС не умеет — загрузки работают и без уведомлений.
  }
}

/** Уведомляем, только если человек не смотрит на окно: иначе он и так видит. */
export async function notifyIfAway(notice: Notice): Promise<void> {
  if (document.hasFocus()) {
    return;
  }

  try {
    if (await isPermissionGranted()) {
      sendNotification(notice);
    }
  } catch {
    // См. ensureNoticePermission.
  }
}
