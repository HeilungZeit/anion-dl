import { Injectable } from '@angular/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LazyStore } from '@tauri-apps/plugin-store';

const STORE_FILE = 'windows.json';
const BOUNDS_KEY = 'playerBounds';

/** Логические пиксели: физические зависят от монитора, на который перенесли окно. */
export interface PlayerBounds {
  width: number;
  height: number;
  x: number;
  y: number;
}

/**
 * Память о размере и месте окна плеера.
 *
 * Плагин `window-state` решал бы это из Rust, но он хранит геометрию по ярлыку
 * окна, а ярлык у нас — функция от серии. Каждая новая серия получала бы
 * пустую запись, а файл состояния копил бы по строке на каждую когда-либо
 * открытую серию. Одна общая запись на все окна плеера ведёт себя ровно так,
 * как человек и ожидает: следующая серия открывается там же, где прошлая.
 */
@Injectable({ providedIn: 'root' })
export class PlayerBoundsService {
  private readonly store = new LazyStore(STORE_FILE);

  async read(): Promise<PlayerBounds | null> {
    try {
      return (await this.store.get<PlayerBounds>(BOUNDS_KEY)) ?? null;
    } catch {
      return null;
    }
  }

  /** Снять геометрию текущего окна и запомнить её. */
  async remember(): Promise<void> {
    try {
      const window = getCurrentWindow();
      const scale = await window.scaleFactor();
      const size = (await window.innerSize()).toLogical(scale);
      const position = (await window.outerPosition()).toLogical(scale);

      await this.store.set(BOUNDS_KEY, {
        width: Math.round(size.width),
        height: Math.round(size.height),
        x: Math.round(position.x),
        y: Math.round(position.y),
      } satisfies PlayerBounds);
      await this.store.save();
    } catch {
      // Геометрия — удобство, а не данные: потерять её не страшно.
    }
  }
}
