import { describe, expect, test } from 'bun:test';

import {
  latestAvailableWatchedEpisode,
  normalizeRemoteEpisodes,
} from './remote-watch-progress.service';

describe('remote watch progress', () => {
  test('normalizes episode numbers without inventing a local position', () => {
    expect(normalizeRemoteEpisodes([3, 1, 3, 0, -2, 2.5, 2])).toEqual([
      1, 2, 3,
    ]);
  });

  test('selects the latest watched episode available in the dubbing', () => {
    expect(
      latestAvailableWatchedEpisode([1, 2, 4, 5], new Set([1, 3, 4]))
    ).toBe(4);
  });

  test('returns null when this dubbing has no watched episodes', () => {
    expect(latestAvailableWatchedEpisode([4, 5], new Set([1, 2]))).toBeNull();
  });
});
