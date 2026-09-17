import { describe, expect, test } from 'bun:test';

import type { Poster } from './anime.types';
import {
  mergeWatchProgress,
  resumePositionFor,
  selectContinueWatching,
  trimWatchRecords,
  type WatchProgressUpdate,
  type WatchRecord,
} from './watch-progress.service';

const poster: Poster = {
  fullsize: 'full',
  big: 'big',
  small: 'small',
  medium: 'medium',
  huge: 'huge',
  mega: 'mega',
};

const update: WatchProgressUpdate = {
  animeId: 1,
  title: 'Title',
  poster,
  episode: 1,
  dubbing: 'Dub',
  positionSecs: 50,
  durationSecs: 100,
};

function record(overrides: Partial<WatchRecord> = {}): WatchRecord {
  return {
    ...update,
    finished: false,
    updatedAt: 1,
    ...overrides,
  };
}

describe('watch progress policy', () => {
  test('finished is sticky and duration only grows', () => {
    const finished = mergeWatchProgress([], {
      ...update,
      positionSecs: 90,
    }, 1);
    const rewound = mergeWatchProgress(finished, {
      ...update,
      positionSecs: 10,
      durationSecs: 80,
    }, 2);

    expect(rewound[0]?.finished).toBe(true);
    expect(rewound[0]?.durationSecs).toBe(100);
    expect(rewound[0]?.positionSecs).toBe(10);
  });

  test('position is clamped to duration', () => {
    const result = mergeWatchProgress([], {
      ...update,
      positionSecs: 120,
    });

    expect(result[0]?.positionSecs).toBe(100);
    expect(result[0]?.finished).toBe(true);
  });

  test('zero metadata sample does not erase a saved position', () => {
    const saved = [record({ positionSecs: 57, durationSecs: 100 })];
    const result = mergeWatchProgress(saved, {
      ...update,
      positionSecs: 0,
      durationSecs: 0,
    });

    expect(result[0]?.positionSecs).toBe(57);
    expect(result[0]?.durationSecs).toBe(100);
  });

  test('zero position with known duration does not erase a saved position', () => {
    const saved = [record({ positionSecs: 57, durationSecs: 100 })];
    const result = mergeWatchProgress(saved, {
      ...update,
      positionSecs: 0,
      durationSecs: 100,
    });

    expect(result[0]?.positionSecs).toBe(57);
    expect(result[0]?.updatedAt).toBe(1);
  });

  test('zero position does not create an empty history record', () => {
    const result = mergeWatchProgress([], {
      ...update,
      positionSecs: 0,
      durationSecs: 100,
    });

    expect(result).toEqual([]);
  });

  test('continue watching keeps the freshest unfinished episode per anime', () => {
    const result = selectContinueWatching([
      record({ episode: 1, updatedAt: 10 }),
      record({ episode: 2, updatedAt: 20 }),
      record({ animeId: 2, updatedAt: 15 }),
      record({ animeId: 3, updatedAt: 30, finished: true }),
    ]);

    expect(result.map(({ animeId, episode }) => [animeId, episode])).toEqual([
      [1, 2],
      [2, 1],
    ]);
  });

  test('legacy zero position remains visible instead of disappearing', () => {
    const result = selectContinueWatching([
      record({ positionSecs: 0, durationSecs: 100 }),
    ]);

    expect(result).toHaveLength(1);
  });

  test('continue watching is limited to ten titles', () => {
    const records = Array.from({ length: 12 }, (_, index) =>
      record({ animeId: index + 1, updatedAt: index + 1 })
    );
    const result = selectContinueWatching(records);

    expect(result).toHaveLength(10);
    expect(result[0]?.animeId).toBe(12);
    expect(result.at(-1)?.animeId).toBe(3);
  });

  test('trimming evicts old finished records before unfinished ones', () => {
    const result = trimWatchRecords([
      record({ animeId: 1, finished: true, updatedAt: 1 }),
      record({ animeId: 2, finished: true, updatedAt: 2 }),
      record({ animeId: 3, updatedAt: 3 }),
    ], 2);

    expect(result.map(({ animeId }) => animeId)).toEqual([3, 2]);
  });

  test('a position from the first second is eligible for resume', () => {
    const saved = record({ positionSecs: 1.05, durationSecs: 100 });

    expect(resumePositionFor([saved], 1, 1, 'Dub')).toBe(1.05);
  });
});
