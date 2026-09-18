import type { Screenshot } from '../api/anime.types';

/**
 * Кадры для заставки плеера: сначала из выбранной серии, затем остальные.
 *
 * Скриншоты бэк берёт у внешнего API как есть — их может не быть вовсе,
 * ссылки могут повторяться, серия указана строкой. Отсюда нормализация.
 */
export function orderPreviewFrames(
  screenshots: readonly Screenshot[] | null | undefined,
  episode: string | null
): string[] {
  const list = (screenshots ?? []).filter((shot) => shot?.sizes?.full);
  const own = list.filter(
    (shot) => episode !== null && Number(shot.episode) === Number(episode)
  );
  const rest = list.filter((shot) => !own.includes(shot));

  return [...new Set([...own, ...rest].map((shot) => shot.sizes.full))];
}
