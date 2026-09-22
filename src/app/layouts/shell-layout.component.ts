import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  HostListener,
  inject,
  OnInit,
} from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import { TuiIcon } from '@taiga-ui/core';

import { SITE_BASE_URL } from '../api/api.config';
import { BookmarksService } from '../api/bookmarks.service';
import { ensureNoticePermission } from '../api/download-notice';
import { DownloadService } from '../api/download.service';
import { NotificationsService } from '../api/notifications.service';
import { RemoteWatchProgressService } from '../api/remote-watch-progress.service';
import { UpdateService } from '../api/update.service';
import { UserService } from '../api/user.service';
import { PlayerWindowService } from '../windows/player-window.service';

/**
 * Обычное окно приложения: шапка, аккаунт, значок очереди.
 *
 * Здесь же поднимаются сервисы приложения — и это не деталь разметки, а
 * граница ответственности окон. Очередь загрузок, апдейтер и значок на доке
 * принадлежат окну `main`; окно плеера рисует `BareLayoutComponent` и ничего
 * из этого не касается.
 */
@Component({
  selector: 'app-shell-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, TuiIcon],
  templateUrl: './shell-layout.component.html',
  styleUrl: './shell-layout.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShellLayoutComponent implements OnInit {
  private readonly updates = inject(UpdateService);
  private readonly users = inject(UserService);
  private readonly bookmarks = inject(BookmarksService);
  private readonly remoteProgress = inject(RemoteWatchProgressService);
  private readonly router = inject(Router);

  // Сервис инжектится в шапке, а значит поднимается при старте приложения:
  // прерванная выходом очередь возобновляется сразу, а не когда пользователь
  // случайно зайдёт на страницу загрузок.
  private readonly downloads = inject(DownloadService);
  private readonly playerWindows = inject(PlayerWindowService);
  private readonly notifications = inject(NotificationsService);

  readonly unreadCount = this.notifications.unreadCount;
  readonly pendingCount = computed(() => this.downloads.pending().length);

  constructor() {
    const window = getCurrentWindow();

    // Приложение завершается, когда закрыто последнее окно. Оставленное окно
    // плеера удержало бы процесс живым после закрытия главного, поэтому
    // сначала закрываем их — каждое досохранит свою позицию само.
    void window.onCloseRequested(async (event) => {
      event.preventDefault();

      await this.playerWindows.closeAll();
      await window.destroy();
    });

    // Число загрузок в работе — и на значке приложения: очередь качается
    // часами, и смотреть на неё удобнее из дока, не разворачивая окно.
    // На Windows значков нет — там это тихо не срабатывает.
    effect(() => {
      const count = this.pendingCount();

      void getCurrentWindow()
        .setBadgeCount(count > 0 ? count : undefined)
        .catch(() => undefined);
    });
  }

  readonly isInitialized = this.users.isInitialized;
  readonly isAuthenticated = this.users.isAuthenticated;
  readonly displayName = this.users.displayName;
  readonly email = computed(() => this.users.user()?.email ?? '');

  /** Монограмма вместо аватарки: своих картинок у бэка нет. */
  readonly monogram = computed(
    () => this.displayName().charAt(0).toUpperCase() || '?'
  );

  ngOnInit(): void {
    void this.updates.checkForUpdates();

    // Сессия живёт в куке httpOnly, и увидеть её из JS нельзя. Единственный
    // способ узнать, вошли мы или нет, — спросить бэк при старте.
    void this.users.fetchUser();

    this.notifications.start();
  }

  /**
   * Уведомления читаются на сайте. Клик по колокольчику — момент, когда
   * человек сам интересуется уведомлениями, поэтому разрешение на системные
   * уведомления спрашиваем здесь, а не при запуске.
   */
  async openNotifications(): Promise<void> {
    await ensureNoticePermission();
    await openUrl(`${SITE_BASE_URL}/notifications`);
  }

  /** Правка профиля живёт на сайте: в десктопе ей делать нечего. */
  openProfile(): Promise<void> {
    return openUrl(`${SITE_BASE_URL}/profile`);
  }

  async logout(): Promise<void> {
    // После выхода сессии нет: неотправленные отметки уходят до него.
    await this.remoteProgress.flush();
    await this.users.logout();
    this.bookmarks.clear();
    this.remoteProgress.clear();
    this.notifications.clear();
  }

  @HostListener('document:keydown', ['$event'])
  openSearch(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (
      event.key !== '/' ||
      target?.matches('input, textarea, select, [contenteditable="true"]')
    ) {
      return;
    }

    event.preventDefault();
    void this.router.navigate(['/search']);
  }
}
