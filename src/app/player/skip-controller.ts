import type { VideoSkips } from '../api/anime.types';

/**
 * Кнопки «Пропустить опенинг» и «Следующая серия».
 *
 * Перенос `SkipController` из anion-tv вместе с его моделью отрезка.
 */

/**
 * Типичный опенинг — полторы минуты.
 *
 * Длина нужна, а её нет: anion-go отдаёт в `skips` только момент начала
 * (`{ opening: 68, ending: 1401 }` на живой серии). Поэтому конец окна
 * достраивается, а не берётся из данных.
 */
export const DEFAULT_WINDOW_SECONDS = 90;

/** Хвост серии, в котором кнопка следующей серии видна всегда. */
export const TAIL_SECONDS = 4 * 60;

export interface Segment {
  startSeconds: number;
  /** Необязателен: у Kodik-серий известно только начало. */
  stopSeconds?: number;
}

export type SkipKind = 'opening' | 'ending';

export interface SkipHint {
  segment: Segment;
  kind: SkipKind;
}

export function segmentEnd(segment: Segment): number {
  return segment.stopSeconds ?? segment.startSeconds + DEFAULT_WINDOW_SECONDS;
}

export class SkipController {
  private readonly opening: Segment | null;
  private readonly ending: Segment | null;

  constructor(
    skips: VideoSkips,
    private readonly isLastEpisode = false
  ) {
    this.opening =
      skips.opening === undefined ? null : { startSeconds: skips.opening };
    this.ending =
      skips.ending === undefined ? null : { startSeconds: skips.ending };
  }

  /**
   * Какую подсказку показать в этой позиции. null — никакую.
   *
   * Смысл у двух видов разный: опенинг перематывается внутри серии, а конец
   * ведёт на следующую серию. Поэтому у последней серии подсказки конца нет
   * вовсе — вести некуда.
   */
  visibleSkip(positionSecs: number, durationSecs = 0): SkipHint | null {
    const position = Math.floor(positionSecs);

    if (
      this.opening &&
      position >= this.opening.startSeconds &&
      position < segmentEnd(this.opening)
    ) {
      return { segment: this.opening, kind: 'opening' };
    }

    if (this.isLastEpisode) {
      return null;
    }

    const duration = durationSecs > 0 ? Math.floor(durationSecs) : 0;

    if (duration > 0) {
      const tailStart = Math.max(duration - TAIL_SECONDS, 0);
      if (position >= tailStart && position < duration) {
        return {
          segment: { startSeconds: tailStart, stopSeconds: duration },
          kind: 'ending',
        };
      }

      // При известной длительности это строго хвост в четыре минуты. Поле
      // skips.ending у API встречается заметно раньше настоящей концовки и не
      // должно преждевременно показывать переход на следующую серию.
      return null;
    }

    // Запасной путь для live/неполного манифеста, пока длительность неизвестна.
    if (
      this.ending &&
      position >= this.ending.startSeconds &&
      position < segmentEnd(this.ending)
    ) {
      return { segment: this.ending, kind: 'ending' };
    }

    return null;
  }

  /** Куда перематывать при пропуске опенинга. */
  skipTargetSecs(segment: Segment): number {
    return segmentEnd(segment);
  }
}
