import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_FALLBACK,
  FALLBACK_MODE,
  UpscaleFallback,
} from './upscale-fallback';
import type { UpscaleStats } from './upscale';

/** Замер на M1 Pro: 720p даёт около 17 к/с там, где видео идёт 24. */
const SLUMP: UpscaleStats = {
  sourceWidth: 1280,
  sourceHeight: 720,
  targetWidth: 2560,
  targetHeight: 1440,
  fps: 17,
  videoFps: 24,
};

/** 480p укладывается в кадр целиком. */
const FINE: UpscaleStats = { ...SLUMP, fps: 24 };

/** Пауза: показанных кадров нет, сравнивать не с чем. */
const IDLE: UpscaleStats = { ...SLUMP, fps: 0, videoFps: 0 };

const HOLD = DEFAULT_FALLBACK.holdMs;

function watching(): UpscaleFallback {
  const fallback = new UpscaleFallback();
  fallback.watch('compact');
  return fallback;
}

describe('когда автоматика молчит', () => {
  test('лёгкий режим не откатывается — падать некуда', () => {
    const fallback = new UpscaleFallback();
    fallback.watch('ca');

    expect(fallback.observe(SLUMP, 0)).toBeNull();
    expect(fallback.observe(SLUMP, HOLD * 2)).toBeNull();
  });

  test('без показанных кадров решения нет', () => {
    const fallback = watching();

    expect(fallback.observe(IDLE, 0)).toBeNull();
    expect(fallback.observe(IDLE, HOLD * 2)).toBeNull();
  });

  test('короткая просадка проходит мимо', () => {
    const fallback = watching();

    expect(fallback.observe(SLUMP, 0)).toBeNull();
    expect(fallback.observe(SLUMP, HOLD - 1)).toBeNull();
  });
});

describe('откат', () => {
  test('срабатывает, продержавшись положенное', () => {
    const fallback = watching();

    fallback.observe(SLUMP, 0);
    const decision = fallback.observe(SLUMP, HOLD);

    expect(decision?.to).toBe(FALLBACK_MODE);
    expect(decision?.reason).toContain('17');
    expect(decision?.reason).toContain('24');
  });

  test('восстановление обнуляет отсчёт, а не копит его', () => {
    const fallback = watching();

    fallback.observe(SLUMP, 0);
    fallback.observe(FINE, HOLD - 1);
    // Два провала по HOLD-1 подряд не должны складываться в один длинный.
    expect(fallback.observe(SLUMP, HOLD)).toBeNull();
    expect(fallback.observe(SLUMP, HOLD * 2 - 2)).toBeNull();
  });

  test('случается один раз за серию', () => {
    const fallback = watching();

    fallback.observe(SLUMP, 0);
    expect(fallback.observe(SLUMP, HOLD)).not.toBeNull();

    fallback.watch('compact');
    fallback.observe(SLUMP, HOLD * 2);
    expect(fallback.observe(SLUMP, HOLD * 4)).toBeNull();
  });
});

describe('решение человека', () => {
  test('ручной выбор выключает автоматику', () => {
    const fallback = watching();

    fallback.release();
    fallback.observe(SLUMP, 0);

    expect(fallback.observe(SLUMP, HOLD * 2)).toBeNull();
  });

  test('новая серия возвращает её', () => {
    const fallback = watching();

    fallback.release();
    fallback.reset();
    fallback.watch('compact');

    fallback.observe(SLUMP, 0);
    expect(fallback.observe(SLUMP, HOLD)).not.toBeNull();
  });
});
