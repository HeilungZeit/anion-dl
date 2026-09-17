import { describe, expect, test } from 'bun:test';

import { ReResolveOnForbidden } from './re-resolve';

describe('ReResolveOnForbidden', () => {
  test('первый 403 просит переролв', () => {
    expect(new ReResolveOnForbidden().onSegmentError(403)).toBe('reresolve');
  });

  test('шторм сегментов не размножает переролвы', () => {
    const latch = new ReResolveOnForbidden();
    latch.onSegmentError(403);

    // Ровно то, ради чего затвор и нужен: следующие 403 из той же пачки
    // резолвер уже не дёргают.
    expect(latch.onSegmentError(403)).toBe('fail');
    expect(latch.onSegmentError(403)).toBe('fail');
  });

  test('после возобновления следующий срок подписи снова даёт попытку', () => {
    const latch = new ReResolveOnForbidden();
    latch.onSegmentError(403);
    latch.onPlaybackResumed();

    expect(latch.onSegmentError(403)).toBe('reresolve');
  });

  test('прочие коды проходят мимо затвора', () => {
    const latch = new ReResolveOnForbidden();

    expect(latch.onSegmentError(404)).toBe('propagate');
    expect(latch.onSegmentError(500)).toBe('propagate');
    // И не тратят единственную попытку.
    expect(latch.onSegmentError(403)).toBe('reresolve');
  });

  test('позиция запоминается, отрицательная игнорируется', () => {
    const latch = new ReResolveOnForbidden();
    latch.rememberPosition(42);
    latch.rememberPosition(-1);

    expect(latch.savedPositionSecs).toBe(42);
  });
});
