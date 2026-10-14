import type { VideoSkips } from '../api/anime.types';

/**
 * Серия для выбора прямо в плеере. Каталог собирает родитель — плеер о
 * сериях и озвучках ничего не знает, — а поток по выбору поднимает сам плеер.
 */
export interface NativePlaybackOption {
  id: string;
  episode: number;
  dubbing: string;
  /** Локатор серии для резолвера — тот же ключ, что `iframeUrl` плеера. */
  iframeUrl: string;
  skips: VideoSkips;
  /** Серия скачана: играет с диска, резолвить её заранее незачем. */
  local: boolean;
  watched: boolean;
  progress: number;
}
