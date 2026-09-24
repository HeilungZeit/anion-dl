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
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import Hls, { type ErrorData, type HlsConfig } from 'hls.js';

import type { VideoSkips } from '../api/anime.types';
import { ResolverService } from '../api/resolver.service';
import { currentWindowTarget } from '../windows/current-window';
import { AutoCloseMenuDirective } from './auto-close-menu.directive';
import { DEFAULT_QUALITY, QUALITIES, qualityOf } from './manifest-quality';
import {
  MediaSessionBridge,
  type NowPlaying,
  sameNowPlaying,
} from './media-session';
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
import { UpscaleFallback } from './upscale-fallback';

export interface PlaybackProgress {
  iframeUrl: string;
  positionSecs: number;
  durationSecs: number;
}

type PlayerStatus = 'resolving' | 'ready' | 'error';

/** Как часто тикает служебный опрос: позиция, подсказка пропуска, срок подписи. */
const TICK_MS = 500;

/**
 * Как часто прогресс уходит наружу во время игры.
 *
 * Каждое сохранение пересобирает всю историю просмотра, рассылает событие по
 * окнам и перерисовывает список серий. На каждом тике это давало заметные
 * подлагивания; точную позицию всё равно фиксируют пауза, конец серии и
 * закрытие плеера.
 */
const PROGRESS_EMIT_MS = 5000;
const IS_PLAYER_WINDOW = currentWindowTarget().kind === 'player';
/** Воспроизведение началось в каком-то из окон. */
const PLAYBACK_EVENT = 'player://started';

const SEEK_STEP_SECS = 10;

/** Сколько панель держится после последнего движения мыши. */
const CONTROLS_HIDE_MS = 2500;

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

/** Одна и та же подсказка пропуска — сигнал не должен дёргать шаблон. */
function sameSkipHint(a: SkipHint | null, b: SkipHint | null): boolean {
  return (
    a?.kind === b?.kind &&
    a?.segment.startSeconds === b?.segment.startSeconds &&
    a?.segment.stopSeconds === b?.segment.stopSeconds
  );
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

  /** Что показать в системной карточке «Сейчас играет»; null — ничего. */
  readonly nowPlaying = input<NowPlaying | null>(null);
  /** Родитель мог пересоздать тот же объект — карточку это трогать не должно. */
  private readonly mediaInfo = computed(() => this.nowPlaying(), {
    equal: sameNowPlaying,
  });

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

  /**
   * Маршрут этой серии для отдельного окна. `null` — кнопки «оторвать» нет:
   * так на странице, которая маршрут назвать не может, и во всяком окне,
   * которое само и есть окно плеера.
   */
  readonly detachRoute = input<string | null>(null);

  readonly detach = output<string>();
  readonly progress = output<PlaybackProgress>();
  readonly ended = output<PlaybackProgress>();
  readonly nextEpisode = output<void>();
  readonly playbackPaused = output<PlaybackProgress>();
  /**
   * Воспроизведение действительно пошло. Каждый `play`, а не только первый:
   * повторы отсекает получатель, а плееру незачем помнить, что уже сообщал.
   */
  readonly playbackStarted = output<string>();

  /** Своё окно плеер занимает целиком; на странице — как встанет. */
  readonly isPlayerWindow = IS_PLAYER_WINDOW;

  /** В самом окне плеера отрывать нечего: серия уже в отдельном окне. */
  readonly canDetach = computed(
    () => this.detachRoute() !== null && !IS_PLAYER_WINDOW
  );

  readonly status = signal<PlayerStatus>('resolving');
  readonly errorText = signal('');

  readonly requestedQuality = signal<number>(DEFAULT_QUALITY);
  readonly actualQuality = signal<number | null>(null);
  readonly qualities = QUALITIES;
  /** Отмечен в меню пункт, который реально играет, а не тот, что просили. */
  readonly shownQuality = computed(
    () => this.actualQuality() ?? this.requestedQuality()
  );
  /**
   * Просили лучше, чем есть у серии. Без пометки выбор 720p на серии без
   * 720p выглядел так, будто клик просто не сработал.
   */
  readonly qualityNote = computed(() => {
    const requested = this.requestedQuality();
    const actual = this.actualQuality();

    // Пока идёт смена, запрошенное уже новое, а играет ещё старое. Без этой
    // проверки переход 360 → 720 на секунду объявлял, что 720p нет, и тут
    // же его включал.
    if (this.switchingQuality()) {
      return '';
    }

    return actual !== null && actual < requested
      ? `${requested}p у этой серии нет — играет ${actual}p.`
      : '';
  });
  /** Идёт смена качества: Rust проверяет манифесты, поток ещё старый. */
  readonly switchingQuality = signal(false);

  readonly position = signal(0);
  readonly duration = signal(0);
  readonly bufferedTo = signal(0);
  readonly paused = signal(true);
  /** Воспроизведение встало в ожидании данных: `waiting` без `playing`. */
  readonly buffering = signal(false);
  readonly volume = signal(1);
  readonly muted = signal(false);
  readonly isFullscreen = signal(false);
  readonly skipHint = signal<SkipHint | null>(null, { equal: sameSkipHint });

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

  /**
   * Куда тянут ползунок; null — не тянут. Поток перематывается только по
   * отпускании: seek на каждый сдвиг мыши заставлял hls.js бросать и заново
   * качать сегменты, и перемотка шла рывками.
   */
  readonly scrubSecs = signal<number | null>(null);
  readonly shownPosition = computed(() => this.scrubSecs() ?? this.position());

  /** Апскейл: режим, доступность и возможная ошибка запуска. */
  readonly upscaleMode = signal<UpscaleMode>('off');
  readonly upscaleModes = UPSCALE_MODES;
  readonly upscaleLabels = UPSCALE_LABELS;
  readonly upscaleSupported = isWebGpuAvailable();
  readonly upscaleError = signal('');
  readonly upscaleStats = signal<UpscaleStats | null>(null);

  /**
   * Почему режим сменился сам. Без этого откат неотличим от «само так вышло»:
   * человек выбрал одно, видит другое и не понимает, почему.
   */
  readonly upscaleNote = signal('');

  /** Следит, тянет ли железо выбранный режим. Подробности — в модуле. */
  private readonly fallback = new UpscaleFallback();

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
  private readonly windowLabel = getCurrentWindow().label;
  private playbackReady = false;
  /** Снятие слушателя отложенной перемотки на стартовую позицию. */
  private pendingSeek: (() => void) | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private skipController = new SkipController({});
  private readonly latch = new ReResolveOnForbidden();
  private readonly mediaSession = new MediaSessionBridge();
  /**
   * Сохранённое качество. Первый резолв его дожидается: резолв и так идёт
   * секунду-полторы, а чтение файла настроек — миллисекунды.
   */
  private readonly qualityRestored = this.settings
    .getQuality()
    .then((quality) => {
      if (quality !== null) {
        this.requestedQuality.set(quality);
      }
    })
    .catch(() => undefined);

  /** Отсекает ответы резолвера по сериям, которые уже закрыли. */
  private generation = 0;
  private refreshing = false;
  private expectResume = false;
  /**
   * Конец серии уже обработан. Он приходит двумя путями — событием `ended`
   * и от hls.js, — и второй не должен перезапускать отсчёт.
   */
  private endHandled = false;
  private scrubbing = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  /** Последнее движение мыши: таймер скрытия сверяется с ним, а не перезаводится. */
  private lastActivityAt = 0;
  private lastProgressAt = 0;
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
    // Движение мыши слушается мимо шаблона: обработчик из шаблона в zoneless
    // запускал бы проверку изменений плеера на каждый пиксель пути курсора.
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const onPointerMove = (): void => this.pokeControls();
    host.addEventListener('pointermove', onPointerMove, { passive: true });

    this.mediaSession.bind({
      play: () => {
        if (this.videoRef()?.nativeElement.paused) {
          this.togglePlay();
        }
      },
      pause: () => this.videoRef()?.nativeElement.pause(),
      seekBy: (delta) => this.seekBy(delta),
      seekTo: (secs) => this.seekTo(secs),
    });

    effect(() => {
      this.mediaSession.setMetadata(this.mediaInfo(), this.poster());
    });

    effect(() => {
      this.mediaSession.setNext(
        this.isLastEpisode() ? null : () => untracked(() => this.goNext())
      );
    });

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

    // Смена качества или переролв апскейл не перезапускают: конвейер сам
    // пересобирается, увидев кадр другого размера (см. `draw` в upscale.ts).
    effect(() => {
      const mode = this.upscaleMode();
      const ready = this.status() === 'ready';

      untracked(() => void this.applyUpscale(mode, ready));
    });

    // Новая серия — прошлые решения автоматики к ней отношения не имеют:
    // качество могло смениться, и то, что не тянуло на 720p, тянет на 480p.
    effect(() => {
      this.iframeUrl();
      untracked(() => {
        this.fallback.reset();
        this.upscaleNote.set('');
      });
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
        void this.load(url, startSecs, localPath);
      });
    });

    // Окно могут вывести из полноэкранного режима мимо нас — зелёной кнопкой
    // или системным жестом. Без подписки на его размер наша разметка осталась
    // бы растянутой поверх обычного окна.
    const window = getCurrentWindow();
    let unlisten: (() => void) | null = null;
    let unlistenPlayback: (() => void) | null = null;

    void listen<{ source: string }>(PLAYBACK_EVENT, ({ payload }) => {
      if (payload.source === this.windowLabel) {
        return;
      }

      this.videoRef()?.nativeElement.pause();
    })
      .then((stop) => {
        unlistenPlayback = stop;
      })
      .catch(() => undefined);

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
      unlistenPlayback?.();
      host.removeEventListener('pointermove', onPointerMove);
      if (this.hideTimer !== null) {
        clearTimeout(this.hideTimer);
      }

      if (this.volumeTimer !== null) {
        clearTimeout(this.volumeTimer);
      }

      this.cancelAutoNext();
      this.stopFrameCycle();
      this.stopUpscale();
      this.teardown();
      this.mediaSession.clear();
    });
  }

  // ——— загрузка ———

  private async load(
    iframeUrl: string,
    positionSecs: number,
    localPath: string | null = null
  ): Promise<void> {
    const token = ++this.generation;

    this.status.set('resolving');
    this.errorText.set('');
    this.skipHint.set(null);
    this.switchingQuality.set(false);

    if (localPath) {
      await this.loadLocal(token, localPath, positionSecs, iframeUrl);
      return;
    }

    try {
      await this.qualityRestored;
      const manifest = await this.resolver.resolveManifest(
        iframeUrl,
        this.requestedQuality()
      );

      if (token !== this.generation) {
        return;
      }

      this.attach(manifest, positionSecs, iframeUrl, this.hasStarted());
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
          this.onReady(video, positionSecs, this.hasStarted());
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
    this.cancelPendingSeek();
    this.playbackReady = false;
    this.buffering.set(false);
    this.destroyHls();
  }

  /**
   * @param resume запускать ли воспроизведение, когда поток готов. Смена
   * качества и переролв сохраняют то, что было: поставленная на паузу серия
   * не должна заиграть сама.
   */
  private attach(
    manifestUrl: string,
    positionSecs: number,
    iframeUrl: string,
    resume: boolean
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
      const hls = new Hls(this.hlsConfig(positionSecs));
      this.hls = hls;

      hls.on(Hls.Events.ERROR, (_event, data) => this.onHlsError(data));
      hls.on(Hls.Events.MANIFEST_PARSED, () =>
        this.onReady(video, positionSecs, resume)
      );
      // WKWebView может застрять в долях секунды от конца потока и не прислать
      // `ended`: без этого не было ни отсчёта до следующей серии, ни отметки
      // досмотра, а серия начиналась заново. hls.js такой застой распознаёт
      // сам. Паузу ставим явно, чтобы вебвью не продолжил играть с начала.
      hls.on(Hls.Events.MEDIA_ENDED, (_event, data) => {
        if (data.stalled && !this.endHandled) {
          video.pause();
          this.onEnded();
        }
      });

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
        () => this.onReady(video, positionSecs, resume),
        { once: true }
      );
      this.startTicker();
      return;
    }

    this.fail(
      'Этот вебвью не умеет ни MediaSource, ни HLS — воспроизведение недоступно.'
    );
  }

  private hlsConfig(startPositionSecs: number): Partial<HlsConfig> {
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
      // Продолжение с сохранённой секунды задаётся именно здесь. Выставлять
      // currentTime по MANIFEST_PARSED поздно и бесполезно: длительности ещё
      // нет, а hls.js всё равно начнёт загрузку со своей startPosition.
      startPosition: startPositionSecs > 0 ? startPositionSecs : -1,
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

  private onReady(
    video: HTMLVideoElement,
    positionSecs: number,
    resume: boolean
  ): void {
    this.status.set('ready');
    this.switchingQuality.set(false);
    this.duration.set(Number.isFinite(video.duration) ? video.duration : 0);

    if (positionSecs > 0) {
      this.applyStartPosition(video, positionSecs);
    }

    this.playbackReady = true;

    // Открытие страницы тайтла просмотр не начинает: человек пришёл почитать
    // описание или выбрать серию, а не слушать опенинг. Смена серии — уже
    // осознанное продолжение просмотра, а смена качества и переролв сохраняют
    // то состояние, в котором их застали.
    if (resume) {
      void video.play().catch(() => undefined);
    }
  }

  /**
   * MANIFEST_PARSED приходит раньше, чем MediaSource узнаёт длительность, и
   * присвоение currentTime в этот момент молча пропадало — серия начиналась
   * с нуля. Перемотка откладывается до метаданных, если их ещё нет.
   */
  private applyStartPosition(
    video: HTMLVideoElement,
    positionSecs: number
  ): void {
    this.cancelPendingSeek();

    const seek = (): void => {
      this.pendingSeek = null;

      const duration = video.duration;
      const target =
        Number.isFinite(duration) && duration > 0
          ? Math.min(positionSecs, Math.max(duration - 1, 0))
          : positionSecs;

      // hls.js обычно уже стоит на нужной секунде благодаря startPosition.
      // Повторный seek на то же место заставлял его заново качать сегмент.
      if (Math.abs(video.currentTime - target) > 0.5) {
        video.currentTime = target;
      }
      this.position.set(video.currentTime);
    };

    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      seek();
      return;
    }

    video.addEventListener('loadedmetadata', seek, { once: true });
    this.pendingSeek = () =>
      video.removeEventListener('loadedmetadata', seek);
  }

  /** Отложенная перемотка старого потока не должна догнать новый. */
  private cancelPendingSeek(): void {
    this.pendingSeek?.();
    this.pendingSeek = null;
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
    // Своё поколение: смена качества или серии посреди переролва делает его
    // ответ ненужным, и без проверки поток подключился бы дважды.
    const token = ++this.generation;

    try {
      const video = this.videoRef()?.nativeElement;
      const position =
        video && video.currentTime > 0
          ? video.currentTime
          : this.latch.savedPositionSecs;
      // 403 останавливает загрузку, но не ставит видео на паузу, так что
      // играющая серия продолжит играть, а стоявшая на паузе — стоять.
      const resume = video ? !video.paused : this.hasStarted();

      const manifest = await this.resolver.resolveManifest(
        this.iframeUrl(),
        this.requestedQuality()
      );

      if (token !== this.generation) {
        return;
      }

      this.expectResume = true;
      this.attach(manifest, position, this.iframeUrl(), resume);
    } catch (error: unknown) {
      if (token === this.generation) {
        this.fail(
          error instanceof Error ? error.message : 'Не удалось обновить поток'
        );
      }
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

      const now = performance.now();
      if (!video.paused && now - this.lastProgressAt >= PROGRESS_EMIT_MS) {
        this.lastProgressAt = now;
        this.progress.emit({
          iframeUrl: this.playbackIframeUrl,
          positionSecs: position,
          durationSecs: duration,
        });
      }

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
    this.cancelPendingSeek();
    this.destroyHls();
  }

  // ——— события элемента ———

  onMetadata(): void {
    const video = this.videoRef()?.nativeElement;
    if (video) {
      this.duration.set(Number.isFinite(video.duration) ? video.duration : 0);
      this.mediaSession.setPosition(video);
    }
  }

  /** Перемотка, смена скорости — системной карточке нужна новая точка отсчёта. */
  syncMediaPosition(): void {
    const video = this.videoRef()?.nativeElement;
    if (video) {
      this.mediaSession.setPosition(video);
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
    if (this.endHandled) {
      return;
    }

    this.endHandled = true;
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
    // Повторный запуск после конца — новый просмотр, у которого будет свой конец.
    this.endHandled = false;
    this.paused.set(false);
    this.mediaSession.setPlaying(true);
    this.syncMediaPosition();
    this.playedOnce.set(true);
    this.resumeOffer.set(null);
    this.pokeControls();

    // Серия может играть в нескольких окнах сразу — две звуковые дорожки в
    // уши никому не нужны. Чужие плееры замолкают, а не закрываются: зритель
    // вернётся к ним с той же секунды.
    void emit(PLAYBACK_EVENT, { source: this.windowLabel }).catch(
      () => undefined
    );

    if (this.playbackIframeUrl) {
      this.playbackStarted.emit(this.playbackIframeUrl);
    }
  }

  onPause(): void {
    this.buffering.set(false);
    this.paused.set(true);
    this.mediaSession.setPlaying(false);
    this.syncMediaPosition();
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

  /**
   * Клик по кадру переключает воспроизведение сразу, без ожидания второго
   * клика: прежняя пауза в 220 мс ощущалась как задержка на каждое нажатие.
   * Второй клик двойного (`detail > 1`) пропускается — им займётся dblclick.
   */
  onVideoClick(event: MouseEvent): void {
    if (event.detail > 1) {
      return;
    }

    this.togglePlay();
  }

  /** Первый клик уже переключил воспроизведение — возвращаем как было. */
  onVideoDoubleClick(): void {
    this.togglePlay();
    void this.toggleFullscreen();
  }

  /** Серия уезжает в своё окно; здесь воспроизведение останавливается. */
  detachToWindow(): void {
    const route = this.detachRoute();
    if (!route) {
      return;
    }

    this.videoRef()?.nativeElement.pause();
    this.detach.emit(route);
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

    // Выбор руками старше автоматики: дальше она в эту серию не вмешивается.
    this.fallback.release();
    this.upscaleNote.set('');

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
    this.fallback.watch(mode);

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
          if (token !== this.upscaleToken) {
            return;
          }

          this.upscaleStats.set(stats);

          const decision = this.fallback.observe(stats, performance.now());
          if (decision) {
            // Настройку не переписываем: выбор человека остаётся прежним, а
            // на другой серии или другом качестве режим может и потянуть.
            this.upscaleNote.set(decision.reason);
            this.upscaleMode.set(decision.to);
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
    this.lastActivityAt = performance.now();
    this.controlsVisible.set(true);

    if (this.hideTimer === null) {
      this.scheduleHide(CONTROLS_HIDE_MS);
    }
  }

  /** Курсор ушёл с плеера — прятать сразу, но только если идёт воспроизведение. */
  hideControlsSoon(): void {
    if (!this.paused()) {
      this.controlsVisible.set(false);
    }
  }

  /**
   * Таймер не перезаводится на каждое движение мыши: срабатывая, он сам
   * проверяет, сколько прошло с последнего, и при нужде откладывается.
   */
  private scheduleHide(delayMs: number): void {
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;

      const idleMs = performance.now() - this.lastActivityAt;
      if (idleMs < CONTROLS_HIDE_MS) {
        this.scheduleHide(CONTROLS_HIDE_MS - idleMs);
        return;
      }

      if (!this.paused() && !this.scrubbing) {
        this.controlsVisible.set(false);
      }
    }, delayMs);
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

  /**
   * Сравнивается с тем, что играет, а не с тем, что просили: иначе после
   * отката 720 → 480 повторный выбор 720p ничего не делал, а выбор 480p
   * перезагружал тот же самый поток.
   */
  changeQuality(quality: number): void {
    const same =
      quality === this.shownQuality() && quality === this.requestedQuality();
    if (same || this.switchingQuality()) {
      return;
    }

    this.requestedQuality.set(quality);
    void this.settings.setQuality(quality).catch(() => undefined);
    void this.switchQuality(quality);
  }

  /** Смена качества использует текущую подпись и не повторяет полный резолв. */
  private async switchQuality(quality: number): Promise<void> {
    if (!this.manifestUrl) {
      return;
    }

    const token = ++this.generation;
    const iframeUrl = this.playbackIframeUrl || this.iframeUrl();
    this.switchingQuality.set(true);

    try {
      const manifest = await this.resolver.changeManifestQuality(
        this.manifestUrl,
        quality
      );

      if (token !== this.generation) {
        return;
      }

      // Нужного качества нет, Rust вернул тот же поток — перезапускать нечего,
      // о недоступности скажет пометка в меню.
      if (manifest === this.manifestUrl) {
        this.switchingQuality.set(false);
        return;
      }

      // Позиция и пауза берутся после резолва: пока Rust проверял манифесты,
      // серия продолжала играть.
      const video = this.videoRef()?.nativeElement;
      const positionSecs = video?.currentTime ?? this.position();
      const resume = video ? !video.paused : false;

      this.expectResume = true;
      this.attach(manifest, positionSecs, iframeUrl, resume);
    } catch (error: unknown) {
      if (token === this.generation) {
        this.switchingQuality.set(false);
        this.fail(
          error instanceof Error ? error.message : 'Не удалось сменить качество'
        );
      }
    }
  }

  retry(): void {
    void this.load(this.iframeUrl(), this.position(), this.localPath());
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
    if (!this.scrubbing) {
      return;
    }

    this.scrubbing = false;
    bar.releasePointerCapture(event.pointerId);

    const target = this.scrubSecs();
    this.scrubSecs.set(null);
    if (target !== null) {
      this.seekTo(target);
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

  /**
   * Файл с диска перематывается вживую — это дёшево, и кадр идёт за
   * ползунком. Поток по сети — только по отпускании, см. `scrubSecs`.
   */
  private scrub(event: PointerEvent, bar: HTMLElement): void {
    const duration = this.duration();
    if (duration <= 0) {
      return;
    }

    const secs = this.ratioAt(event, bar) * duration;
    this.scrubSecs.set(secs);

    if (this.isLocal()) {
      this.seekTo(secs);
    }
  }
}
