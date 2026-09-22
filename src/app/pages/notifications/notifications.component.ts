import {
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  OnDestroy,
  untracked,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import {
  type AppNotification,
  NotificationsService,
} from '../../api/notifications.service';
import { UserService } from '../../api/user.service';
import { NotificationItemComponent } from '../../components/notification-item/notification-item.component';

@Component({
  selector: 'app-notifications',
  imports: [RouterLink, NotificationItemComponent],
  templateUrl: './notifications.component.html',
  styleUrl: './notifications.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotificationsComponent implements OnDestroy {
  protected readonly notifications = inject(NotificationsService);
  private readonly user = inject(UserService);
  private readonly router = inject(Router);

  private readonly sentinel = viewChild<ElementRef<HTMLElement>>('sentinel');
  private observer: IntersectionObserver | null = null;

  constructor() {
    // Страница личная: гостя отправляем на вход, как закладки.
    effect(() => {
      if (!this.user.isInitialized()) return;
      if (this.user.isAuthenticated()) {
        untracked(() => void this.notifications.reload());
      } else {
        untracked(() => void this.router.navigate(['/login']));
      }
    });

    // Датчик в конце списка догружает следующую страницу, когда доскроллили.
    effect(() => {
      const sentinel = this.sentinel()?.nativeElement;
      this.observer?.disconnect();
      if (!sentinel) return;

      this.observer = new IntersectionObserver(([entry]) => {
        if (entry?.isIntersecting && !this.notifications.isLoading()) {
          void this.notifications.loadMore();
        }
      });
      this.observer.observe(sentinel);
    });
  }

  protected openNotification(notification: AppNotification): void {
    void this.notifications.markRead(notification.id);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }
}
