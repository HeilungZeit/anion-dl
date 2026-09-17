import { describe, expect, test } from 'bun:test';

import {
  expiryEpochMs,
  shouldRefreshAhead,
  SIGNATURE_LEAD_SECONDS,
} from './signature-clock';

/** Настоящий манифест, снятый с живой серии 17.09.2026. */
const MANIFEST =
  'https://cloud.solodcdn.com/useruploads/f9b95698-508a-4f6e-b8c7-c16eab9d82bc/' +
  '0ba8f2499d9be2ca28922e652bb620b0:2026091809/720.mp4:hls:manifest.m3u8';

const EXPIRY = Date.UTC(2026, 8, 18, 9, 0, 0, 0);

describe('expiryEpochMs', () => {
  test('читает штамп живого манифеста как UTC', () => {
    expect(expiryEpochMs(MANIFEST)).toBe(EXPIRY);
  });

  test('не путается в двоеточиях имени файла', () => {
    expect(expiryEpochMs('https://cdn/x/720.mp4:hls:manifest.m3u8')).toBeNull();
  });

  test('отвергает десять цифр, не похожие на дату', () => {
    // Тринадцатого месяца не бывает: это идентификатор, а не штамп.
    expect(expiryEpochMs('https://cdn/x:2026139909/720.mp4')).toBeNull();
  });

  test('ссылка без штампа срока не имеет', () => {
    expect(expiryEpochMs('https://cdn/x/manifest.m3u8')).toBeNull();
  });
});

describe('shouldRefreshAhead', () => {
  test('за час до конца обновляться рано', () => {
    expect(shouldRefreshAhead(MANIFEST, EXPIRY - 3600 * 1000)).toBe(false);
  });

  test('ровно на границе упреждения — пора', () => {
    expect(
      shouldRefreshAhead(MANIFEST, EXPIRY - SIGNATURE_LEAD_SECONDS * 1000)
    ).toBe(true);
  });

  test('после истечения — тем более', () => {
    expect(shouldRefreshAhead(MANIFEST, EXPIRY + 1)).toBe(true);
  });

  test('без штампа не дёргает резолвер никогда', () => {
    expect(shouldRefreshAhead('https://cdn/x/manifest.m3u8', EXPIRY)).toBe(
      false
    );
  });
});
