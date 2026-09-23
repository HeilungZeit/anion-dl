import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  OnDestroy,
  untracked,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TuiButton, TuiIcon, TuiLoader } from '@taiga-ui/core';

import {
  type AppNotification,
  NotificationsService,
} from '../../api/notifications.service';
import { UserService } from '../../api/user.service';
import { NotificationItemComponent } from '../../components/notification-item/notification-item.component';

const dayFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', weekday: 'long' });

interface NotificationGroup {
  date: string;
  label: string;
  items: AppNotification[];
}

function dayLabel(date: Date, today: Date): string {
  const days = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() -
      new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) /
      86_400_000,
  );
  if (days === 0) return 'Сегодня';
  if (days === 1) return 'Вчера';
  return dayFormat.format(date);
}

@Component({
  selector: 'app-notifications',
  imports: [RouterLink, NotificationItemComponent, TuiButton, TuiIcon, TuiLoader],
  templateUrl: './notifications.component.html',
  styleUrl: './notifications.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotificationsComponent implements OnDestroy {
  protected readonly notifications = inject(NotificationsService);
  private readonly user = inject(UserService);
  private readonly router = inject(Router);

  protected readonly groups = computed<NotificationGroup[]>(() => {
    const today = new Date();
    const groups: NotificationGroup[] = [];
    for (const item of this.notifications.items()) {
      const date = new Date(item.createdAt);
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      const last = groups.at(-1);
      if (last?.date === key) last.items.push(item);
      else groups.push({ date: key, label: dayLabel(date, today), items: [item] });
    }
    return groups;
  });

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
