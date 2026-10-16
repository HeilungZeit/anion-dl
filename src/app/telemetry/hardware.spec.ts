import { describe, expect, it } from 'bun:test';

import { screenClass, upscalePerf } from './hardware';

describe('hardware', () => {
  const view = (width: number, height: number, devicePixelRatio: number) =>
    ({ screen: { width, height }, devicePixelRatio }) as Window;

  it('classifies the screen by physical short side', () => {
    expect(screenClass(view(1920, 1080, 1))).toBe('1080p');
    expect(screenClass(view(1440, 900, 2))).toBe('4k');
    expect(screenClass(view(2560, 1440, 1))).toBe('1440p');
  });

  it('keeps the perf verdict a server token', () => {
    expect(upscalePerf('ca', 1080, 0.99)).toBe('ca-1080-smooth');
    expect(upscalePerf('compact', 720, 0.85)).toBe('compact-720-lag');
    expect(upscalePerf('c', 2160, 0.5)).toBe('c-4k-slow');
  });
});
