import { Injectable } from '@angular/core';
import { LazyStore } from '@tauri-apps/plugin-store';

import { parseSource, type VideoSource } from '../api/video-source';
import { CVH_QUALITIES } from './manifest-quality';
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
/**
 * Качество просмотра. Своё, а не качество загрузок из `settings.json`:
 * смотреть онлайн на слабой сети в 480p и качать в 720p — обычное дело.
 */
const QUALITY_KEY = 'quality';
/**
 * Предпочитаемый источник серий. Отдельной настройки в UI нет: запоминается
 * источник озвучки, которую человек последней выбрал сам. Живёт здесь, в
 * настройках просмотра: выбор озвучки на странице тайтла общий для плеера и
 * загрузок, и второй файл ради одного ключа не нужен.
 */
const SOURCE_KEY = 'source';

/**
 * Только качества из меню: старое или поправленное руками значение — мимо.
 * Сверка с самой длинной лестницей (CDNVideoHub): выбранные там 1080p
 * сохраняются общими, а на Kodik плеер покажет лучшее, что есть.
 */
export function parseQuality(saved: unknown): number | null {
  return CVH_QUALITIES.includes(saved as (typeof CVH_QUALITIES)[number])
    ? (saved as number)
    : null;
}

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

  async getQuality(): Promise<number | null> {
    return parseQuality(await this.store.get<unknown>(QUALITY_KEY));
  }

  async setQuality(quality: number): Promise<void> {
    await this.store.set(QUALITY_KEY, quality);
    await this.store.save();
  }

  async getPreferredSource(): Promise<VideoSource | null> {
    return parseSource(await this.store.get<unknown>(SOURCE_KEY));
  }

  async setPreferredSource(source: VideoSource): Promise<void> {
    await this.store.set(SOURCE_KEY, source);
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
