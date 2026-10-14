/**
 * Контракт событий плеера — тот же, что у сайта (`anion`, services/telemetry)
 * и у сборщика anion-go (`PUT /telemetry/events`). Бэк принимает только
 * `source: 'web'`, поэтому приложение шлёт под ним же: просмотры из
 * приложения входят в общую статистику плееров сайта.
 */
export type PlayerEventName =
  | 'selected'
  | 'interacted'
  | 'requested'
  | 'started'
  | 'error'
  | 'watch'
  | 'buffer'
  | 'feature'
  | 'feature_error';

export type PlayerFeature =
  | 'quality'
  | 'upscale'
  | 'skip_opening'
  | 'skip_ending'
  | 'auto_skip'
  | 'fullscreen'
  | 'pip'
  | 'theater'
  | 'mini'
  | 'cast'
  | 'airplay';

export interface PlayerTelemetryContext {
  sessionId: string;
  player: string;
  provider: string;
  animeId: number;
  episode: number;
}

/**
 * Что плееру нужно знать о серии для статистики. Сеанс (новый ID) плеер
 * заводит сам при каждой смене серии.
 */
export interface PlayerTelemetryTarget {
  animeId: number;
  episode: number;
  /** Подпись плеера из `videos[].data.player`, например «Плеер Kodik». */
  player: string;
}

export interface ProductEvent extends PlayerTelemetryContext {
  id: string;
  visitorId: string;
  occurredAt: string;
  schemaVersion: 1;
  source: 'web';
  domain: 'player';
  featureId: string;
  featureVersion: string;
  name: PlayerEventName;
  attemptId?: string;
  value?: string;
  durationMs?: number;
  device: 'mobile' | 'desktop';
}
