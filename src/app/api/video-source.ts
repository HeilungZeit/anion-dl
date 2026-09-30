import { CVH_QUALITIES, QUALITIES } from '../player/manifest-quality';
import type { Video } from './anime.types';

/**
 * Источники серий и то, как их различать.
 *
 * Бэк отдаёт `data.player` человекочитаемой подписью — «Плеер Kodik», «Плеер
 * Alloha», — а не идентификатором. Поэтому Kodik узнаётся по вхождению.
 * CDNVideoHub в бэке нет вовсе: его серии приложение собирает само
 * (`CvhService`) и подписывает своей константой.
 */
export const KODIK_PLAYER = 'Kodik';
export const CVH_PLAYER = 'CDNVideoHub';

/** Совпадает с `cvh::LOCATOR_PREFIX` в Rust. */
export const CVH_LOCATOR_PREFIX = 'cvh:';

/**
 * Метка, которой озвучка CDNVideoHub отличается от одноимённой у Kodik.
 *
 * Строка озвучки в приложении — это идентичность дорожки: по ней ищется
 * прогресс, собирается адрес окна плеера и имя файла. «AniDUB» есть в обоих
 * источниках, и без метки серии двух источников смешались бы в один список,
 * а файлы — в один путь.
 */
const CVH_DUBBING_SUFFIX = ' (CVH)';

/** Источник как настройка: какой брать, когда тайтл есть в обоих. */
export type VideoSource = 'kodik' | 'cvh';

export function sourceOfDubbing(dubbing: string): VideoSource {
  return isCvhDubbing(dubbing) ? 'cvh' : 'kodik';
}

/** Файл настроек мог поправить человек руками — чужое значение не источник. */
export function parseSource(saved: unknown): VideoSource | null {
  return saved === 'kodik' || saved === 'cvh' ? saved : null;
}

export function isKodik(video: Video): boolean {
  return video.data.player.includes(KODIK_PLAYER);
}

export function isCvhLocator(locator: string): boolean {
  return locator.startsWith(CVH_LOCATOR_PREFIX);
}

/** Качества, которые стоит предлагать для серии: у каждого источника свой потолок. */
export function qualitiesFor(locator: string): readonly number[] {
  return isCvhLocator(locator) ? CVH_QUALITIES : QUALITIES;
}

export function cvhDubbing(voice: string): string {
  return `${voice}${CVH_DUBBING_SUFFIX}`;
}

export function isCvhDubbing(dubbing: string): boolean {
  return dubbing.endsWith(CVH_DUBBING_SUFFIX);
}

/** Имя озвучки без метки источника — для списка, где источник уже виден по группе. */
export function voiceOf(dubbing: string): string {
  return isCvhDubbing(dubbing)
    ? dubbing.slice(0, -CVH_DUBBING_SUFFIX.length)
    : dubbing;
}
