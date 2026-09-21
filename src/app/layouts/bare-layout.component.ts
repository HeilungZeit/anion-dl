import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { WatchProgressService } from '../api/watch-progress.service';
import { PlayerBoundsService } from '../windows/player-bounds.service';

/**
 * Окно с одной серией: ни шапки, ни отступов контейнера — только кадр.
 *
 * Сервисы приложения сюда намеренно не приезжают: очередью загрузок, значком
 * на доке и проверкой обновлений владеет окно `main`.
 */
@Component({
  selector: 'app-bare-layout',
  imports: [RouterOutlet],
  template: '<router-outlet />',
  styles: `
    :host {
      display: block;
      block-size: 100vh;
      background: #000;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BareLayoutComponent {
  private readonly progress = inject(WatchProgressService);
  private readonly bounds = inject(PlayerBoundsService);

  constructor() {
    const window = getCurrentWindow();

    // Позиция пишется в файл с задержкой в две секунды, а уничтожение вебвью
    // системой промис до конца не доводит: без перехвата закрытие крестиком
    // теряло бы последние секунды просмотра. Закрываем через `destroy`, а не
    // `close`: второй снова поднял бы это же событие.
    void window.onCloseRequested(async (event) => {
      event.preventDefault();

      await this.progress.flush().catch(() => undefined);
      await this.bounds.remember();
      await window.destroy();
    });
  }
}
