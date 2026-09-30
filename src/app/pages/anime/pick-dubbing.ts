import {
  isCvhDubbing,
  sourceOfDubbing,
  type VideoSource,
} from '../../api/video-source';

export interface DubbingChoice {
  /** Озвучки, которые уже известны: Kodik и то, что успел отдать CDNVideoHub. */
  available: readonly string[];
  /** Из адреса — сюда ведут «Продолжить смотреть» и окно плеера. */
  requested?: string;
  /** Та, в которой тайтл смотрели последней. */
  lastWatched?: string;
  /** Источник, из которого человек последний раз выбирал озвучку сам. */
  preferredSource: VideoSource | null;
  /** Плейлист CDNVideoHub ещё грузится. */
  cvhLoading: boolean;
}

/**
 * Озвучка по умолчанию на странице тайтла, или `'wait'`, если решать рано.
 *
 * Порядок: из адреса, из истории, первая у предпочитаемого источника, первая
 * вообще. Явный выбор (адрес, история) всегда важнее предпочтения: оно лишь
 * решает, с чего начать тайтл, который ещё не смотрели.
 *
 * Ждать приходится, когда ответ может оказаться у CDNVideoHub, а его список
 * ещё не пришёл: выбор успел бы упасть на Kodik, а пришедший следом список
 * его уже не поменяет.
 */
export function pickDubbing(choice: DubbingChoice): string | 'wait' | null {
  const { available, preferredSource, cvhLoading } = choice;
  const wanted = [choice.requested, choice.lastWatched].filter(
    (name): name is string => name !== undefined
  );

  const explicit = wanted.find((name) => available.includes(name));
  const explicitPending = wanted.some(
    (name) => isCvhDubbing(name) && !available.includes(name)
  );

  if (cvhLoading && !explicit && (explicitPending || preferredSource === 'cvh')) {
    return 'wait';
  }

  return (
    explicit ??
    available.find(
      (name) => preferredSource !== null && sourceOfDubbing(name) === preferredSource
    ) ??
    available[0] ??
    null
  );
}
