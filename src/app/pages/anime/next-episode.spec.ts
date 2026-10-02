import { describe, expect, test } from 'bun:test';

import { nextEpisodeInfo } from './next-episode';

const now = new Date(2026, 9, 3, 12, 0).getTime();

describe('nextEpisodeInfo', () => {
  test('не показывает блок без корректной даты', () => {
    for (const timestamp of [undefined, 0, -1, NaN, Infinity, 1e20]) {
      expect(nextEpisodeInfo(timestamp, now)).toBeNull();
    }
  });

  test('читает unix-секунды и показывает дни, часы и минуты как на фронте', () => {
    const release = now + 86_400_000 + 2 * 3_600_000 + 3 * 60_000;
    const info = nextEpisodeInfo(release / 1000, now);
    expect(info?.timeLeft).toBe('Через 1 дн. 2 ч. 3 мин.');
    expect(info?.isReleased).toBe(false);
    expect(info?.datetime).toBe(new Date(release).toISOString());
    expect(info?.date).toBe(new Date(release).toLocaleString('ru-RU', {
      day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
    }));
  });

  test('под минутой не обещает ноль минут', () => {
    expect(nextEpisodeInfo((now + 30_000) / 1000, now)?.timeLeft).toBe('Менее минуты');
    expect(nextEpisodeInfo((now + 60_000) / 1000, now)?.timeLeft).toBe('Через 1 мин.');
  });

  test('отсчёт уменьшается и переходит в сообщение о выходе', () => {
    const release = (now + 120_000) / 1000;
    expect(nextEpisodeInfo(release, now)?.timeLeft).toBe('Через 2 мин.');
    expect(nextEpisodeInfo(release, now + 60_000)?.timeLeft).toBe('Через 1 мин.');
    expect(nextEpisodeInfo(release, now + 120_000)?.timeLeft).toBe('Серия уже вышла');
    expect(nextEpisodeInfo(release, now + 120_000)?.isReleased).toBe(true);
  });

  test('различает выход сегодня и устаревшую дату', () => {
    expect(nextEpisodeInfo((now - 60_000) / 1000, now)?.timeLeft).toBe('Серия уже вышла');
    expect(nextEpisodeInfo(new Date(2026, 9, 2, 12).getTime() / 1000, now)?.timeLeft)
      .toBe('Уже вышло');
  });

  test('на смене года прошедшая дата не считается сегодняшней', () => {
    const newYear = new Date(2027, 0, 1, 0, 1).getTime();
    const release = new Date(2026, 11, 31, 23, 59).getTime() / 1000;
    expect(nextEpisodeInfo(release, newYear)?.timeLeft).toBe('Уже вышло');
  });
});
