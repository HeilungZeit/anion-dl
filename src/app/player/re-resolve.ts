/**
 * Затвор против шторма 403.
 *
 * Перенос `ReResolveOnForbidden` из anion-tv. На протухшей подписи плеер
 * получает 403 не один раз, а пачкой — по ответу на сегмент. Без затвора
 * каждый из них дёрнул бы резолвер заново.
 *
 * После того как воспроизведение снова пошло, следующий срок подписи имеет
 * право ещё на одну попытку.
 */

export type ReResolveDecision =
  /** Тихо перерезолвить поток и продолжить с сохранённой позиции. */
  | 'reresolve'
  /** Переролв уже был и не помог — показать ошибку. */
  | 'fail'
  /** Не наш случай: пусть с ошибкой разбирается вызывающий. */
  | 'propagate';

export class ReResolveOnForbidden {
  private awaitingResume = false;
  private position = 0;

  /** Позиция, с которой продолжать после переролва. */
  get savedPositionSecs(): number {
    return this.position;
  }

  rememberPosition(positionSecs: number): void {
    if (positionSecs >= 0) {
      this.position = positionSecs;
    }
  }

  onSegmentError(status: number): ReResolveDecision {
    if (status !== 403) {
      return 'propagate';
    }

    if (this.awaitingResume) {
      return 'fail';
    }

    this.awaitingResume = true;
    return 'reresolve';
  }

  /** Воспроизведение после переролва пошло — снова реагируем на 403. */
  onPlaybackResumed(): void {
    this.awaitingResume = false;
  }
}
