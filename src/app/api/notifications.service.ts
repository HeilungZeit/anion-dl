import { inject, Injectable, signal } from '@angular/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

import type { Notice } from './download-notice';
import { notifyIfAway } from './download-notice';
import { ApiClient } from './http';
import { UserService } from './user.service';

/** Запись колокольчика в том виде, в каком её отдаёт `GET /notifications`. */
export interface AppNotification {
  id: number;
  type: 'new_episode' | 'anime_finished';
  animeId: number;
  episode: number;
  title: string;
  read: boolean;
}

interface NotificationsPage {
  items: AppNotification[];
}

// Проверка серий на бэке идёт не чаще раза в 40 минут, чаще спрашивать
// незачем. Приложение живёт в фоне часами (очередь загрузок), и без опроса
// системное уведомление о серии не пришло бы никогда: при фокусе окна
// человек видит бейдж и так.
const POLL_INTERVAL_MS = 40 * 60 * 1000;
// tick отвечает сразу, а проверка на бэке укладывается в ~20 с.
const AFTER_TICK_DELAY_MS = 30 * 1000;
const LAST_NOTIFIED_KEY = 'anion_notifications_last_notified_id';

function describe(item: AppNotification): string {
  return item.type === 'new_episode'
    ? `Вышла ${item.episode} серия: ${item.title}`
    : `${item.title} вышло полностью, подписка снята`;
}

/**
 * Что показать системным уведомлением: только непрочитанное, пришедшее после
 * последнего показанного. Одна запись — её текст, несколько — одна сводка,
 * чтобы не засыпать центр уведомлений.
 */
export function summarizeNotifications(
  items: readonly AppNotification[],
  lastNotifiedId: number
): Notice | null {
  const fresh = items.filter((item) => !item.read && item.id > lastNotifiedId);

  if (fresh.length === 0) {
    return null;
  }

  return fresh.length === 1
    ? { title: 'Anion', body: describe(fresh[0]) }
    : { title: 'Новые серии', body: `Новых уведомлений: ${fresh.length}` };
}

function readLastNotifiedId(): number | null {
  try {
    const raw = localStorage.getItem(LAST_NOTIFIED_KEY);
    return raw === null ? null : Number(raw) || 0;
  } catch {
    return null;
  }
}

function writeLastNotifiedId(id: number): void {
  try {
    localStorage.setItem(LAST_NOTIFIED_KEY, String(id));
  } catch {
    // Без хранилища уведомление просто может повториться после перезапуска.
  }
}

/**
 * Колокольчик десктопа: счётчик непрочитанных и системное уведомление о новых
 * сериях. Сами уведомления читаются на сайте — здесь только сигнал, что они
 * есть. Заодно шлёт tick: проверку серий на бэке запускают клиенты.
 */
@Injectable({ providedIn: 'root' })
export class NotificationsService {
  private readonly api = inject(ApiClient);
  private readonly users = inject(UserService);

  private readonly count = signal(0);
  readonly unreadCount = this.count.asReadonly();

  private started = false;

  /** Вызывается один раз из окна `main`: окну плеера колокольчик не нужен. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    const poll = (): void => {
      this.tick();
      setTimeout(() => void this.refresh(), AFTER_TICK_DELAY_MS);
    };

    poll();
    setInterval(poll, POLL_INTERVAL_MS);

    void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) {
        this.tick();
        void this.refresh();
      }
    });
  }

  /** Обновляет счётчик и, если пришло новое, показывает системное уведомление. */
  async refresh(): Promise<void> {
    if (!this.users.isAuthenticated()) {
      this.count.set(0);
      return;
    }

    try {
      const { count } = await this.api.get<{ count: number }>(
        '/notifications/unread-count'
      );
      this.count.set(count);
      if (count > 0) {
        await this.notifyAboutFresh();
      } else if (readLastNotifiedId() === null) {
        // Непрочитанного нет — любое будущее непрочитанное будет новым.
        writeLastNotifiedId(0);
      }
    } catch {
      // Счётчик не критичен: остаётся прошлое значение.
    }
  }

  clear(): void {
    this.count.set(0);
  }

  private tick(): void {
    this.api.post<unknown>('/jobs/tick').catch(() => {
      // Фоновая задача: её ошибка пользователя не касается.
    });
  }

  private async notifyAboutFresh(): Promise<void> {
    const { items } = await this.api.get<NotificationsPage>(
      '/notifications?limit=20'
    );
    const newestId = items[0]?.id ?? 0;
    const lastNotifiedId = readLastNotifiedId();

    // Первый запуск: всё, что накопилось до установки, — не новость.
    if (lastNotifiedId === null) {
      writeLastNotifiedId(newestId);
      return;
    }

    const notice = summarizeNotifications(items, lastNotifiedId);
    if (newestId > lastNotifiedId) {
      writeLastNotifiedId(newestId);
    }
    if (notice) {
      await notifyIfAway(notice);
    }
  }
}
