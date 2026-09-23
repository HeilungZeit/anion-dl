import { inject, Injectable, signal } from '@angular/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

import type { Notice } from './download-notice';
import { notifyIfAway } from './download-notice';
import { ApiClient } from './http';
import { UserService } from './user.service';

/**
 * Запись колокольчика в том виде, в каком её отдаёт `GET /notifications`.
 * Название, постер и слаг — снимок на момент события, поэтому список
 * рисуется без запросов за данными аниме.
 */
export interface AppNotification {
  id: number;
  type: 'new_episode' | 'anime_finished';
  animeId: number;
  /** 0 у anime_finished. */
  episode: number;
  title: string;
  poster: string;
  animeUrl: string;
  /** Озвучки, где серия уже вышла. Дописываются, пока уведомление не прочитано. */
  dubbings: string[];
  createdAt: string;
  read: boolean;
}

interface NotificationsPage {
  items: AppNotification[];
  /** id для следующей страницы; null — страниц больше нет. */
  nextCursor: number | null;
}

interface SubscriptionState {
  subscribed: boolean;
}

const PAGE_SIZE = 20;

// Проверка серий на бэке идёт не чаще раза в 30 минут, чаще спрашивать
// незачем. Приложение живёт в фоне часами (очередь загрузок), и без опроса
// системное уведомление о серии не пришло бы никогда: при фокусе окна
// человек видит бейдж и так.
const POLL_INTERVAL_MS = 30 * 60 * 1000;
// tick отвечает сразу, а проверка на бэке укладывается в ~20 с.
const AFTER_TICK_DELAY_MS = 30 * 1000;
const LAST_NOTIFIED_KEY = 'anion_notifications_last_notified_id';

/** Текст уведомления — общий для списка и системного уведомления. */
export function describeNotification(item: AppNotification): string {
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
    ? { title: 'Anion', body: describeNotification(fresh[0]) }
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
 * Колокольчик десктопа: счётчик, список уведомлений, подписка на тайтл и
 * системное уведомление о новых сериях. Заодно шлёт tick: проверку серий на
 * бэке запускают клиенты.
 */
@Injectable({ providedIn: 'root' })
export class NotificationsService {
  private readonly api = inject(ApiClient);
  private readonly users = inject(UserService);

  private readonly count = signal(0);
  private readonly list = signal<AppNotification[]>([]);
  private readonly cursor = signal<number | null>(null);
  private readonly loaded = signal(false);
  private readonly loading = signal(false);

  readonly unreadCount = this.count.asReadonly();
  readonly items = this.list.asReadonly();
  readonly nextCursor = this.cursor.asReadonly();
  readonly isLoaded = this.loaded.asReadonly();
  readonly isLoading = this.loading.asReadonly();

  private started = false;
  private pendingPage: Promise<void> | null = null;

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

  /** Первая страница заново: при открытии колокольчика и странице уведомлений. */
  reload(): Promise<void> {
    return this.loadPage(null);
  }

  loadMore(): Promise<void> {
    const cursor = this.cursor();
    return cursor === null ? Promise.resolve() : this.loadPage(cursor);
  }

  async markRead(id: number): Promise<void> {
    const item = this.list().find((notification) => notification.id === id);
    if (item?.read) {
      return;
    }

    this.markLocallyRead((notification) => notification.id === id);
    this.count.update((count) => Math.max(0, count - 1));
    try {
      await this.api.post<unknown>(`/notifications/${id}/read`);
    } catch {
      // Не записалось — при следующем обновлении счётчик вернёт правду.
    }
  }

  async markAllRead(): Promise<void> {
    this.markLocallyRead(() => true);
    this.count.set(0);
    try {
      await this.api.post<unknown>('/notifications/read-all');
    } catch {
      // Не записалось — при следующем обновлении счётчик вернёт правду.
    }
  }

  async isSubscribed(animeId: number): Promise<boolean> {
    const state = await this.api.get<SubscriptionState>(
      `/subscriptions/${animeId}`
    );
    return state.subscribed;
  }

  async setSubscribed(animeId: number, subscribed: boolean): Promise<boolean> {
    const path = `/subscriptions/${animeId}`;
    const state = subscribed
      ? await this.api.put<SubscriptionState>(path)
      : await this.api.delete<SubscriptionState>(path);
    return state.subscribed;
  }

  clear(): void {
    this.count.set(0);
    this.list.set([]);
    this.cursor.set(null);
    this.loaded.set(false);
  }

  private loadPage(cursor: number | null): Promise<void> {
    if (this.pendingPage) {
      return this.pendingPage;
    }

    this.loading.set(true);
    const query = cursor === null ? '' : `&cursor=${cursor}`;
    this.pendingPage = this.api
      .get<NotificationsPage>(`/notifications?limit=${PAGE_SIZE}${query}`)
      .then((page) => {
        this.list.update((items) =>
          cursor === null ? page.items : [...items, ...page.items]
        );
        this.cursor.set(page.nextCursor);
        this.loaded.set(true);
      })
      .catch(() => {
        // Список недоступен — показываем то, что уже загружено.
      })
      .finally(() => {
        this.loading.set(false);
        this.pendingPage = null;
      });
    return this.pendingPage;
  }

  private markLocallyRead(predicate: (item: AppNotification) => boolean): void {
    this.list.update((items) =>
      items.map((item) => (predicate(item) ? { ...item, read: true } : item))
    );
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
