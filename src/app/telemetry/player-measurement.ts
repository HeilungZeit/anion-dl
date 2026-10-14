import { PlayerEventName, PlayerFeature } from './telemetry.types';

export interface PlayerMeasurementEvent {
  name: PlayerEventName;
  attemptId?: string;
  featureId?: PlayerFeature;
  value?: string;
  durationMs?: number;
}

/** Одна выбранная серия. Пауза, seek и смена качества не создают новый запуск. */
export class PlayerMeasurement {
  private attemptId: string | undefined;
  private requestedAt: number | undefined;
  private started = false;
  private failed = false;
  private lastPosition: number | undefined;
  private lastAt: number | undefined;
  private watchMs = 0;
  private waitingAt: number | undefined;
  private readonly usedFeatures = new Set<string>();

  constructor(
    private readonly emit: (event: PlayerMeasurementEvent) => void,
    private readonly enabled: () => boolean,
    private readonly clock: () => number = () => performance.now(),
    private readonly uuid: () => string = () => crypto.randomUUID(),
  ) {}

  request(measured = true): void {
    if (!this.enabled()) return;
    if (this.attemptId && !this.failed) return;
    this.attemptId = this.uuid();
    this.requestedAt = measured ? this.clock() : undefined;
    this.started = false;
    this.failed = false;
    this.resetPosition();
    this.emit({ name: 'requested', attemptId: this.attemptId, ...(measured ? {} : { value: 'observed' }) });
  }

  observe(position: number, active: boolean, seeking = false, rate = 1): void {
    if (!this.enabled()) {
      this.discard();
      return;
    }
    const now = this.clock();
    if (!active || seeking || !Number.isFinite(position)) {
      this.resetPosition();
      return;
    }
    if (!this.attemptId) this.request(false);
    if (this.lastAt !== undefined && this.lastPosition !== undefined) {
      const elapsed = now - this.lastAt;
      const advance = position - this.lastPosition;
      // Seek и сон вкладки не являются просмотром. Частота timeupdate < 5 с.
      if (elapsed > 0 && elapsed <= 5000 && advance > 0 && advance <= (elapsed / 1000) * Math.max(rate, 1) * 2 + 0.1) {
        if (!this.started) {
          this.started = true;
          this.emit({
            name: 'started',
            attemptId: this.attemptId,
            ...(this.requestedAt === undefined ? {} : { durationMs: Math.round(now - this.requestedAt) }),
          });
        }
        this.watchMs += elapsed;
        if (this.watchMs >= 30_000) this.flushWatch();
      }
    }
    this.lastAt = now;
    this.lastPosition = position;
  }

  waiting(): void {
    if (this.enabled() && this.started && this.waitingAt === undefined) {
      this.waitingAt = this.clock();
      this.resetPosition();
    }
  }

  playing(): void {
    this.endWaiting();
  }

  pause(): void {
    this.endWaiting();
    this.flushWatch();
    this.resetPosition();
  }

  error(code: string): void {
    if (!this.enabled()) return;
    if (!this.failed) {
      this.emit({ name: 'error', attemptId: this.attemptId, value: code });
      this.failed = true;
    }
    this.pause();
  }

  feature(featureId: PlayerFeature, value = 'on', once = false): void {
    if (!this.enabled()) return;
    const key = `${featureId}:${value}`;
    if (once && this.usedFeatures.has(key)) return;
    this.usedFeatures.add(key);
    this.emit({ name: 'feature', featureId, value, attemptId: this.attemptId });
  }

  featureError(featureId: PlayerFeature): void {
    if (this.enabled()) this.emit({ name: 'feature_error', featureId, value: 'failed', attemptId: this.attemptId });
  }

  close(): void {
    this.pause();
  }

  /** Согласие отозвано: накопленное нельзя отправлять после следующего согласия. */
  discard(): void {
    this.resetPosition();
    this.watchMs = 0;
    this.waitingAt = undefined;
    this.attemptId = undefined;
    this.started = false;
    this.failed = false;
    this.requestedAt = undefined;
    this.usedFeatures.clear();
  }

  private endWaiting(): void {
    if (this.waitingAt === undefined) return;
    const durationMs = Math.round(this.clock() - this.waitingAt);
    if (this.enabled() && durationMs > 0) {
      this.emit({ name: 'buffer', attemptId: this.attemptId, durationMs });
    }
    this.waitingAt = undefined;
  }

  private flushWatch(): void {
    if (this.enabled() && this.watchMs > 0) {
      this.emit({ name: 'watch', attemptId: this.attemptId, durationMs: Math.round(this.watchMs) });
    }
    this.watchMs = 0;
  }

  private resetPosition(): void {
    this.lastAt = undefined;
    this.lastPosition = undefined;
  }
}
