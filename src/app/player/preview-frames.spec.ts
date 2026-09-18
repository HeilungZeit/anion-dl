import { describe, expect, test } from 'bun:test';

import type { Screenshot } from '../api/anime.types';
import { orderPreviewFrames } from './preview-frames';

const shot = (episode: string, url: string): Screenshot => ({
  time: 0,
  id: 0,
  episode,
  sizes: { small: '', full: url },
});

describe('orderPreviewFrames', () => {
  test('puts frames of the selected episode first', () => {
    expect(
      orderPreviewFrames([shot('1', 'a'), shot('3', 'b'), shot('03', 'c')], '3')
    ).toEqual(['b', 'c', 'a']);
  });

  test('drops duplicates and empty links', () => {
    expect(
      orderPreviewFrames([shot('1', 'a'), shot('2', 'a'), shot('2', '')], null)
    ).toEqual(['a']);
  });

  test('survives a missing list', () => {
    expect(orderPreviewFrames(undefined, '1')).toEqual([]);
  });
});
