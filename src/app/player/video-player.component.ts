import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TuiIcon } from '@taiga-ui/core';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import Hls, { type ErrorData, type HlsConfig } from 'hls.js';

import type { VideoSkips } from '../api/anime.types';
import { ResolverService } from '../api/resolver.service';
import { AutoCloseMenuDirective } from './auto-close-menu.directive';
import { DEFAULT_QUALITY, QUALITIES, qualityOf } from './manifest-quality';
import { PlayerSettingsService } from './player-settings.service';
import { ReResolveOnForbidden } from './re-resolve';
import { shouldRefreshAhead } from './signature-clock';
import { SkipController, type SkipHint } from './skip-controller';
import {
  isWebGpuAvailable,
  startUpscale,
  UPSCALE_LABELS,
  UPSCALE_MODES,
  type UpscaleHandle,
  type UpscaleMode,
  type UpscaleStats,
} from './upscale';

export interface PlaybackProgress {
  iframeUrl: string;
  positionSecs: number;
  durationSecs: number;
}

type PlayerStatus = 'resolving' | 'ready' | 'error';

/** Как часто тикает служебный опрос: позиция, прогресс, срок подписи. */
const TICK_MS = 500;

const SEEK_STEP_SECS = 10;

/** Сколько панель держится после последнего движения мыши. */
const CONTROLS_HIDE_MS = 2500;

/**
 * Окно ожидания второго клика.
 *
 * Одиночный клик переключает воспроизведение, двойной — полный экран. Без
 * задержки двойной успел бы дважды дёрнуть play/pause до того, как станет
 * ясно, что это был именно двойной.
 */
const DOUBLE_CLICK_MS = 220;
const VOLUME_STEP = 0.05;

/** Сколько секунд даётся, чтобы отменить переход на следующую серию. */
export const AUTO_NEXT_SECS = 5;

/** Как долго держится один кадр заставки до смены. */
const FRAME_INTERVAL_MS = 6000;

/** Громкость пишется на диск не на каждый шаг ползунка, а когда он замер. */
const VOLUME_SAVE_MS = 500;

/**
 * Горячие клавиши — и для обработчика, и для справки по «?». Буквы сверяются
 * по `event.code`, то есть по физической клавише: с русской раскладкой
 * `event.key` вместо «k» приносит «л», и управление молча переставало работать.
 */
export const HOTKEYS: readonly { keys: string; action: string }[] = [
  { keys: 'Пробел / K', action: 'Пауза и воспроизведение' },
  { keys: '← / →', action: 'Назад / вперёд на 10 секунд' },
  { keys: '↑ / ↓', action: 'Громкость' },
  { keys: 'M', action: 'Выключить звук' },
  { keys: 'F', action: 'Полный экран' },
  { keys: 'P', action: 'Картинка в картинке' },
  { keys: 'N', action: 'Следующая серия' },
  { keys: '?', action: 'Эта справка' },
  { keys: 'Esc', action: 'Закрыть справку, выйти из полного экрана' },
];

/**
 * WebKit до сих пор держит «картинку в картинке» за собственным API, а
 * стандартный есть не во всех его сборках. Поддерживаем оба.
 */
interface WebKitVideo extends HTMLVideoElement {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
}

function isPipSupported(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }

  if (document.pictureInPictureEnabled) {
    return true;
  }

  const probe = document.createElement('video') as WebKitVideo;
  return (
    typeof probe.webkitSupportsPresentationMode === 'function' &&
    probe.webkitSupportsPresentationMode('picture-in-picture')
  );
}

export function formatTime(totalSecs: number): string {
  if (!Number.isFinite(totalSecs) || totalSecs < 0) {
    return '0:00';
  }

  const secs = Math.floor(totalSecs % 60);
  const mins = Math.floor(totalSecs / 60) % 60;
  const hours = Math.floor(totalSecs / 3600);
  const mm = String(mins).padStart(hours > 0 ? 2 : 1, '0');

  return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(secs).padStart(2, '0')}`;
}

@Component({
  selector: 'app-video-player',
  imports: [TuiIcon, AutoCloseMenuDirective],
  templateUrl: './video-player.component.html',
  styleUrl: './video-player.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VideoPlayerComponent {
  private readonly resolver = inject(ResolverService);
  private readonly settings = inject(PlayerSettingsService);

  /** URL плеера Kodik: из него резолвится манифест. */
  readonly iframeUrl = input.required<string>();
  readonly skips = input<VideoSkips>({});
  readonly isLastEpisode = input(false);
  readonly poster = input('');

  /**
   * Кадры из серий для заставки до запуска. Сменяются сами; постер остаётся
   * запасным вариантом, когда кадров нет.
   */
  readonly frames = input<readonly string[]>([]);

  /**
   * Путь к скачанному mp4. Если задан, поток с Kodik не резолвится вовсе:
   * серия играет с диска — быстрее, без сети и без протухающих подписей.
   * `iframeUrl` при этом остаётся ключом серии для прогресса.
   */
  readonly localPath = input<string | null>(null);

  /**
   * Откуда начать. Читается один раз на серию и намеренно не отслеживается
   * эффектом: иначе сохранение позиции перезапускало бы воспроизведение.
   */
  readonly startPositionSecs = input(0);

  readonly progress = output<PlaybackProgress>();
  readonly ended = output<PlaybackProgress>();
  readonly nextEpisode = output<void>();
  readonly playbackPaused = output<PlaybackProgress>();
  /**
   * Воспроизведение действительно пошло. Каждый `play`, а не только первый:
   * повторы отсекает получатель, а плееру незачем помнить, что уже сообщал.
   */
  readonly playbackStarted = output<string>();

  readonly status = signal<PlayerStatus>('resolving');
  readonly errorText = signal('');

  readonly requestedQuality = signal<number>(DEFAULT_QUALITY);
  readonly actualQuality = signal<number | null>(null);
  readonly qualities = QUALITIES;

  readonly position = signal(0);
  readonly duration = signal(0);
  readonly bufferedTo = signal(0);
  readonly paused = signal(true);
  /** Воспроизведение встало в ожидании данных: `waiting` без `playing`. */
  readonly buffering = signal(false);
  readonly volume = signal(1);
  readonly muted = signal(false);
  readonly isFullscreen = signal(false);
  readonly skipHint = signal<SkipHint | null>(null);

  /** Играет ли сейчас файл с диска: у него нет ни качества, ни подписи. */
  readonly isLocal = signal(false);

  /**
   * Сохранённая позиция, с которой серия откроется. Пока воспроизведение не
   * началось, плеер предлагает продолжить или начать сначала; null — нечего
   * предлагать.
   */
  readonly resumeOffer = signal<number | null>(null);

  /** Обратный отсчёт до следующей серии; null — отсчёта нет. */
  readonly autoNextSecs = signal<number | null>(null);

  /** Кадры, которые не загрузились, — из показа убираются. */
  private readonly brokenFrames = signal<ReadonlySet<string>>(new Set());
  readonly visibleFrames = computed(() => {
    const broken = this.brokenFrames();
    return this.frames().filter((url) => !broken.has(url));
  });
  readonly frameIndex = signal(0);

  /**
   * Воспроизведение этой серии уже шло. Заставка нужна только до первого
   * запуска: на паузе посреди серии человек хочет видеть свой кадр.
   */
  readonly playedOnce = signal(false);
  readonly showFrames = computed(
    () => !this.playedOnce() && this.visibleFrames().length > 0
  );

  /** Кадры в DOM: текущий, прошлый — для плавной смены — и следующий впрок. */
  readonly mountedFrames = computed(() => {
    const frames = this.visibleFrames();
    const count = frames.length;
    const current = this.frameIndex() % Math.max(count, 1);

    return frames
      .map((url, index) => ({ url, index }))
      .filter(
        ({ index }) =>
          index === current ||
          index === (current + 1) % count ||
          index === (current - 1 + count) % count
      );
  });

  readonly pipSupported = isPipSupported();
  readonly hotkeys = HOTKEYS;
  readonly helpOpen = signal(false);

  /** Панель прячется только во время игры: на паузе она нужна всегда. */
  readonly controlsVisible = signal(true);

  /** Время под курсором на полосе перемотки; null — курсора на ней нет. */
  readonly hoverSecs = signal<number | null>(null);
  readonly hoverPercent = signal(0);

  /** Апскейл: режим, доступность и возможная ошибка запуска. */
  readonly upscaleMode = signal<UpscaleMode>('off');
  readonly upscaleModes = UPSCALE_MODES;
  readonly upscaleLabels = UPSCALE_LABELS;
  readonly upscaleSupported = isWebGpuAvailable();
  readonly upscaleError = signal('');
  readonly upscaleStats = signal<UpscaleStats | null>(null);

  /** Растёт на каждой пересборке потока — сигнал апскейлу пересобраться. */
  private readonly manifestGeneration = signal(0);
  readonly upscaleActive = computed(
    () => this.upscaleMode() !== 'off' && this.upscaleError() === ''
  );

  /**
   * Нажимал ли человек «play» хоть раз.
   *
   * От этого зависит автозапуск при смене серии: открытие страницы тайтла
   * воспроизведение не начинает, а вот выбор другой серии — уже осознанное
   * действие, и останавливаться на постере там незачем.
   */
  readonly hasStarted = signal(false);

  readonly formatTime = formatTime;

  private readonly videoRef =
    viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly canvasRef =
    viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  private hls: Hls | null = null;
  private manifestUrl = '';
  private playbackIframeUrl = '';
  private playbackReady = false;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private skipController = new SkipController({});
  private readonly latch = new ReResolveOnForbidden();

  /** Отсекает ответы резолвера по сериям, которые уже закрыли. */
  private generation = 0;
  private refreshing = false;
  private expectResume = false;
  private scrubbing = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private clickTimer: ReturnType<typeof setTimeout> | null = null;
  private upscaler: UpscaleHandle | null = null;
  /** Отсекает запуск апскейла, который успел устареть, пока ждал GPU. */
  private upscaleToken = 0;
  private autoNextTimer: ReturnType<typeof setInterval> | null = null;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private readonly reducedMotion =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;
  private volumeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Громкость применяется к элементу, только когда тот уже в DOM. */
  private readonly savedVolume = signal<{ volume: number; muted: boolean } | null>(
    null
  );

  constructor() {
    void this.settings
      .getUpscale()
      .then((mode) => this.upscaleMode.set(mode));

    void this.settings
      .getVolume()
      .then((setting) => this.savedVolume.set(setting))
      .catch(() => undefined);

    // Элемент видео и сохранённая громкость появляются в разном порядке —
    // применяем, когда есть оба. Дальше громкость меняет только человек.
    effect(() => {
      const video = this.videoRef()?.nativeElement;
      const setting = this.savedVolume();

      if (video && setting) {
        video.volume = setting.volume;
        video.muted = setting.muted;
      }
    });

    // Апскейл пересобирается и при смене режима, и при смене потока: после
    // переролва или другого качества в DOM уже другой кадр, а конвейер
    // WebGPU привязан к прежним размерам.
    effect(() => {
      const mode = this.upscaleMode();
      const ready = this.status() === 'ready';
      this.manifestGeneration();

      untracked(() => void this.applyUpscale(mode, ready));
    });

    // Заставка крутится, пока её видно. Новый набор кадров (другая серия)
    // начинается с первого — там кадры именно этой серии.
    effect(() => {
      this.frames();
      untracked(() => {
        this.frameIndex.set(0);
        this.brokenFrames.set(new Set());
      });
    });

    effect(() => {
      const cycling =
        this.showFrames() &&
        this.visibleFrames().length > 1 &&
        !this.reducedMotion;

      untracked(() =>
        cycling ? this.startFrameCycle() : this.stopFrameCycle()
      );
    });

    // Источник выбирается на смене серии и дальше не меняется: докачавшаяся
    // посреди просмотра серия не должна перезапускать воспроизведение с диска.
    effect(() => {
      const url = this.iframeUrl();

      untracked(() => {
        const localPath = this.localPath();
        const startSecs = this.startPositionSecs();
        this.cancelAutoNext();
        this.playedOnce.set(false);
        this.resumeOffer.set(startSecs > 0 ? startSecs : null);
        this.skipController = new SkipController(
          this.skips(),
          this.isLastEpisode()
        );
        void this.load(url, this.requestedQuality(), startSecs, localPath);
      });
    });

    // Окно могут вывести из полноэкранного режима мимо нас — зелёной кнопкой
    // или системным жестом. Без подписки на его размер наша разметка осталась
    // бы растянутой поверх обычного окна.
    const window = getCurrentWindow();
    let unlisten: (() => void) | null = null;

    void window
      .onResized(() => {
        void window
          .isFullscreen()
          .then((value) => this.isFullscreen.set(value))
          .catch(() => undefined);
      })
      .then((stop) => {
        unlisten = stop;
      })
      .catch(() => undefined);

    inject(DestroyRef).onDestroy(() => {
      this.emitPausedProgress();
      unlisten?.();
      if (this.hideTimer !== null) {
        clearTimeout(this.hideTimer);
      }

      if (this.clickTimer !== null) {
        clearTimeout(this.clickTimer);
      }

      if (this.volumeTimer !== null) {
        clearTimeout(this.volumeTimer);
      }

      this.cancelAutoNext();
      this.stopFrameCycle();
      this.stopUpscale();
      this.teardown();
    });
  }

  // ——— загрузка ———

  private async load(
    iframeUrl: string,
    quality: number,
    positionSecs: number,
    localPath: string | null = null
  ): Promise<void> {
    const token = ++this.generation;

    this.status.set('resolving');
    this.errorText.set('');
    this.skipHint.set(null);

    if (localPath) {
      await this.loadLocal(token, localPath, positionSecs, iframeUrl);
      return;
    }

    try {
      const manifest = await this.resolver.resolveManifest(iframeUrl, quality);

      if (token !== this.generation) {
        return;
      }

      this.attach(manifest, positionSecs, iframeUrl);
    } catch (error: unknown) {
      if (token === this.generation) {
        this.fail(error instanceof Error ? error.message : String(error));
      }
    }
  }

  /**
   * Файл с диска. Доступ к нему asset-протоколу выдаёт Rust поштучно — см.
   * `allow_playback`. `crossOrigin` обязателен: без него кадр считается чужим,
   * и апскейл не сможет его прочитать; asset-протокол отвечает нужным CORS.
   */
  private async loadLocal(
    token: number,
    path: string,
    positionSecs: number,
    iframeUrl: string
  ): Promise<void> {
    try {
      await invoke('allow_playback', { path });
    } catch (error: unknown) {
      if (token === this.generation) {
        this.fail(String(error));
      }
      return;
    }

    const video = this.videoRef()?.nativeElement;
    if (token !== this.generation || !video) {
      return;
    }

    this.detachCurrent();
    this.isLocal.set(true);
    this.manifestUrl = '';
    this.playbackIframeUrl = iframeUrl;
    this.actualQuality.set(null);

    video.crossOrigin = 'anonymous';
    video.addEventListener(
      'loadedmetadata',
      () => {
        if (token === this.generation) {
          this.onReady(video, positionSecs);
        }
      },
      { once: true }
    );
    video.src = convertFileSrc(path);
    this.startTicker();
  }

  /** До destroy старый поток ещё хранит честную позицию — сохраняем её. */
  private detachCurrent(): void {
    // Событие pause после уничтожения MediaSource уже может принести 0/0.
    this.emitPausedProgress();
    this.playbackReady = false;
    this.buffering.set(false);
    this.destroyHls();
  }

  private attach(
    manifestUrl: string,
    positionSecs: number,
    iframeUrl: string
  ): void {
    const video = this.videoRef()?.nativeElement;
    if (!video) {
      return;
    }

    this.detachCurrent();

    // Файл с диска оставил бы src и CORS-режим, а hls.js подставляет свой
    // MediaSource и о прошлом источнике не знает.
    if (this.isLocal()) {
      this.isLocal.set(false);
      video.removeAttribute('src');
      video.removeAttribute('crossorigin');
    }

    this.manifestUrl = manifestUrl;
    this.playbackIframeUrl = iframeUrl;
    this.actualQuality.set(qualityOf(manifestUrl));

    if (Hls.isSupported()) {
      const hls = new Hls(this.hlsConfig());
      this.hls = hls;

      hls.on(Hls.Events.ERROR, (_event, data) => this.onHlsError(data));
      hls.on(Hls.Events.MANIFEST_PARSED, () => this.onReady(video, positionSecs));

      hls.loadSource(manifestUrl);
      hls.attachMedia(video);
      this.startTicker();
      return;
    }

    // WKWebView умеет HLS сам, и это не теоретический запасной путь: сборки
    // WebKitGTK без MediaSource существуют, а там hls.js не заработает вовсе.
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = manifestUrl;
      video.addEventListener(
        'loadedmetadata',
        () => this.onReady(video, positionSecs),
        { once: true }
      );
      this.startTicker();
      return;
    }

    this.fail(
      'Этот вебвью не умеет ни MediaSource, ни HLS — воспроизведение недоступно.'
    );
  }

  private hlsConfig(): Partial<HlsConfig> {
    const base = Hls.DefaultConfig;

    // 403 означает протухшую подпись: она не оживёт, и ретраи вылились бы в
    // шторм запросов, который обошёл бы затвор ReResolveOnForbidden. Ровно то,
    // что на ТВ делает NoRetryOnForbiddenPolicy.
    const noRetryOn403 = <T extends { errorRetry: unknown }>(policy: {
      default: T;
    }): { default: T } => ({
      default: {
        ...policy.default,
        errorRetry:
          policy.default.errorRetry === null
            ? null
            : {
                ...(policy.default.errorRetry as object),
                shouldRetry: (
                  _config: unknown,
                  _count: number,
                  _isTimeout: boolean,
                  response: { code?: number } | undefined,
                  retry: boolean
                ): boolean => (response?.code === 403 ? false : retry),
              },
      } as T,
    });

    return {
      // По умолчанию hls.js держит впереди лишь 30 с: на медленном CDN этого
      // не хватает, чтобы пережить провал скорости без остановки. Две минуты
      // вперёд — порядка 30–60 МБ при 720p; потолок в байтах поднят с 60 МБ,
      // иначе он обрезал бы запас раньше секунд на высоком битрейте.
      maxBufferLength: 120,
      maxMaxBufferLength: 180,
      maxBufferSize: 200 * 1000 * 1000,
      // Позади хватит минуты на перемотку назад; без предела просмотренное
      // копилось бы в памяти до конца серии.
      backBufferLength: 60,
      fragLoadPolicy: noRetryOn403(base.fragLoadPolicy),
      playlistLoadPolicy: noRetryOn403(base.playlistLoadPolicy),
    };
  }

  private onReady(video: HTMLVideoElement, positionSecs: number): void {
    this.status.set('ready');
    this.duration.set(video.duration || 0);

    if (positionSecs > 0 && Number.isFinite(video.duration)) {
      video.currentTime = Math.min(positionSecs, video.duration - 1);
    }

    this.playbackReady = true;

    // Открытие страницы тайтла просмотр не начинает: человек пришёл почитать
    // описание или выбрать серию, а не слушать опенинг. Дальше — начинает:
    // смена серии и переролв подписи происходят уже во время просмотра.
    if (this.hasStarted()) {
      void video.play().catch(() => undefined);
    }
  }

  private fail(message: string): void {
    this.status.set('error');
    this.errorText.set(message);
    this.stopTicker();
  }

  // ——— ошибки и обновление подписи ———

  private onHlsError(data: ErrorData): void {
    if (this.refreshing) {
      return;
    }

    switch (this.latch.onSegmentError(data.response?.code ?? -1)) {
      case 'reresolve':
        void this.refresh();
        return;
      case 'fail':
        this.fail('Подпись потока истекла, обновить не удалось.');
        return;
      case 'propagate':
        if (data.fatal) {
          this.fail(data.error?.message || 'Ошибка воспроизведения');
        }
    }
  }

  /** Тихо перезабрать манифест и продолжить с той же секунды. */
  private async refresh(): Promise<void> {
    if (this.refreshing) {
      return;
    }

    this.refreshing = true;

    try {
      const video = this.videoRef()?.nativeElement;
      const position =
        video && video.currentTime > 0
          ? video.currentTime
          : this.latch.savedPositionSecs;

      const manifest = await this.resolver.resolveManifest(
        this.iframeUrl(),
        this.requestedQuality()
      );

      this.expectResume = true;
      this.attach(manifest, position, this.iframeUrl());
    } catch (error: unknown) {
      this.fail(
        error instanceof Error ? error.message : 'Не удалось обновить поток'
      );
    } finally {
      this.refreshing = false;
    }
  }

  private startTicker(): void {
    this.stopTicker();

    this.ticker = setInterval(() => {
      const video = this.videoRef()?.nativeElement;
      if (!video || !this.playbackReady) {
        return;
      }

      const position = video.currentTime;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;

      this.latch.rememberPosition(position);
      this.skipHint.set(this.skipController.visibleSkip(position, duration));
      this.progress.emit({
        iframeUrl: this.playbackIframeUrl,
        positionSecs: position,
        durationSecs: duration,
      });

      // READY на каждом тике сбросил бы затвор и пропустил шторм сегментов,
      // поэтому флаг снимается ровно один раз после переролва.
      if (this.expectResume && !video.paused && video.readyState >= 3) {
        this.expectResume = false;
        this.latch.onPlaybackResumed();
      }

      if (
        !this.refreshing &&
        this.manifestUrl &&
        shouldRefreshAhead(this.manifestUrl)
      ) {
        void this.refresh();
      }
    }, TICK_MS);
  }

  private stopTicker(): void {
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private destroyHls(): void {
    this.hls?.destroy();
    this.hls = null;
  }

  private teardown(): void {
    this.stopTicker();
    this.destroyHls();
  }

  // ——— события элемента ———

  onMetadata(): void {
    const video = this.videoRef()?.nativeElement;
    if (video) {
      this.duration.set(Number.isFinite(video.duration) ? video.duration : 0);
    }
  }

  onTimeUpdate(): void {
    const video = this.videoRef()?.nativeElement;
    if (!video) {
      return;
    }

    this.position.set(video.currentTime);

    const ranges = video.buffered;
    for (let i = 0; i < ranges.length; i += 1) {
      if (
        ranges.start(i) <= video.currentTime &&
        video.currentTime <= ranges.end(i)
      ) {
        this.bufferedTo.set(ranges.end(i));
        return;
      }
    }
  }

  onVolumeChange(): void {
    const video = this.videoRef()?.nativeElement;
    if (!video) {
      return;
    }

    this.volume.set(video.volume);
    this.muted.set(video.muted);

    if (this.volumeTimer !== null) {
      clearTimeout(this.volumeTimer);
    }

    const setting = { volume: video.volume, muted: video.muted };
    this.volumeTimer = setTimeout(() => {
      this.volumeTimer = null;
      void this.settings.setVolume(setting).catch(() => undefined);
    }, VOLUME_SAVE_MS);
  }

  /** У HLS свои ошибки через hls.js, а у файла с диска других сигналов нет. */
  onVideoError(): void {
    if (this.isLocal() && this.status() !== 'error') {
      this.fail('Не удалось воспроизвести файл с диска.');
    }
  }

  onWaiting(): void {
    this.buffering.set(true);
  }

  onPlaying(): void {
    this.buffering.set(false);
  }

  onEnded(): void {
    this.buffering.set(false);
    this.paused.set(true);
    this.startAutoNext();
    const video = this.videoRef()?.nativeElement;
    this.ended.emit({
      iframeUrl: this.playbackIframeUrl,
      positionSecs: video?.currentTime ?? this.position(),
      durationSecs:
        video && Number.isFinite(video.duration)
          ? video.duration
          : this.duration(),
    });
  }

  onPlay(): void {
    this.paused.set(false);
    this.playedOnce.set(true);
    this.resumeOffer.set(null);
    this.pokeControls();

    if (this.playbackIframeUrl) {
      this.playbackStarted.emit(this.playbackIframeUrl);
    }
  }

  onPause(): void {
    this.buffering.set(false);
    this.paused.set(true);
    this.pokeControls();
    this.emitPausedProgress();
  }

  private emitPausedProgress(): void {
    const video = this.videoRef()?.nativeElement;
    if (
      !video ||
      !this.playbackReady ||
      !this.playbackIframeUrl ||
      !Number.isFinite(video.duration) ||
      video.duration <= 0
    ) {
      return;
    }

    this.playbackPaused.emit({
      iframeUrl: this.playbackIframeUrl,
      positionSecs: video.currentTime,
      durationSecs: Number.isFinite(video.duration) ? video.duration : 0,
    });
  }

  // ——— управление ———

  /** Клик по кадру: воспроизведение, но с оглядкой на возможный двойной. */
  onVideoClick(): void {
    if (this.clickTimer !== null) {
      return;
    }

    this.clickTimer = setTimeout(() => {
      this.clickTimer = null;
      this.togglePlay();
    }, DOUBLE_CLICK_MS);
  }

  onVideoDoubleClick(): void {
    if (this.clickTimer !== null) {
      clearTimeout(this.clickTimer);
      this.clickTimer = null;
    }

    void this.toggleFullscreen();
  }

  togglePlay(): void {
    const video = this.videoRef()?.nativeElement;
    if (!video) {
      return;
    }

    if (video.paused) {
      this.hasStarted.set(true);
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }

  /** Позиция уже выставлена при готовности потока — осталось запустить. */
  resumePlayback(): void {
    this.resumeOffer.set(null);
    this.togglePlay();
  }

  startOver(): void {
    this.resumeOffer.set(null);
    this.seekTo(0);
    this.togglePlay();
  }

  async changeUpscale(mode: UpscaleMode): Promise<void> {
    if (mode === this.upscaleMode()) {
      return;
    }

    this.upscaleMode.set(mode);
    await this.settings.setUpscale(mode);
  }

  private async applyUpscale(mode: UpscaleMode, ready: boolean): Promise<void> {
    // Запуск асинхронный: пока ждём адаптер и шейдеры, режим успевают
    // переключить ещё раз. Без метки оба запуска дожили бы до конца и рисовали
    // бы в одну канву, а остановить удалось бы только последний.
    const token = ++this.upscaleToken;

    this.stopUpscale();
    this.upscaleError.set('');
    this.upscaleStats.set(null);

    const video = this.videoRef()?.nativeElement;
    const canvas = this.canvasRef()?.nativeElement;

    if (mode === 'off' || !ready || !video || !canvas) {
      return;
    }

    try {
      const handle = await startUpscale({
        video,
        canvas,
        mode,
        onStats: (stats) => {
          if (token === this.upscaleToken) {
            this.upscaleStats.set(stats);
          }
        },
        onError: (message) => {
          // Цикл уже остановился сам; здесь остаётся показать причину и
          // погасить канву, чтобы под ней снова было видно обычное видео.
          if (token === this.upscaleToken) {
            this.upscaleError.set(message);
            this.upscaleStats.set(null);
          }
        },
      });

      if (token !== this.upscaleToken) {
        handle.destroy();
        return;
      }

      this.upscaler = handle;
    } catch (error: unknown) {
      // Молча откатываться нельзя: человек включил режим и должен понять,
      // почему картинка не изменилась.
      if (token === this.upscaleToken) {
        this.upscaleError.set(
          error instanceof Error ? error.message : 'Апскейл не запустился'
        );
      }
    }
  }

  private stopUpscale(): void {
    this.upscaler?.destroy();
    this.upscaler = null;
    this.upscaleStats.set(null);
  }

  // ——— видимость панели ———

  /** Показать панель и завести таймер на её скрытие. */
  pokeControls(): void {
    this.controlsVisible.set(true);
    this.restartHideTimer();
  }

  /** Курсор ушёл с плеера — прятать сразу, но только если идёт воспроизведение. */
  hideControlsSoon(): void {
    if (!this.paused()) {
      this.controlsVisible.set(false);
    }
  }

  private restartHideTimer(): void {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
    }

    this.hideTimer = setTimeout(() => {
      if (!this.paused() && !this.scrubbing) {
        this.controlsVisible.set(false);
      }
    }, CONTROLS_HIDE_MS);
  }

  seekBy(deltaSecs: number): void {
    const video = this.videoRef()?.nativeElement;
    if (!video) {
      return;
    }

    this.seekTo(video.currentTime + deltaSecs);
  }

  seekTo(secs: number): void {
    const video = this.videoRef()?.nativeElement;
    if (!video || !Number.isFinite(video.duration)) {
      return;
    }

    video.currentTime = Math.min(Math.max(secs, 0), video.duration);
    this.position.set(video.currentTime);
  }

  setVolume(value: number): void {
    const video = this.videoRef()?.nativeElement;
    if (!video) {
      return;
    }

    video.volume = Math.min(Math.max(value, 0), 1);
    video.muted = video.volume === 0;
  }

  toggleMuted(): void {
    const video = this.videoRef()?.nativeElement;
    if (video) {
      video.muted = !video.muted;
    }
  }

  changeQuality(quality: number): void {
    if (quality !== this.requestedQuality()) {
      this.requestedQuality.set(quality);
      void this.switchQuality(quality);
    }
  }

  /** Смена качества использует текущую подпись и не повторяет полный резолв. */
  private async switchQuality(quality: number): Promise<void> {
    if (!this.manifestUrl) {
      return;
    }

    const token = ++this.generation;
    const video = this.videoRef()?.nativeElement;
    const positionSecs = video?.currentTime ?? this.position();
    const iframeUrl = this.playbackIframeUrl || this.iframeUrl();

    try {
      const manifest = await this.resolver.changeManifestQuality(
        this.manifestUrl,
        quality
      );

      if (token !== this.generation) {
        return;
      }

      this.expectResume = true;
      this.attach(manifest, positionSecs, iframeUrl);
    } catch (error: unknown) {
      if (token === this.generation) {
        this.fail(
          error instanceof Error ? error.message : 'Не удалось сменить качество'
        );
      }
    }
  }

  retry(): void {
    void this.load(
      this.iframeUrl(),
      this.requestedQuality(),
      this.position(),
      this.localPath()
    );
  }

  // ——— заставка ———

  /** Ручной выбор кадра перезапускает таймер, чтобы кадр не сменился сразу. */
  showFrame(index: number): void {
    this.frameIndex.set(index);

    if (this.frameTimer !== null) {
      this.startFrameCycle();
    }
  }

  onFrameError(url: string): void {
    this.brokenFrames.update((broken) => new Set([...broken, url]));
  }

  private startFrameCycle(): void {
    this.stopFrameCycle();
    this.frameTimer = setInterval(() => {
      const count = this.visibleFrames().length;
      if (count > 0) {
        this.frameIndex.update((index) => (index + 1) % count);
      }
    }, FRAME_INTERVAL_MS);
  }

  private stopFrameCycle(): void {
    if (this.frameTimer !== null) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
  }

  // ——— следующая серия ———

  /**
   * После конца серии — отсчёт до следующей, а не мгновенный переход: человек
   * мог досматривать титры или собирался закрыть плеер.
   */
  private startAutoNext(): void {
    if (this.isLastEpisode()) {
      return;
    }

    this.cancelAutoNext();
    this.autoNextSecs.set(AUTO_NEXT_SECS);
    this.autoNextTimer = setInterval(() => {
      const left = (this.autoNextSecs() ?? 0) - 1;

      if (left > 0) {
        this.autoNextSecs.set(left);
        return;
      }

      this.goNext();
    }, 1000);
  }

  cancelAutoNext(): void {
    if (this.autoNextTimer !== null) {
      clearInterval(this.autoNextTimer);
      this.autoNextTimer = null;
    }

    this.autoNextSecs.set(null);
  }

  goNext(): void {
    this.cancelAutoNext();

    if (!this.isLastEpisode()) {
      // Переход — осознанное продолжение просмотра, новая серия стартует сама.
      this.hasStarted.set(true);
      this.nextEpisode.emit();
    }
  }

  // ——— картинка в картинке ———

  /**
   * Апскейл в окно PiP не попадает: система показывает сам `<video>`, а не
   * канву поверх него. Это ограничение ОС, а не недосмотр.
   */
  async togglePip(): Promise<void> {
    const video = this.videoRef()?.nativeElement as WebKitVideo | undefined;
    if (!video || !this.pipSupported) {
      return;
    }

    try {
      if (document.pictureInPictureEnabled) {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else {
          await video.requestPictureInPicture();
        }
        return;
      }

      video.webkitSetPresentationMode?.(
        video.webkitPresentationMode === 'picture-in-picture'
          ? 'inline'
          : 'picture-in-picture'
      );
    } catch {
      // Вебвью отказал (например, метаданные ещё не пришли) — кнопка просто
      // ничего не делает, как и системная.
    }
  }

  toggleHelp(): void {
    this.helpOpen.update((open) => !open);
  }

  /** Опенинг перематывается внутри серии, конец — уводит на следующую. */
  applySkip(hint: SkipHint): void {
    if (hint.kind === 'opening') {
      this.seekTo(this.skipController.skipTargetSecs(hint.segment));
      return;
    }

    this.goNext();
  }

  /**
   * Полный экран делает окно приложения, а не элемент.
   *
   * `element.requestFullscreen()` в WKWebView просто отклоняется: Fullscreen
   * API там за отдельной настройкой, которую Tauri не включает. Поэтому режим
   * складывается из двух частей — окно уходит в полный экран средствами ОС, а
   * разметка растягивает плеер на это окно классом. Если разрешения на окно
   * нет, останется хотя бы второе, и кнопка не будет мёртвой.
   */
  async toggleFullscreen(): Promise<void> {
    const next = !this.isFullscreen();
    this.isFullscreen.set(next);

    try {
      await getCurrentWindow().setFullscreen(next);
    } catch {
      // Разрешения нет — плеер всё равно занял окно целиком.
    }
  }

  // ——— клавиатура ———

  onKeydown(event: KeyboardEvent): void {
    // Пробел и Enter на сфокусированной кнопке панели нажимают её, а не
    // ставят паузу: иначе с клавиатуры не нажать ни одну кнопку плеера.
    const target = event.target as HTMLElement | null;
    if (
      (event.key === ' ' || event.key === 'Enter') &&
      target !== event.currentTarget &&
      target?.matches('button, summary, input')
    ) {
      return;
    }

    const handled = this.handleKey(event);

    if (handled) {
      // Иначе пробел прокрутит страницу, а стрелки уедут по полосе серий.
      event.preventDefault();
      event.stopPropagation();
    }
  }

  private handleKey(event: KeyboardEvent): boolean {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      // Cmd+F, Cmd+M и прочие системные сочетания — не наши.
      return false;
    }

    // «?» на разных раскладках живёт на разных клавишах, поэтому по символу.
    if (event.key === '?') {
      this.toggleHelp();
      return true;
    }

    switch (event.code) {
      case 'KeyK':
        this.togglePlay();
        return true;
      case 'KeyF':
        void this.toggleFullscreen();
        return true;
      case 'KeyM':
        this.toggleMuted();
        return true;
      case 'KeyP':
        void this.togglePip();
        return true;
      case 'KeyN':
        this.goNext();
        return true;
    }

    switch (event.key) {
      case ' ':
        this.togglePlay();
        return true;
      case 'ArrowRight':
        this.seekBy(SEEK_STEP_SECS);
        return true;
      case 'ArrowLeft':
        this.seekBy(-SEEK_STEP_SECS);
        return true;
      case 'ArrowUp':
        this.setVolume(this.volume() + VOLUME_STEP);
        return true;
      case 'ArrowDown':
        this.setVolume(this.volume() - VOLUME_STEP);
        return true;
      case 'Escape':
        if (this.helpOpen()) {
          this.helpOpen.set(false);
          return true;
        }

        if (this.autoNextSecs() !== null) {
          this.cancelAutoNext();
          return true;
        }

        if (!this.isFullscreen()) {
          return false;
        }

        void this.toggleFullscreen();
        return true;
      default:
        return false;
    }
  }

  onVolumeInput(event: Event): void {
    this.setVolume(Number((event.target as HTMLInputElement).value));
  }

  // ——— полоса перемотки ———

  scrubStart(event: PointerEvent, bar: HTMLElement): void {
    // Захват указателя нужен, чтобы перетаскивание продолжалось и когда
    // курсор ушёл за пределы полосы: иначе ползунок бросает на полпути.
    bar.setPointerCapture(event.pointerId);
    this.scrubbing = true;
    this.scrub(event, bar);
  }

  scrubMove(event: PointerEvent, bar: HTMLElement): void {
    if (this.scrubbing) {
      this.scrub(event, bar);
    }
  }

  scrubEnd(event: PointerEvent, bar: HTMLElement): void {
    if (this.scrubbing) {
      this.scrubbing = false;
      bar.releasePointerCapture(event.pointerId);
    }
  }

  /** Наведение на полосу: подсказка со временем в точке под курсором. */
  hoverSeek(event: PointerEvent, bar: HTMLElement): void {
    const duration = this.duration();
    if (duration <= 0) {
      return;
    }

    const ratio = this.ratioAt(event, bar);
    this.hoverPercent.set(ratio * 100);
    this.hoverSecs.set(ratio * duration);
  }

  clearHover(): void {
    this.hoverSecs.set(null);
  }

  private ratioAt(event: PointerEvent, bar: HTMLElement): number {
    const box = bar.getBoundingClientRect();

    return Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
  }

  private scrub(event: PointerEvent, bar: HTMLElement): void {
    const duration = this.duration();
    if (duration <= 0) {
      return;
    }

    this.seekTo(this.ratioAt(event, bar) * duration);
  }
}
