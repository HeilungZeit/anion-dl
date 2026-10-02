import type { ViewingOrder } from '../../api/anime.types';

/** Следующий элемент именно в порядке API, без пересортировки сезонов. */
export function nextViewingTitle(
  order: readonly ViewingOrder[],
  animeId: number
): ViewingOrder | null {
  const current = order.findIndex((title) => String(title.animeId) === String(animeId));
  return current < 0 ? null : (order[current + 1] ?? null);
}
