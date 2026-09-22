import { describe, expect, test } from 'bun:test';

import { AppNotification, summarizeNotifications } from './notifications.service';

const item = (id: number, read = false): AppNotification => ({
  id,
  type: 'new_episode',
  animeId: 19627,
  episode: id,
  title: 'Re:Zero 4',
  read,
});

describe('summarizeNotifications', () => {
  test('stays silent when nothing is newer than the last shown', () => {
    expect(summarizeNotifications([item(5), item(4)], 5)).toBeNull();
  });

  test('ignores read notifications', () => {
    expect(summarizeNotifications([item(6, true)], 5)).toBeNull();
  });

  test('names a single fresh episode', () => {
    expect(summarizeNotifications([item(6), item(5)], 5)).toEqual({
      title: 'Anion',
      body: 'Вышла 6 серия: Re:Zero 4',
    });
  });

  test('describes a finished title', () => {
    const finished: AppNotification = { ...item(7), type: 'anime_finished', episode: 0 };
    expect(summarizeNotifications([finished], 6)?.body).toBe(
      'Re:Zero 4 вышло полностью, подписка снята'
    );
  });

  test('summarizes several fresh notifications', () => {
    expect(summarizeNotifications([item(8), item(7), item(6, true)], 5)).toEqual({
      title: 'Новые серии',
      body: 'Новых уведомлений: 2',
    });
  });
});
