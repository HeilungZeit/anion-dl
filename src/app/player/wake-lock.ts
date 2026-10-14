/**
 * Не даёт экрану погаснуть, пока идёт серия. Без полного экрана телефон
 * гасил экран посреди серии: для системы человек «ничего не делает».
 *
 * Браузер сам снимает блокировку, когда вкладка уходит в фон, — по возвращении
 * она берётся заново, если серия всё ещё играет.
 */
export class ScreenWakeLock {
  private wanted = false;
  private sentinel: WakeLockSentinel | null = null;
  private requesting = false;

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      void this.sync();
    }
  };

  constructor() {
    if (supported()) {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  set(wanted: boolean): void {
    this.wanted = wanted;
    void this.sync();
  }

  destroy(): void {
    this.wanted = false;
    if (supported()) {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    void this.sync();
  }

  private async sync(): Promise<void> {
    if (!supported() || this.requesting) {
      return;
    }

    if (!this.wanted) {
      const sentinel = this.sentinel;
      this.sentinel = null;
      await sentinel?.release().catch(() => undefined);
      return;
    }

    if (this.sentinel && !this.sentinel.released) {
      return;
    }

    if (document.visibilityState !== 'visible') {
      return;
    }

    this.requesting = true;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
    } catch {
      // Отказ (энергосбережение, политика) — экран просто гаснет как обычно.
      this.sentinel = null;
    } finally {
      this.requesting = false;
    }

    // Пока ждали ответа, серию могли поставить на паузу.
    if (!this.wanted) {
      void this.sync();
    }
  }
}

function supported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}
