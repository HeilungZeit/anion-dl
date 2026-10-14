import {
  DestroyRef,
  effect,
  inject,
  Injectable,
  isDevMode,
  untracked,
} from '@angular/core';

import { ApiClient, isApiError } from '../api/http';
import { UserService } from '../api/user.service';
import { PlayerMeasurement, type PlayerMeasurementEvent } from './player-measurement';
import type {
  PlayerTelemetryContext,
  PlayerTelemetryTarget,
  ProductEvent,
} from './telemetry.types';

const VISITOR_KEY = 'anion:analytics-visitor';
const BATCH_SIZE = 40;
/** Очередь живёт в памяти и ограничена даже при недоступном сервере. */
const QUEUE_LIMIT = 200;

/**
 * Провайдер так же, как его пишет сайт: подпись плеера в нижнем регистре,
 * всё лишнее — подчёркиванием. «Плеер Kodik» → `_kodik`; иначе строки
 * приложения и сайта разошлись бы в отчёте.
 */
export function providerOf(player: string): string {
  return (
    player
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .slice(0, 48) || 'other'
  );
}

/**
 * Статистика плееров — перенос `TelemetryService` сайта.
 *
 * Отличия: согласия нет (личный инструмент), сбор выключен в dev-сборке, а не
 * по `localhost` — собранное приложение на macOS тоже живёт на
 * `tauri://localhost`. Админ исключается здесь и ещё раз на сервере по сессии.
 * `keepalive` у плагина http нет: хвост очереди при закрытии окна может
 * потеряться, как и на сайте при аварийном закрытии.
 */
@Injectable({ providedIn: 'root' })
export class TelemetryService {
  private readonly api = inject(ApiClient);
  private readonly users = inject(UserService);
  private queue: ProductEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private visitorId: string | undefined;
  private sending = false;
  private collectionGeneration = 0;

  constructor() {
    // Вошёл админ — накопленное как гость не отправляется.
    effect(() => {
      if (this.users.isAdmin()) {
        untracked(() => this.dropQueue());
      }
    });

    const flush = (): void => {
      queueMicrotask(() => void this.flush());
    };
    const visibility = (): void => {
      if (document.visibilityState === 'hidden') {
        flush();
      }
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', visibility);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', visibility);
      if (this.timer !== undefined) {
        clearTimeout(this.timer);
      }
    });
  }

  enabled(): boolean {
    return !isDevMode() && this.users.isInitialized() && !this.users.isAdmin();
  }

  /** Новый сеанс выбора серии; null — серию не к чему привязать. */
  context(
    target: PlayerTelemetryTarget | null,
    provider = target ? providerOf(target.player) : ''
  ): PlayerTelemetryContext | null {
    if (
      !target ||
      !Number.isInteger(target.animeId) ||
      target.animeId <= 0 ||
      !Number.isInteger(target.episode) ||
      target.episode <= 0
    ) {
      return null;
    }

    return {
      sessionId: crypto.randomUUID(),
      player: 'anion',
      provider,
      animeId: target.animeId,
      episode: target.episode,
    };
  }

  measurement(context: PlayerTelemetryContext | null): PlayerMeasurement {
    let generation = this.collectionGeneration;
    const measurement: PlayerMeasurement = new PlayerMeasurement(
      (event) => {
        if (context) {
          this.record(context, event);
        }
      },
      () => {
        if (generation !== this.collectionGeneration) {
          measurement.discard();
          generation = this.collectionGeneration;
        }
        return context !== null && this.enabled();
      }
    );
    return measurement;
  }

  record(context: PlayerTelemetryContext, event: PlayerMeasurementEvent): void {
    if (!this.enabled()) {
      return;
    }

    this.visitorId ??= this.readVisitorId();
    const { featureId = 'playback', ...data } = event;
    this.queue.push({
      ...context,
      ...data,
      id: crypto.randomUUID(),
      visitorId: this.visitorId,
      occurredAt: new Date().toISOString(),
      schemaVersion: 1,
      domain: 'player',
      source: 'web',
      featureId,
      featureVersion: '1',
      device: 'desktop',
    });
    if (this.queue.length > QUEUE_LIMIT) {
      this.queue.splice(0, this.queue.length - QUEUE_LIMIT);
    }
    this.schedule(this.queue.length >= BATCH_SIZE ? 0 : 5000);
  }

  async flush(): Promise<void> {
    if (!this.enabled()) {
      this.queue = [];
      return;
    }
    if (this.sending || this.queue.length === 0) {
      return;
    }
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = undefined;

    const generation = this.collectionGeneration;
    const batch = this.queue.splice(0, BATCH_SIZE);
    this.sending = true;
    try {
      await this.api.put('/telemetry/events', { consent: true, events: batch });
    } catch (error: unknown) {
      // 4xx — пакет отвергнут целиком: повтор навсегда занял бы голову
      // очереди. Сеть и 5xx повторяются с теми же ID — сервер не засчитает
      // доставленный пакет дважды.
      const status = isApiError(error) ? error.status : 0;
      const retry = status === 0 || status >= 500;
      if (retry && this.enabled() && generation === this.collectionGeneration) {
        this.queue = [...batch, ...this.queue].slice(-QUEUE_LIMIT);
      }
    } finally {
      this.sending = false;
      if (this.queue.length > 0 && this.enabled()) {
        this.schedule(15_000);
      }
    }
  }

  private dropQueue(): void {
    this.queue = [];
    this.collectionGeneration++;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = undefined;
  }

  private schedule(delay: number): void {
    if (this.timer !== undefined) {
      if (delay !== 0) {
        return;
      }
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
  }

  private readVisitorId(): string {
    try {
      const existing = localStorage.getItem(VISITOR_KEY);
      if (existing && /^[\da-f-]{36}$/i.test(existing)) {
        return existing;
      }
      const id = crypto.randomUUID();
      localStorage.setItem(VISITOR_KEY, id);
      return id;
    } catch {
      return crypto.randomUUID();
    }
  }
}
