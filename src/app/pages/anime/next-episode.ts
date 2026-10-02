export interface NextEpisodeInfo {
  date: string;
  datetime: string;
  timeLeft: string;
  isReleased: boolean;
}

/** nextDate — unix-секунды; дата показывается в часовом поясе устройства. */
export function nextEpisodeInfo(
  timestamp: number | undefined,
  now: number
): NextEpisodeInfo | null {
  if (!timestamp || !Number.isFinite(timestamp) || timestamp <= 0) return null;

  const date = new Date(timestamp * 1000);
  if (!Number.isFinite(date.getTime())) return null;

  const diff = date.getTime() - now;
  let timeLeft: string;

  if (diff <= 0) {
    const today = new Date(now);
    const releasedToday =
      date.getFullYear() === today.getFullYear() &&
      date.getMonth() === today.getMonth() &&
      date.getDate() === today.getDate();
    timeLeft = releasedToday ? 'Серия уже вышла' : 'Уже вышло';
  } else if (diff < 60_000) {
    timeLeft = 'Менее минуты';
  } else {
    const days = Math.floor(diff / 86_400_000);
    const hours = Math.floor((diff % 86_400_000) / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    const parts = [
      days > 0 ? `${days} дн.` : '',
      hours > 0 ? `${hours} ч.` : '',
      `${minutes} мин.`,
    ].filter(Boolean);
    timeLeft = `Через ${parts.join(' ')}`;
  }

  return {
    date: date.toLocaleString('ru-RU', {
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    }),
    datetime: date.toISOString(),
    timeLeft,
    isReleased: diff <= 0,
  };
}
