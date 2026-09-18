import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiIcon } from '@taiga-ui/core';

/**
 * Ошибка загрузки с кнопкой «Повторить».
 *
 * Без кнопки единственным способом повторить был уход со страницы и
 * возвращение. Чаще всего причина — пропавшая сеть, поэтому рядом подсказка:
 * скачанные серии смотрятся и без неё.
 */
@Component({
  selector: 'app-load-error',
  imports: [RouterLink, TuiIcon],
  template: `
    <div class="load-error" role="alert">
      <tui-icon class="load-error__icon" icon="@tui.wifi-off" />
      <strong>{{ title() }}</strong>
      @if (message()) {
        <span class="load-error__message">{{ message() }}</span>
      }
      <button class="load-error__retry" type="button" (click)="retry.emit()">
        <tui-icon icon="@tui.rotate-ccw" />
        Повторить
      </button>
      @if (offlineHint()) {
        <span class="load-error__hint">
          Нет сети? Скачанные серии можно смотреть в
          <a routerLink="/downloads">Загрузках</a>.
        </span>
      }
    </div>
  `,
  styles: `
    .load-error {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--anion-space-8);
      padding: var(--anion-space-32) var(--anion-space-16);
      color: var(--anion-text-secondary);
      font-size: var(--anion-font-size-13);
      text-align: center;

      strong {
        color: var(--anion-text-primary);
        font-size: var(--anion-font-size-16);
      }
    }

    .load-error__icon {
      color: var(--anion-negative-text);
      font-size: var(--anion-icon-24);
    }

    .load-error__message {
      max-inline-size: 520px;
      overflow-wrap: anywhere;
    }

    .load-error__retry {
      display: inline-flex;
      align-items: center;
      gap: var(--anion-space-6);
      margin-block-start: var(--anion-space-4);
      padding: var(--anion-space-8) var(--anion-space-16);
      border: 1px solid var(--anion-border);
      border-radius: var(--anion-radius-md);
      background: var(--anion-surface-2);
      color: var(--anion-text-primary);
      cursor: pointer;
      font: inherit;
      font-weight: 600;
      outline: none;

      &:hover,
      &:focus-visible {
        border-color: var(--anion-accent-a60);
        background: var(--anion-accent-a15);
      }

      &:focus-visible {
        box-shadow: var(--anion-focus-ring);
      }
    }

    .load-error__hint a {
      color: var(--anion-accent-text);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoadErrorComponent {
  readonly title = input.required<string>();
  readonly message = input<string | undefined>('');
  /** Подсказка про загрузки уместна на страницах, которые без сети пусты. */
  readonly offlineHint = input(false);

  readonly retry = output<void>();
}
