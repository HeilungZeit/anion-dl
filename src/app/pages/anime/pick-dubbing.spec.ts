import { describe, expect, test } from 'bun:test';

import { pickDubbing } from './pick-dubbing';

const both = ['AniLibria.TV', 'AniDUB', 'AniDUB (CVH)', 'Dream Cast (CVH)'];

describe('pickDubbing', () => {
  test('без истории и предпочтения — первая, то есть Kodik', () => {
    expect(
      pickDubbing({ available: both, preferredSource: null, cvhLoading: false })
    ).toBe('AniLibria.TV');
  });

  test('предпочтение CDNVideoHub берёт его первую озвучку', () => {
    expect(
      pickDubbing({ available: both, preferredSource: 'cvh', cvhLoading: false })
    ).toBe('AniDUB (CVH)');
  });

  test('история важнее предпочтения', () => {
    expect(
      pickDubbing({
        available: both,
        lastWatched: 'AniDUB',
        preferredSource: 'cvh',
        cvhLoading: false,
      })
    ).toBe('AniDUB');
  });

  test('адрес важнее истории', () => {
    expect(
      pickDubbing({
        available: both,
        requested: 'Dream Cast (CVH)',
        lastWatched: 'AniDUB',
        preferredSource: null,
        cvhLoading: false,
      })
    ).toBe('Dream Cast (CVH)');
  });

  test('ждёт CDNVideoHub, если туда ведёт предпочтение', () => {
    expect(
      pickDubbing({
        available: ['AniDUB'],
        preferredSource: 'cvh',
        cvhLoading: true,
      })
    ).toBe('wait');
  });

  test('ждёт CDNVideoHub, если туда ведёт история', () => {
    expect(
      pickDubbing({
        available: ['AniDUB'],
        lastWatched: 'AniDUB (CVH)',
        preferredSource: null,
        cvhLoading: true,
      })
    ).toBe('wait');
  });

  test('не ждёт, когда явный выбор уже на месте', () => {
    expect(
      pickDubbing({
        available: ['AniDUB'],
        lastWatched: 'AniDUB',
        preferredSource: 'cvh',
        cvhLoading: true,
      })
    ).toBe('AniDUB');
  });

  test('в CDNVideoHub тайтла нет — остаётся Kodik', () => {
    expect(
      pickDubbing({
        available: ['AniDUB'],
        preferredSource: 'cvh',
        cvhLoading: false,
      })
    ).toBe('AniDUB');
  });

  test('озвучек нет вовсе — null', () => {
    expect(
      pickDubbing({ available: [], preferredSource: null, cvhLoading: false })
    ).toBeNull();
  });
});
