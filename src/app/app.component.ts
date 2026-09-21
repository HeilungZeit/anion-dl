import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TuiRoot } from '@taiga-ui/core';

import { BareLayoutComponent } from './layouts/bare-layout.component';
import { ShellLayoutComponent } from './layouts/shell-layout.component';
import { currentWindowTarget } from './windows/current-window';

/**
 * Корень приложения раздаёт окну его разметку и больше ничего не делает.
 *
 * Шапка, аккаунт, очередь загрузок и значок на доке уехали в
 * `ShellLayoutComponent`: каждое окно Tauri — отдельный вебвью со своим
 * экземпляром Angular, и сервисы, поднятые в корне, поднялись бы в каждом
 * окне. Для очереди загрузок это означало бы второй ffmpeg на ту же задачу.
 */
@Component({
  selector: 'app-root',
  imports: [TuiRoot, BareLayoutComponent, ShellLayoutComponent],
  template: `
    <tui-root tuiTheme="dark">
      @if (isPlayerWindow) {
        <app-bare-layout />
      } @else {
        <app-shell-layout />
      }
    </tui-root>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  readonly isPlayerWindow = currentWindowTarget().kind === 'player';
}
