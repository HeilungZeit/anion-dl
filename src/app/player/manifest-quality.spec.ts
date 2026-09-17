import { describe, expect, test } from 'bun:test';

import { qualityOf } from './manifest-quality';

describe('qualityOf', () => {
  test('читает качество живого манифеста', () => {
    expect(
      qualityOf(
        'https://cloud.solodcdn.com/useruploads/f9b95698/0ba8f24:2026091809/720.mp4:hls:manifest.m3u8'
      )
    ).toBe(720);
  });

  test('не путается с цифрами в пути', () => {
    expect(qualityOf('https://cdn/2026091809/x/360.mp4:hls:manifest.m3u8')).toBe(
      360
    );
  });

  test('чужой формат ссылки — null, а не догадка', () => {
    expect(qualityOf('https://cdn/stream/manifest.m3u8')).toBeNull();
  });
});
