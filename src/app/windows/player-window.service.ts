import { inject, Injectable } from '@angular/core';
import {
  getAllWebviewWindows,
  WebviewWindow,
} from '@tauri-apps/api/webviewWindow';

import { PlayerBoundsService } from './player-bounds.service';
import {
  isPlayerLabel,
  MAX_PLAYER_WINDOWS,
  playerWindowLabel,
  playerWindowUrl,
} from './window-target';

const DEFAULT_SIZE = { width: 960, height: 540 };
const MIN_SIZE = { width: 640, height: 360 };

/**
 * Окна с сериями. Сервис живёт в окне `main`: именно оно владеет навигацией,
 * из которой серию отрывают, и только оно знает порядок открытия.
 *
 * Разрешения новым окнам выдаёт отдельная капабилити `player` по шаблону
 * ярлыка `player-*` — см. `src-tauri/capabilities/player.json`. Ярлык, не
 * попавший под шаблон, откроет окно вообще без прав: вебвью запустится, а
 * плеер в нём молча не заработает.
 */
@Injectable({ providedIn: 'root' })
export class PlayerWindowService {
  private readonly bounds = inject(PlayerBoundsService);

  /** Порядок открытия: при исчерпании лимита поднимается самое старое окно. */
  private readonly openedLabels: string[] = [];

  /**
   * Открыть серию в отдельном окне либо поднять уже открытое.
   *
   * Лимит не декоративный: каждое окно — полноценный вебвью со своим hls.js,
   * который по конфигу держит до 200 МБ буфера вперёд.
   */
  async open(route: string, title: string): Promise<void> {
    const label = playerWindowLabel(route);
    const existing = await WebviewWindow.getByLabel(label);

    if (existing) {
      await this.raise(existing);
      return;
    }

    const labels = await this.playerLabels();

    if (labels.length >= MAX_PLAYER_WINDOWS) {
      await this.raiseOldest(labels);
      return;
    }

    const saved = await this.bounds.read();
    // Второе окно не должно лечь точно на первое: иначе кажется, что клик не
    // сработал. Каскад считается от числа уже открытых окон.
    const cascade = labels.length * 32;

    const created = new WebviewWindow(label, {
      url: playerWindowUrl(route),
      title,
      width: saved?.width ?? DEFAULT_SIZE.width,
      height: saved?.height ?? DEFAULT_SIZE.height,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      ...(saved
        ? { x: saved.x + cascade, y: saved.y + cascade }
        : { center: true }),
    });

    await new Promise<void>((resolve, reject) => {
      void created.once('tauri://created', () => resolve());
      void created.once<{ message?: string }>('tauri://error', (event) =>
        reject(new Error(event.payload?.message ?? 'Не удалось открыть окно'))
      );
    });

    this.openedLabels.push(label);
  }

  /** Закрыть все окна плееров — например, при выходе из приложения. */
  async closeAll(): Promise<void> {
    for (const label of await this.playerLabels()) {
      const window = await WebviewWindow.getByLabel(label);
      await window?.close().catch(() => undefined);
    }
  }

  private async playerLabels(): Promise<string[]> {
    const windows = await getAllWebviewWindows();

    return windows
      .map((window) => window.label)
      .filter((label) => isPlayerLabel(label));
  }

  /**
   * Порядок из `getAllWebviewWindows` не обещан, поэтому возраст окна берётся
   * из собственного журнала; закрытые окна из него вымываются на лету.
   */
  private async raiseOldest(labels: readonly string[]): Promise<void> {
    const alive = new Set(labels);
    const known = this.openedLabels.filter((label) => alive.has(label));
    this.openedLabels.length = 0;
    this.openedLabels.push(...known);

    const oldest = known[0] ?? labels[0];
    const window = oldest ? await WebviewWindow.getByLabel(oldest) : null;

    if (window) {
      await this.raise(window);
    }
  }

  private async raise(window: WebviewWindow): Promise<void> {
    await window.unminimize().catch(() => undefined);
    await window.setFocus().catch(() => undefined);
  }
}
