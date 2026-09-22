import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { TuiButton } from '@taiga-ui/core';
import { TuiButtonLoading } from '@taiga-ui/kit';

import { NotificationsService } from '../../../../api/notifications.service';
import { UserService } from '../../../../api/user.service';

// Подписка имеет смысл, пока серии ещё выходят. Вышедший тайтл бэк сам
// снимает с подписки и присылает «вышло полностью».
const SUBSCRIBABLE_STATUSES = new Set(['ongoing', 'announcement']);

/** «Уведомлять о новых сериях» — как на сайте, под кнопкой закладки. */
@Component({
  selector: 'app-subscribe-button',
  imports: [TuiButton, TuiButtonLoading],
  template: `
    @if (visible()) {
      <button
        tuiButton
        type="button"
        size="m"
        class="subscribe"
        [appearance]="subscribed() ? 'secondary' : 'outline-grayscale'"
        [iconStart]="subscribed() ? '@tui.bell-ring' : '@tui.bell'"
        [loading]="subscribed() === null || busy()"
        [attr.aria-pressed]="subscribed()"
        (click)="toggle()"
      >
        {{ subscribed() ? 'Уведомления включены' : 'Уведомлять о новых сериях' }}
      </button>
    }
  `,
  styles: `
    // Кнопка второстепенная: рядом с закладкой она не должна спорить за
    // внимание. Акцент появляется, только когда подписка включена.
    .subscribe {
      inline-size: 100%;
      font-size: var(--anion-font-size-14);
      font-weight: 500;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SubscribeButtonComponent {
  readonly animeId = input.required<number>();
  readonly statusAlias = input<string | undefined>('');

  private readonly user = inject(UserService);
  private readonly notifications = inject(NotificationsService);

  protected readonly visible = computed(
    () =>
      this.user.isAuthenticated() &&
      SUBSCRIBABLE_STATUSES.has(this.statusAlias() ?? '')
  );
  /** null — состояние ещё не загружено. */
  protected readonly subscribed = signal<boolean | null>(null);
  protected readonly busy = signal(false);

  constructor() {
    // Состояние подписки грузим заново при переходе на другое аниме.
    effect(() => {
      const animeId = this.animeId();
      if (!this.visible()) return;

      untracked(() => this.subscribed.set(null));
      this.notifications
        .isSubscribed(animeId)
        .then((subscribed) => {
          if (this.animeId() === animeId) this.subscribed.set(subscribed);
        })
        .catch(() => {
          if (this.animeId() === animeId) this.subscribed.set(false);
        });
    });
  }

  protected async toggle(): Promise<void> {
    const current = this.subscribed();
    if (current === null || this.busy()) return;

    this.busy.set(true);
    try {
      this.subscribed.set(
        await this.notifications.setSubscribed(this.animeId(), !current)
      );
    } catch {
      // Состояние не поменялось — кнопка остаётся как была.
    } finally {
      this.busy.set(false);
    }
  }
}
