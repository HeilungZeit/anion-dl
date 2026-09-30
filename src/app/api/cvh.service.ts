import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import type { Video } from './anime.types';
import { CVH_LOCATOR_PREFIX, CVH_PLAYER, cvhDubbing } from './video-source';

/** Серия плейлиста, как её отдаёт `cvh_playlist`. */
export interface CvhTrack {
  vkId: string;
  voice: string;
  episode: number;
}

/** Как у `AnimeService`: страница тайтла открывается туда-обратно часто. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Серии CDNVideoHub в виде обычных `Video`.
 *
 * Плейлист запрашивает Rust, а не `plugin-http`: так домен источника не
 * попадает в capabilities, а всё знание о нём живёт в одном модуле `cvh.rs`.
 * Подробности источника — `docs/cvh-source.md`.
 */
@Injectable({ providedIn: 'root' })
export class CvhService {
  private readonly cache = new Map<
    number,
    { promise: Promise<Video[]>; expiresAt: number }
  >();

  /**
   * Никогда не падает: второй источник — дополнение, и его недоступность не
   * должна мешать Kodik. Отказ даёт пустой список и не кэшируется.
   */
  videosFor(malId: number): Promise<Video[]> {
    const cached = this.cache.get(malId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.promise;
    }

    const promise = invoke<CvhTrack[]>('cvh_playlist', { malId })
      .then(toVideos)
      .catch((error: unknown) => {
        console.warn('CDNVideoHub недоступен', error);
        this.cache.delete(malId);
        return [];
      });

    this.cache.set(malId, { promise, expiresAt: Date.now() + CACHE_TTL_MS });
    return promise;
  }
}

/**
 * Одна серия на пару «озвучка + номер»: у длинных сериалов в плейлисте
 * встречаются повторы, и в списке они выглядели бы двумя одинаковыми плитками.
 */
export function toVideos(tracks: readonly CvhTrack[]): Video[] {
  const seen = new Set<string>();
  const videos: Video[] = [];

  for (const track of tracks) {
    const dubbing = cvhDubbing(track.voice);
    const key = `${dubbing}\u0000${track.episode}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    videos.push({
      // vkId — 13–14 цифр, в Number помещается точно. Он же id задачи
      // загрузки, поэтому обязан быть стабильным между запусками.
      videoId: Number(track.vkId),
      data: { player: CVH_PLAYER, dubbing },
      number: String(track.episode),
      date: 0,
      iframeUrl: `${CVH_LOCATOR_PREFIX}${track.vkId}`,
      index: videos.length,
      // Таймингов опенинга у источника нет.
      skips: {},
    });
  }

  return videos;
}
