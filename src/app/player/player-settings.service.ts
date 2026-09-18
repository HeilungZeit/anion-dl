import { Injectable } from '@angular/core';
import { LazyStore } from '@tauri-apps/plugin-store';

import { UPSCALE_MODES, type UpscaleMode } from './upscale';

/**
 * Настройки плеера.
 *
 * Отдельный файл, а не `settings.json` загрузчика: тот принадлежит очереди
 * скачивания, и плееру незачем от неё зависеть. Так же устроен прогресс
 * просмотра.
 */
const STORE_FILE = 'player.json';
const UPSCALE_KEY = 'upscale';
const VOLUME_KEY = 'volume';

export interface VolumeSetting {
  volume: number;
  muted: boolean;
}

/** Файл мог поправить человек руками — всё, что не похоже на громкость, игнорируем. */
export function parseVolume(saved: unknown): VolumeSetting | null {
  if (typeof saved !== 'object' || saved === null) {
    return null;
  }

  const { volume, muted } = saved as Partial<VolumeSetting>;
  if (typeof volume !== 'number' || !Number.isFinite(volume)) {
    return null;
  }

  return {
    volume: Math.min(Math.max(volume, 0), 1),
    muted: muted === true,
  };
}

@Injectable({ providedIn: 'root' })
export class PlayerSettingsService {
  private readonly store = new LazyStore(STORE_FILE);

  async getUpscale(): Promise<UpscaleMode> {
    const saved = await this.store.get<string>(UPSCALE_KEY);

    // Значение из файла проверяется, а не приводится: список режимов может
    // поменяться между версиями, и старое имя не должно ломать плеер.
    return UPSCALE_MODES.includes(saved as UpscaleMode)
      ? (saved as UpscaleMode)
      : 'off';
  }

  async setUpscale(mode: UpscaleMode): Promise<void> {
    await this.store.set(UPSCALE_KEY, mode);
    await this.store.save();
  }

  async getVolume(): Promise<VolumeSetting | null> {
    return parseVolume(await this.store.get<unknown>(VOLUME_KEY));
  }

  async setVolume(setting: VolumeSetting): Promise<void> {
    await this.store.set(VOLUME_KEY, setting);
    await this.store.save();
  }
}
