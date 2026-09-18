import { describe, expect, test } from 'bun:test';

import { absoluteMediaUrl } from './media-url';

describe('absoluteMediaUrl', () => {
  test('дописывает схему протокол-относительному адресу', () => {
    // Ровно то, что приходит в avatars.small у комментариев.
    expect(
      absoluteMediaUrl('//static.yani.tv/users/small/252090.webp?v=3244930186')
    ).toBe('https://static.yani.tv/users/small/252090.webp?v=3244930186');
  });

  test('абсолютный адрес не трогает', () => {
    const url = 'https://static.yani.tv/posters/big/1636948981.webp';
    expect(absoluteMediaUrl(url)).toBe(url);
  });

  test('пустую строку оставляет пустой', () => {
    expect(absoluteMediaUrl('')).toBe('');
  });

  test('одиночный слэш схемой не считается', () => {
    expect(absoluteMediaUrl('/assets/placeholder.png')).toBe(
      '/assets/placeholder.png'
    );
  });
});
