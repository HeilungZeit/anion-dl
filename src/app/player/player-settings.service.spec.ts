import { describe, expect, test } from 'bun:test';

import { parseVolume } from './player-settings.service';

describe('parseVolume', () => {
  test('keeps a valid setting', () => {
    expect(parseVolume({ volume: 0.4, muted: true })).toEqual({
      volume: 0.4,
      muted: true,
    });
  });

  test('clamps out-of-range volume', () => {
    expect(parseVolume({ volume: 3 })).toEqual({ volume: 1, muted: false });
    expect(parseVolume({ volume: -1 })).toEqual({ volume: 0, muted: false });
  });

  test('ignores anything that is not a volume', () => {
    expect(parseVolume(undefined)).toBeNull();
    expect(parseVolume('loud')).toBeNull();
    expect(parseVolume({ volume: Number.NaN })).toBeNull();
  });
});
