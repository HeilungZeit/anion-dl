import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_WINDOW_SECONDS,
  SkipController,
  TAIL_SECONDS,
} from './skip-controller';

/** Тайминги живой серии 18599: опенинг с 68-й секунды, концовка с 1401-й. */
const SKIPS = { opening: 68, ending: 1401 };
const DURATION = 1421;

describe('опенинг', () => {
  const skip = new SkipController(SKIPS);

  test('до начала подсказки нет', () => {
    expect(skip.visibleSkip(67, DURATION)).toBeNull();
  });

  test('внутри окна показывается', () => {
    expect(skip.visibleSkip(70, DURATION)?.kind).toBe('opening');
  });

  test('окно достраивается на 90 секунд, раз длина неизвестна', () => {
    const last = SKIPS.opening + DEFAULT_WINDOW_SECONDS - 1;
    expect(skip.visibleSkip(last, DURATION)?.kind).toBe('opening');
    expect(skip.visibleSkip(last + 1, DURATION)).toBeNull();
  });

  test('перемотка ведёт за конец окна', () => {
    const hint = skip.visibleSkip(70, DURATION);
    expect(hint && skip.skipTargetSecs(hint.segment)).toBe(
      SKIPS.opening + DEFAULT_WINDOW_SECONDS
    );
  });
});

describe('концовка', () => {
  test('тайминг концовки внутри последних четырёх минут не мешает', () => {
    const skip = new SkipController(SKIPS);
    expect(skip.visibleSkip(SKIPS.ending, DURATION)?.kind).toBe('ending');
    expect(skip.visibleSkip(DURATION - 1, DURATION)?.kind).toBe('ending');
  });

  test('ранний тайминг ending не показывает следующую серию раньше хвоста', () => {
    const skip = new SkipController({ ending: 12 * 60 });
    const duration = 24 * 60;

    expect(skip.visibleSkip(12 * 60, duration)).toBeNull();
    expect(skip.visibleSkip(14 * 60, duration)).toBeNull();
    expect(skip.visibleSkip(20 * 60, duration)?.kind).toBe('ending');
  });

  test('у последней серии не показывается: вести некуда', () => {
    const skip = new SkipController(SKIPS, true);
    expect(skip.visibleSkip(SKIPS.ending, DURATION)).toBeNull();
  });

  test('опенинг у последней серии всё равно работает', () => {
    const skip = new SkipController(SKIPS, true);
    expect(skip.visibleSkip(70, DURATION)?.kind).toBe('opening');
  });

  test('без тайминга концовки хвост всё равно даёт подсказку', () => {
    const skip = new SkipController({});
    const tailStart = DURATION - TAIL_SECONDS;

    expect(skip.visibleSkip(tailStart - 1, DURATION)).toBeNull();
    expect(skip.visibleSkip(tailStart, DURATION)?.kind).toBe('ending');
  });

  test('кнопка следующей серии появляется за четыре минуты до конца', () => {
    const skip = new SkipController({});

    expect(TAIL_SECONDS).toBe(240);
    expect(skip.visibleSkip(DURATION - 241, DURATION)).toBeNull();
    expect(skip.visibleSkip(DURATION - 240, DURATION)?.kind).toBe('ending');
  });

  test('без известной длительности хвоста нет', () => {
    const skip = new SkipController({});
    expect(skip.visibleSkip(1500, 0)).toBeNull();
  });

  test('без длительности использует ending как ограниченное запасное окно', () => {
    const skip = new SkipController({ ending: 100 });

    expect(skip.visibleSkip(99, 0)).toBeNull();
    expect(skip.visibleSkip(100, 0)?.kind).toBe('ending');
    expect(skip.visibleSkip(190, 0)).toBeNull();
  });
});
