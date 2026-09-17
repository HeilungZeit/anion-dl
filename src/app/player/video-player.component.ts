import {
  ChangeDetectionStrategy,
  Component,
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
import { getCurrentWindow } from '@tauri-apps/api/window';
import Hls, { type ErrorData, type HlsConfig } from 'hls.js';

import type { VideoSkips } from '../api/anime.types';
import { ResolverService } from '../api/resolver.service';
import { DEFAULT_QUALITY, QUALITIES, qualityOf } from './manifest-quality';
import { ReResolveOnForbidden } from './re-resolve';
import { shouldRefreshAhead } from './signature-clock';
import { SkipController, type SkipHint } from './skip-controller';

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
const VOLUME_STEP = 0.05;

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
  imports: [TuiIcon],
  templateUrl: './video-player.component.html',
  styleUrl: './video-player.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VideoPlayerComponent {
  private readonly resolver = inject(ResolverService);

  /** URL плеера Kodik: из него резолвится манифест. */
  readonly iframeUrl = input.required<string>();
  readonly skips = input<VideoSkips>({});
  readonly isLastEpisode = input(false);
  readonly poster = input('');

  /**
   * Откуда начать. Читается один раз на серию и намеренно не отслеживается
   * эффектом: иначе сохранение позиции перезапускало бы воспроизведение.
   */
  readonly startPositionSecs = input(0);

  readonly progress = output<PlaybackProgress>();
  readonly ended = output<PlaybackProgress>();
  readonly nextEpisode = output<void>();
  readonly playbackPaused = output<PlaybackProgress>();

  readonly status = signal<PlayerStatus>('resolving');
  readonly errorText = signal('');

  readonly requestedQuality = signal<number>(DEFAULT_QUALITY);
  readonly actualQuality = signal<number | null>(null);
  readonly qualities = QUALITIES;

  readonly position = signal(0);
  readonly duration = signal(0);
  readonly bufferedTo = signal(0);
  readonly paused = signal(true);
  readonly volume = signal(1);
  readonly muted = signal(false);
  readonly isFullscreen = signal(false);
  readonly skipHint = signal<SkipHint | null>(null);

  /** Панель прячется только во время игры: на паузе она нужна всегда. */
  readonly controlsVisible = signal(true);

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

  constructor() {
    effect(() => {
      const url = this.iframeUrl();

      untracked(() => {
        this.skipController = new SkipController(
          this.skips(),
          this.isLastEpisode()
        );
        void this.load(
          url,
          this.requestedQuality(),
          this.startPositionSecs()
        );
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
      this.hideTimer !== null && clearTimeout(this.hideTimer);
      this.teardown();
    });
  }

  // ——— загрузка ———

  private async load(
    iframeUrl: string,
    quality: number,
    positionSecs: number
  ): Promise<void> {
    const token = ++this.generation;

    this.status.set('resolving');
    this.errorText.set('');
    this.skipHint.set(null);

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

  private attach(
    manifestUrl: string,
    positionSecs: number,
    iframeUrl: string
  ): void {
    const video = this.videoRef()?.nativeElement;
    if (!video) {
      return;
    }

    // До destroy старый поток ещё хранит честную позицию. Событие pause после
    // уничтожения MediaSource уже может принести 0/0.
    this.emitPausedProgress();
    this.playbackReady = false;
    this.destroyHls();

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
    if (video) {
      this.volume.set(video.volume);
      this.muted.set(video.muted);
    }
  }

  onEnded(): void {
    this.paused.set(true);
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

  onPause(): void {
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
      this.position()
    );
  }

  /** Опенинг перематывается внутри серии, конец — уводит на следующую. */
  applySkip(hint: SkipHint): void {
    if (hint.kind === 'opening') {
      this.seekTo(this.skipController.skipTargetSecs(hint.segment));
      return;
    }

    this.nextEpisode.emit();
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
    const handled = this.handleKey(event.key);

    if (handled) {
      // Иначе пробел прокрутит страницу, а стрелки уедут по полосе серий.
      event.preventDefault();
      event.stopPropagation();
    }
  }

  private handleKey(key: string): boolean {
    switch (key) {
      case ' ':
      case 'k':
      case 'K':
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
      case 'f':
      case 'F':
        void this.toggleFullscreen();
        return true;
      case 'm':
      case 'M':
        this.toggleMuted();
        return true;
      case 'Escape':
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

  private scrub(event: PointerEvent, bar: HTMLElement): void {
    const duration = this.duration();
    if (duration <= 0) {
      return;
    }

    const box = bar.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / box.width;
    this.seekTo(Math.min(Math.max(ratio, 0), 1) * duration);
  }
}
