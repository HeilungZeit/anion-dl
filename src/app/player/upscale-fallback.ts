import { UPSCALE_LABELS, type UpscaleMode, type UpscaleStats } from './upscale';

/**
 * Следит, тянет ли железо выбранный режим, и решает откатиться.
 *
 * Зачем вообще: сеть на M1 Pro укладывается в кадр на 480p, но не на 720p —
 * там выходит около 17 к/с вместо 24. Без отката это «иногда лагает», с
 * откатом — «иногда чуть хуже картинка», и только во втором случае режим
 * останется включённым.
 *
 * Сигнал берётся не из догадок о частоте ролика, а из `videoFps` — счётчика
 * реально показанных кадров. Сравнение с константой 24 то объявляло бы
 * просадку на роликах 23.976, то не замечало настоящую на 30.
 */

/**
 * Куда откатываемся: самый качественный из тех, что заведомо тянут.
 *
 * Не в `off`: человек включил улучшение осознанно, и выключить его целиком
 * из-за нехватки кадров — это решить за него больше, чем он просил.
 */
export const FALLBACK_MODE: UpscaleMode = 'ca';

/** Режимы, у которых есть куда падать. */
const HEAVY: readonly UpscaleMode[] = ['compact'];

export interface FallbackOptions {
  /** Доля от частоты видео, ниже которой конвейер считается не тянущим. */
  ratio: number;
  /** Сколько просадка должна продержаться, прежде чем откатываться. */
  holdMs: number;
}

/**
 * Девять десятых, а не единица: округление до целых кадров и редкий
 * пропущенный кадр — это не повод переключать режим.
 *
 * Три секунды подряд, а не мгновенно: просадка на старте воспроизведения и
 * после перемотки — обычное дело, буферы ещё не прогреты.
 */
export const DEFAULT_FALLBACK: FallbackOptions = { ratio: 0.9, holdMs: 3000 };

export interface FallbackDecision {
  to: UpscaleMode;
  /** Текст для диагностики: иначе откат не отличить от «само так вышло». */
  reason: string;
}

export class UpscaleFallback {
  private readonly options: FallbackOptions;

  /** Когда началась текущая непрерывная просадка; null — её нет. */
  private slumpStartedAt: number | null = null;

  /** Откат уже случился. Качели «упал — поднялся — упал» хуже, чем
   * стабильно худший режим, поэтому второй раз не вмешиваемся. */
  private spent = false;

  /** Человек выбрал режим руками — дальше это его решение, а не наше. */
  private released = false;

  private mode: UpscaleMode = 'off';

  constructor(options: FallbackOptions = DEFAULT_FALLBACK) {
    this.options = options;
  }

  /** Режим сменился. Следим только за теми, у которых есть куда падать. */
  watch(mode: UpscaleMode): void {
    this.mode = mode;
    this.slumpStartedAt = null;
  }

  /** Человек переключил режим сам. Автоматика умолкает до конца серии. */
  release(): void {
    this.released = true;
    this.slumpStartedAt = null;
  }

  /** Новая серия: прошлые решения к ней отношения не имеют. */
  reset(): void {
    this.spent = false;
    this.released = false;
    this.slumpStartedAt = null;
  }

  /** Очередной отчёт конвейера. Возвращает решение или null. */
  observe(stats: UpscaleStats, now: number): FallbackDecision | null {
    if (this.released || this.spent || !HEAVY.includes(this.mode)) {
      return null;
    }

    // Пока видео не отдало ни одного показанного кадра, сравнивать не с чем:
    // так выглядит пауза и первые мгновения после запуска.
    if (stats.videoFps <= 0) {
      return null;
    }

    if (stats.fps >= stats.videoFps * this.options.ratio) {
      this.slumpStartedAt = null;
      return null;
    }

    this.slumpStartedAt ??= now;

    if (now - this.slumpStartedAt < this.options.holdMs) {
      return null;
    }

    this.spent = true;
    this.slumpStartedAt = null;

    return {
      to: FALLBACK_MODE,
      reason:
        `Не хватало кадров: ${stats.fps} из ${stats.videoFps}. ` +
        `Включён режим «${UPSCALE_LABELS[FALLBACK_MODE].title}»`,
    };
  }
}
