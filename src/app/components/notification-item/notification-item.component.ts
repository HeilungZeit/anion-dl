import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiIcon } from '@taiga-ui/core';

import type { AppNotification } from '../../api/notifications.service';

const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
});

const timeFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

/** Строка уведомления: общая для колокольчика в шапке и страницы уведомлений. */
@Component({
  selector: 'app-notification-item',
  imports: [RouterLink, TuiIcon],
  templateUrl: './notification-item.component.html',
  styleUrl: './notification-item.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotificationItemComponent {
  readonly notification = input.required<AppNotification>();
  readonly variant = input<'compact' | 'card'>('compact');
  /** Клик по уведомлению: оно ведёт на аниме и считается прочитанным. */
  readonly opened = output<AppNotification>();

  protected readonly date = computed(() =>
    (this.variant() === 'card' ? timeFormat : dateFormat).format(new Date(this.notification().createdAt))
  );
}
