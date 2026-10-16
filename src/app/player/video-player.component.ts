import {
  afterNextRender,
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import { DOCUMENT } from '@angular/common';
import { TuiIcon } from '@taiga-ui/core';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import Hls, { type ErrorData, type HlsConfig } from 'hls.js';

import type { VideoSkips } from '../api/anime.types';
import { ResolverService } from '../api/resolver.service';
import { currentWindowTarget } from '../windows/current-window';
import { AutoCloseMenuDirective } from './auto-close-menu.directive';
import { qualitiesFor } from '../api/video-source';
import { DEFAULT_QUALITY, qualityOf } from './manifest-quality';
import {
  MediaSessionBridge,
  type NowPlaying,
  sameNowPlaying,
} from './media-session';
import type { NativePlaybackOption } from './native-playback-option';
import { PlaybackPickerComponent } from './playback-picker.component';
import { PlayerSettingsService } from './player-settings.service';
import { ReResolveOnForbidden } from './re-resolve';
import { expiryEpochMs, shouldRefreshAhead } from './signature-clock';
import {
  DEFAULT_WINDOW_SECONDS,
  SkipController,
  type SkipHint,
} from './skip-controller';
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
import { ScreenWakeLock } from './wake-lock';
import type { PlayerMeasurement } from '../telemetry/player-measurement';
import { gpuClass, screenClass, upscalePerf } from '../telemetry/hardware';
import { TelemetryService } from '../telemetry/telemetry.service';
import type {
  PlayerTelemetryContext,
  PlayerTelemetryTarget,
} from '../telemetry/telemetry.types';

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
const PROGRESS_EMIT_MS = 10_000;
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

/** Замер скорости улучшения: окна статистики по секунде — разгон и сам замер. */
const UPSCALE_PERF_WARMUP = 3;
const UPSCALE_PERF_WINDOWS = 10;

/** Сколько держится подсказка «+10 с» после перемотки стрелками. */
const SEEK_BADGE_SHOW_MS = 700;

/** Сколько держится плашка громкости после ↑/↓/M. */
const VOLUME_HUD_SHOW_MS = 900;

/** Сколько держится плашка «Серия 5 · AniLibria» после смены серии. */
const EPISODE_TOAST_SHOW_MS = 2500;

/** Сколько секунд даётся, чтобы отменить автопропуск опенинга. */
export const AUTO_SKIP_SECS = 3;

/**
 * Какая доля плеера должна уйти с экрана, чтобы он свернулся в мини-плеер.
 * Не весь: пока виден краешек, смотреть уже неудобно.
 */
const MINI_VISIBLE_RATIO = 0.3;

/** Уход из кинотеатра — столько длится его анимация (--anion-duration-base). */
const THEATER_LEAVE_MS = 180;

/** Вспышка ▶ по центру — столько длится её анимация. */
const PLAY_FLASH_MS = 600;

/**
 * За сколько до конца серии заранее резолвить следующую: к автопереходу
 * ссылка уже есть, и «Ищу поток…» не показывается.
 */
const PREFETCH_LEAD_SECS = 3 * 60;

/**
 * Окно, в котором повторная ошибка декодера считается той же самой. Внутри
 * окна восстановление идёт по нарастающей, за ним — начинается заново.
 */
const MEDIA_RECOVERY_WINDOW_MS = 10_000;

/**
 * Пауза перед новой попыткой заблаговременного обновления подписи, если
 * резолвер не ответил. До истечения ещё минуты, поток играет — ронять его
 * незачем.
 */
const REFRESH_AHEAD_RETRY_MS = 30_000;

const RESOLVE_FAILED_TEXT = 'Не удалось получить поток серии. Попробуйте ещё раз.';
const NETWORK_FAILED_TEXT =
  'Не удалось загрузить видео. Проверьте соединение и попробуйте ещё раз.';
const MEDIA_FAILED_TEXT = 'Не удалось воспроизвести видео. Попробуйте ещё раз.';

/**
 * Горячие клавиши — и для обработчика, и для справки по «?». Буквы сверяются
 * по `event.code`, то есть по физической клавише: с русской раскладкой
 * `event.key` вместо «k» приносит «л», и управление молча переставало работать.
 */
export const HOTKEYS: readonly { keys: string; action: string }[] = [
  { keys: 'Пробел / K', action: 'Пауза и воспроизведение' },
  { keys: '← / →', action: 'Назад / вперёд на 10 секунд' },
  { keys: 'Home / End', action: 'В начало / в конец серии' },
  { keys: '↑ / ↓', action: 'Громкость' },
  { keys: 'M', action: 'Выключить звук' },
  { keys: 'F', action: 'Полный экран' },
  { keys: 'T', action: 'Режим кинотеатра' },
  { keys: 'P', action: 'Картинка в картинке' },
  { keys: 'N', action: 'Следующая серия' },
  { keys: '?', action: 'Эта справка' },
  { keys: 'Esc', action: 'Закрыть справку, выйти из полного экрана или кинотеатра' },
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

/** Подсказка перемотки у края: куда и на сколько секунд накопилось. */
export interface SeekBadge {
  side: -1 | 1;
  secs: number;
}

/** Отрезок опенинга или эндинга на полосе перемотки, в процентах длины. */
export interface SeekMark {
  kind: 'opening' | 'ending';
  start: number;
  width: number;
}

/**
 * Отметки опенинга и эндинга. У опенинга известно только начало — конец
 * достраивается тем же окном, что и у кнопки пропуска. Эндинг идёт до конца
 * серии.
 */
export function seekMarks(skips: VideoSkips, duration: number): SeekMark[] {
  if (duration <= 0) {
    return [];
  }

  const marks: SeekMark[] = [];
  const percent = (secs: number): number => (secs / duration) * 100;

  if (skips.opening !== undefined && skips.opening < duration) {
    const end = Math.min(skips.opening + DEFAULT_WINDOW_SECONDS, duration);
    marks.push({
      kind: 'opening',
      start: percent(skips.opening),
      width: percent(end - skips.opening),
    });
  }

  if (skips.ending !== undefined && skips.ending < duration) {
    marks.push({
      kind: 'ending',
      start: percent(skips.ending),
      width: percent(duration - skips.ending),
    });
  }

  return marks;
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
  imports: [
    TuiIcon,
    AutoCloseMenuDirective,
    CdkTrapFocus,
    PlaybackPickerComponent,
  ],
  templateUrl: './video-player.component.html',
  styleUrl: './video-player.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.detached]': 'theater() || mini()',
  },
})
export class VideoPlayerComponent {
  private readonly resolver = inject(ResolverService);
  private readonly settings = inject(PlayerSettingsService);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly telemetry = inject(TelemetryService);
  private measurement: PlayerMeasurement | null = null;
  private readonly telemetryContext = signal<PlayerTelemetryContext | null>(null);
  /** Сеанс, о выборе которого уже сообщили. */
  private telemetrySelected = '';
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  /** URL плеера Kodik: из него резолвится манифест. */
  readonly iframeUrl = input.required<string>();
  readonly skips = input<VideoSkips>({});
  readonly isFirstEpisode = input(false);
  readonly isLastEpisode = input(false);
  /** Подписи соседних серий для подсказок ⏮/⏭, например «серия 5». */
  readonly previousEpisodeLabel = input('');
  readonly nextEpisodeLabel = input('');
  /**
   * Локатор следующей серии — для заранее готовой ссылки к автопереходу.
   * null — следующей нет или она скачана и сыграет с диска.
   */
  readonly nextIframeUrl = input<string | null>(null);
  readonly poster = input('');

  /** Что показать в системной карточке «Сейчас играет»; null — ничего. */
  readonly nowPlaying = input<NowPlaying | null>(null);
  /**
   * Серии и озвучки для выбора прямо в плеере — в полном экране и
   * кинотеатре. Пусто — кнопки выбора нет.
   */
  readonly nativeOptions = input<readonly NativePlaybackOption[]>([]);
  /** Выбрана серия в плеере: родитель переключает на неё свой выбор. */
  readonly nativeSelection = output<string>();
  /** Тайтл и серия для статистики плееров; null — серию не считаем. */
  readonly telemetryTarget = input<PlayerTelemetryTarget | null>(null);
  /** Родитель мог пересоздать тот же объект — новый сеанс от этого не нужен. */
  private readonly telemetryKey = computed(() => this.telemetryTarget(), {
    equal: (a, b) =>
      a?.animeId === b?.animeId &&
      a?.episode === b?.episode &&
      a?.player === b?.player,
  });
  readonly pickerOpen = signal(false);
  readonly selectionPending = signal<string | null>(null);
  readonly selectionError = signal('');
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
  readonly previousEpisode = output<void>();
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
  /** Ошибка из-за пропавшей сети: плеер сам продолжит, когда она вернётся. */
  readonly offline = signal(false);

  readonly requestedQuality = signal<number>(DEFAULT_QUALITY);
  readonly actualQuality = signal<number | null>(null);
  /** У каждого источника свой потолок: 1080p бывает только у CDNVideoHub. */
  readonly qualities = computed(() => qualitiesFor(this.iframeUrl()));
  /**
   * Запрошенное, но не выше потолка источника. Качество просмотра общее:
   * выбранные на CDNVideoHub 1080p на Kodik означают «лучшее, что есть», а
   * не повод писать, что 1080p у серии нет.
   */
  readonly effectiveQuality = computed(() =>
    Math.min(this.requestedQuality(), this.qualities()[0])
  );
  /** Отмечен в меню пункт, который реально играет, а не тот, что просили. */
  readonly shownQuality = computed(
    () => this.actualQuality() ?? this.effectiveQuality()
  );
  /**
   * Просили лучше, чем есть у серии. Без пометки выбор 720p на серии без
   * 720p выглядел так, будто клик просто не сработал.
   */
  readonly qualityNote = computed(() => {
    const requested = this.effectiveQuality();
    const actual = this.actualQuality();

    // Пока идёт смена, запрошенное уже новое, а играет ещё старое. Без этой
    // проверки переход 360 → 720 на секунду объявлял, что 720p нет, и тут
    // же его включал.
    if (this.switchingQuality()) {
      return '';
    }
    if (this.qualityFailed()) {
      return 'Не удалось сменить качество. Попробуйте ещё раз.';
    }

    return actual !== null && actual < requested
      ? `${requested}p у этой серии нет — играет ${actual}p.`
      : '';
  });
  /** Идёт смена качества: Rust проверяет манифесты, поток ещё старый. */
  readonly switchingQuality = signal(false);
  /** Резолвер не отдал манифест нового качества — играет прежнее. */
  readonly qualityFailed = signal(false);

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
  /** Отсчёт до автопропуска опенинга; null — отсчёта нет. */
  readonly autoSkipSecs = signal<number | null>(null);
  readonly autoSkipOpening = signal(false);

  /**
   * Кинотеатр: плеер поверх затемнённой страницы во всё окно, но без
   * полноэкранного режима окна. Колонку страницы плеер покинуть не может,
   * поэтому не растягивается в ней, а выходит поверх. В своём окне плеер
   * и так занимает всё — там кинотеатра нет.
   */
  readonly theater = signal(false);
  /** Кинотеатр закрывается: плеер ещё поверх страницы, но уже гаснет. */
  readonly theaterLeaving = signal(false);

  /** Плеер ушёл с экрана во время игры и смотрится в углу. */
  readonly mini = signal(false);

  /** Для кольца на кнопке «Смотреть»: оно сходится ровно за весь отсчёт. */
  readonly autoNextTotalSecs = AUTO_NEXT_SECS;

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
  /**
   * Первый кадр серии уже на экране. Заставка уходит по нему, а не по `play`:
   * между нажатием и первым кадром проходит буферизация, и заставка сменялась
   * чёрным прямоугольником.
   */
  readonly framePainted = signal(false);
  readonly showFrames = computed(
    () => !this.framePainted() && this.visibleFrames().length > 0
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

  /** Подсказка перемотки стрелками; null — не показывается. */
  readonly seekBadge = signal<SeekBadge | null>(null);

  /** Плашка громкости после клавиш; null — не показывается. */
  readonly volumeHud = signal<number | null>(null);

  /**
   * Вспышка ▶ по центру при запуске. Массив из одного id, а не флаг: новый id
   * пересоздаёт элемент, и анимация играет заново при каждом нажатии.
   */
  readonly playFlash = signal<readonly number[]>([]);

  /**
   * Плашка с новой серией и озвучкой после переключения; тот же приём с id,
   * что у вспышки: быстрые ⏭ подряд показывают плашку заново.
   */
  readonly episodeToast = signal<readonly number[]>([]);

  readonly seekMarks = computed(() => seekMarks(this.skips(), this.duration()));

  /** Подпись отрезка под курсором для подсказки времени. */
  readonly hoverMark = computed(() => {
    const percent = this.hoverPercent();
    if (this.hoverSecs() === null) {
      return '';
    }

    const mark = this.seekMarks().find(
      (item) => percent >= item.start && percent < item.start + item.width
    );
    return mark ? (mark.kind === 'opening' ? 'Опенинг' : 'Эндинг') : '';
  });

  /** Для скринридера — целые секунды и время словами, а не «1234.5678». */
  readonly seekValueNow = computed(() => Math.floor(this.shownPosition()));
  readonly seekValueMax = computed(() => Math.floor(this.duration()));
  readonly seekValueText = computed(
    () => `${formatTime(this.shownPosition())} из ${formatTime(this.duration())}`
  );

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
   * Улучшение готовится: грузится пресет, компилируются шейдеры. Канва в это
   * время скрыта (кадра на ней ещё нет), видно обычное видео и плашку.
   */
  readonly upscalePreparing = signal(false);

  /**
   * Нажимал ли человек «play» хоть раз.
   *
   * От этого зависит, продолжать ли просмотр после восстановления сети или
   * повтора загрузки. Автозапуск новой серии решает `playNextOnLoad`.
   */
  readonly hasStarted = signal(false);

  readonly formatTime = formatTime;

  private readonly videoRef =
    viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly canvasRef =
    viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly playerRef = viewChild<ElementRef<HTMLElement>>('player');
  private readonly pickerTrigger =
    viewChild<ElementRef<HTMLButtonElement>>('pickerTrigger');
  private selectionToken = 0;
  private restorePickerFocus = false;
  /**
   * Поток серии, выбранной в плеере, — уже готовый. Родитель сменит
   * `iframeUrl`, и эффект смены серии подключит его без второго резолва.
   * `manifest` null — серия скачана и сыграет с диска.
   */
  private preparedSelection: {
    iframeUrl: string;
    manifest: string | null;
    positionSecs: number;
    resume: boolean;
  } | null = null;

  private hls: Hls | null = null;
  private manifestUrl = '';
  private playbackIframeUrl = '';
  private readonly windowLabel = getCurrentWindow().label;
  private playbackReady = false;
  /** Снятие слушателя отложенной перемотки на стартовую позицию. */
  private pendingSeek: (() => void) | null = null;
  /** Снятие слушателя готовности нативного HLS или файла с диска. */
  private pendingReady: (() => void) | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private skipController = new SkipController({});
  private latch = new ReResolveOnForbidden();
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
  /** Поколение, для которого идёт переролв; null — не идёт. */
  private refreshGeneration: number | null = null;
  private get refreshing(): boolean {
    return this.refreshGeneration === this.generation;
  }
  /** Когда снова можно пробовать заблаговременное обновление (Date.now). */
  private refreshAheadAfter = 0;
  /** Во время обновления подписи пришёл 403 — сам он уже никого не разбудит. */
  private forbiddenDuringRefresh = false;
  /**
   * Тихий переролв после сетевой ошибки уже потрачен. Возвращается первым
   * загруженным сегментом: значит, поток снова живой.
   */
  private networkRetryUsed = false;

  /** Следующую серию запросил сам плеер — её поток стартует без нажатия. */
  private playNextOnLoad = false;
  /**
   * Ссылка, заблаговременное обновление которой не продлило подпись. Повторять
   * его на каждом тике бессмысленно: поток перезапускался бы дважды в секунду
   * и не успевал скачать ни сегмента. Дальше выручит переролв по 403.
   */
  private unrenewedManifest = '';
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
  private seekBadgeTimer: ReturnType<typeof setTimeout> | null = null;
  private volumeHudTimer: ReturnType<typeof setTimeout> | null = null;
  private playFlashTimer: ReturnType<typeof setTimeout> | null = null;
  private playFlashId = 0;
  private episodeToastTimer: ReturnType<typeof setTimeout> | null = null;
  /** Первая серия открывается со страницей — о ней плашка не нужна. */
  private episodeLoaded = false;
  private readonly wakeLock = new ScreenWakeLock();
  private autoSkipTimer: ReturnType<typeof setInterval> | null = null;
  private theaterTimer: ReturnType<typeof setTimeout> | null = null;
  /** Опенинг этой серии уже пропущен или его решили смотреть — больше не предлагать. */
  private openingAutoHandled = false;
  /** Место плеера на странице видно. */
  private hostVisible = true;
  /** Мини-плеер закрыли крестиком — до возврата к плееру он не появится. */
  private miniDismissed = false;
  /** Попытки подряд вытащить поток после ошибки декодера. */
  private mediaRecoveries = 0;
  private lastMediaRecoveryAt = 0;
  /** Снятие ожидания сети после офлайн-ошибки. */
  private stopWaitingForNetwork: (() => void) | null = null;
  /** Заранее запрошенная ссылка следующей серии. */
  private prefetched: {
    iframeUrl: string;
    quality: number;
    manifest: Promise<string>;
  } | null = null;
  /** Громкость применяется к элементу, только когда тот уже в DOM. */
  private readonly savedVolume = signal<{ volume: number; muted: boolean } | null>(
    null
  );

  constructor() {
    // Закрытый выбор серии возвращает фокус туда, откуда его открыли, — но
    // только когда новый поток уже подключён: во время «Ищу поток…» кнопки
    // выбора нет, и фокус ушёл бы в `body`.
    afterRenderEffect(() => {
      const open = this.pickerOpen();
      const ready = this.status() !== 'resolving';
      const trigger = this.pickerTrigger()?.nativeElement;
      if (this.restorePickerFocus && !open && ready) {
        this.restorePickerFocus = false;
        (trigger ?? this.playerRef()?.nativeElement)?.focus({
          preventScroll: true,
        });
      }
    });

    // Движение мыши слушается мимо шаблона: обработчик из шаблона в zoneless
    // запускал бы проверку изменений плеера на каждый пиксель пути курсора.
    const host = this.host;
    const onPointerMove = (): void => this.pokeControls();
    host.addEventListener('pointermove', onPointerMove, { passive: true });

    // Хост остаётся на месте плеера и держит его размер, когда тот уходит в
    // угол, — за ним и следим. В своём окне плеер с экрана не уходит.
    const visibility =
      typeof IntersectionObserver === 'function' && !IS_PLAYER_WINDOW
        ? new IntersectionObserver(
            ([entry]) => {
              this.hostVisible = entry.intersectionRatio >= MINI_VISIBLE_RATIO;
              this.updateMini();
            },
            { threshold: [0, MINI_VISIBLE_RATIO] }
          )
        : null;
    visibility?.observe(host);

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
      .getAutoSkipOpening()
      .then((enabled) => this.autoSkipOpening.set(enabled))
      .catch(() => undefined);

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

    // Статистика плееров: каждая серия — свой сеанс. Эффект стоит раньше
    // загрузки серии: её запуск уже пишется в измерение нового сеанса.
    // Серия с диска считается отдельным провайдером `local`.
    effect(() => {
      this.iframeUrl();
      const target = this.telemetryKey();

      untracked(() => {
        this.measurement?.close();
        const context = this.telemetry.context(
          target,
          this.localPath() ? 'local' : undefined
        );
        this.telemetryContext.set(context);
        this.measurement = this.telemetry.measurement(context);
      });
    });

    // Выбор засчитывается, как только сбор разрешён: аккаунт мог ещё
    // грузиться, когда серия открылась.
    effect(() => {
      const context = this.telemetryContext();
      const enabled = this.telemetry.enabled();

      if (context && enabled && this.telemetrySelected !== context.sessionId) {
        this.telemetrySelected = context.sessionId;
        untracked(() => this.telemetry.record(context, { name: 'selected' }));
      }
    });

    // Источник выбирается на смене серии и дальше не меняется: докачавшаяся
    // посреди просмотра серия не должна перезапускать воспроизведение с диска.
    effect(() => {
      const url = this.iframeUrl();

      untracked(() => {
        const prepared =
          this.preparedSelection?.iframeUrl === url ? this.preparedSelection : null;
        this.preparedSelection = null;
        this.cancelSelection();
        const localPath = this.localPath();
        const startSecs = prepared?.positionSecs ?? this.startPositionSecs();
        this.cancelAutoNext();
        this.cancelAutoSkip();
        this.openingAutoHandled = false;
        this.skipHint.set(null);
        this.playedOnce.set(false);
        this.framePainted.set(false);
        // Серию, выбранную в плеере, смотрят дальше — предлагать продолжить
        // её с сохранённой секунды незачем.
        this.resumeOffer.set(!prepared && startSecs > 0 ? startSecs : null);
        if (this.episodeLoaded) {
          this.showEpisodeToast();
        }
        this.episodeLoaded = true;
        this.skipController = new SkipController(
          this.skips(),
          this.isLastEpisode()
        );
        // Сама запускается только серия, на которую перешли из плеера
        // («Следующая», отсчёт после титров, выбор в плеере). Открытие
        // страницы и выбор серии в списке ставят её на паузу на постере.
        const resume = prepared?.resume ?? this.playNextOnLoad;
        this.playNextOnLoad = false;
        if (resume) {
          this.measurement?.request();
        }

        if (prepared?.manifest) {
          // Поток уже получен, пока старая серия доигрывала, — подключаем
          // его без второго резолва.
          this.generation += 1;
          this.unrenewedManifest = '';
          this.stopWaitingForNetwork?.();
          this.offline.set(false);
          this.resetStreamGuards();
          this.status.set('resolving');
          this.errorText.set('');
          this.switchingQuality.set(false);
          this.attach(prepared.manifest, startSecs, url, resume);
          this.closePicker();
          return;
        }

        if (prepared) {
          this.closePicker();
        }
        void this.load(url, startSecs, localPath, resume);
      });
    });

    // Экран не гаснет, пока идёт серия: для системы человек «ничего не делает».
    effect(() => {
      this.wakeLock.set(!this.paused());
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
          .then((value) => {
            this.isFullscreen.set(value);
            if (!value && !this.theater()) {
              this.closePicker();
            }
          })
          .catch(() => undefined);
      })
      .then((stop) => {
        unlisten = stop;
      })
      .catch(() => undefined);

    const suspendMeasurement = (): void => {
      this.measurement?.pause();
      void this.telemetry.flush();
    };
    const onVisibilityChange = (): void => {
      if (this.document.visibilityState === 'hidden') {
        suspendMeasurement();
      }
    };
    this.document.addEventListener('visibilitychange', onVisibilityChange);
    this.document.defaultView?.addEventListener('pagehide', suspendMeasurement);

    inject(DestroyRef).onDestroy(() => {
      this.measurement?.close();
      void this.telemetry.flush();
      this.document.removeEventListener('visibilitychange', onVisibilityChange);
      this.document.defaultView?.removeEventListener(
        'pagehide',
        suspendMeasurement
      );
      this.generation += 1;
      this.cancelSelection();
      visibility?.disconnect();
      this.cancelAutoSkip();
      if (this.theaterTimer !== null) {
        clearTimeout(this.theaterTimer);
      }
      this.document.documentElement.classList.remove('player-theater');

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
      for (const timer of [
        this.seekBadgeTimer,
        this.volumeHudTimer,
        this.playFlashTimer,
        this.episodeToastTimer,
      ]) {
        if (timer !== null) {
          clearTimeout(timer);
        }
      }
      this.wakeLock.destroy();

      this.stopWaitingForNetwork?.();
      this.cancelAutoNext();
      this.stopFrameCycle();
      this.stopUpscale();
      this.teardown();
      this.mediaSession.clear();
    });
  }

  // ——— выбор серии в плеере ———

  openPicker(): void {
    if (
      (!this.isFullscreen() && !this.theater()) ||
      !this.nativeOptions().length
    ) {
      return;
    }

    this.helpOpen.set(false);
    this.host
      .querySelectorAll<HTMLDetailsElement>('details[open]')
      .forEach((menu) => (menu.open = false));
    this.cancelAutoNext();
    this.cancelAutoSkip();
    this.selectionError.set('');
    this.pickerOpen.set(true);
    this.pokeControls();
  }

  closePicker(): void {
    const wasOpen = this.pickerOpen();
    if (wasOpen) {
      this.restorePickerFocus = true;
    }
    this.pickerOpen.set(false);
    this.cancelSelection();
    if (wasOpen) {
      this.pokeControls();
    }
  }

  onPickerKeydown(event: KeyboardEvent): void {
    // Стрелки и пробел принадлежат панели, а не управлению видео.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closePicker();
    }
  }

  private cancelSelection(): void {
    this.selectionToken += 1;
    this.selectionPending.set(null);
  }

  /**
   * Серия или озвучка из панели выбора. Поток новой серии резолвится, пока
   * старая ещё играет, и только потом выбор уходит родителю: «Ищу поток…»
   * на чёрном экране не появляется. Скачанную серию резолвить не нужно.
   */
  async selectPlayback(iframeUrl: string): Promise<void> {
    const options = this.nativeOptions();
    const target = options.find((option) => option.iframeUrl === iframeUrl);
    const sourceUrl = this.iframeUrl();
    const source = options.find((option) => option.iframeUrl === sourceUrl);
    if (!this.pickerOpen() || !source || !target) {
      return;
    }
    // Меняется что-то одно: серия в той же озвучке или озвучка той же серии.
    if (target.dubbing !== source.dubbing && target.episode !== source.episode) {
      return;
    }
    if (iframeUrl === sourceUrl) {
      this.closePicker();
      return;
    }

    const token = ++this.selectionToken;
    this.selectionPending.set(iframeUrl);
    this.selectionError.set('');
    try {
      const manifest = target.local
        ? null
        : await this.resolveManifest(iframeUrl);
      if (token !== this.selectionToken || sourceUrl !== this.iframeUrl()) {
        return;
      }
      const latest = this.nativeOptions().find(
        (option) => option.iframeUrl === iframeUrl
      );
      if (
        !latest ||
        (latest.dubbing !== source.dubbing && latest.episode !== source.episode)
      ) {
        this.cancelSelection();
        this.selectionError.set(
          'Этот поток больше недоступен. Выберите другую серию или озвучку.'
        );
        return;
      }

      // Позиция берётся после резолва: старое видео всё это время играло.
      const video = this.videoRef()?.nativeElement;
      const positionSecs = video?.currentTime || this.position();
      const resume = video ? !video.paused : !this.paused();
      const prepared = {
        iframeUrl,
        manifest,
        resume,
        positionSecs: target.episode === source.episode ? positionSecs : 0,
      };
      this.preparedSelection = prepared;
      // Старая дорожка дописывает позицию до того, как родитель сменит выбор,
      // и замолкает. Иначе pause старого видео пометил бы новую серию.
      this.detachCurrent();
      this.nativeSelection.emit(iframeUrl);
      // Родитель мог выбор не принять: тогда iframeUrl не сменится, и
      // заготовку никто не заберёт. Старый поток уже снят — поднимаем его.
      afterNextRender(
        () => {
          if (this.preparedSelection !== prepared) {
            return;
          }
          this.preparedSelection = null;
          void this.load(sourceUrl, positionSecs, this.localPath(), resume);
          this.selectionError.set(
            'Не удалось переключить поток. Попробуйте ещё раз.'
          );
        },
        { injector: this.injector }
      );
    } catch {
      if (token !== this.selectionToken) {
        return;
      }
      this.selectionPending.set(null);
      this.selectionError.set(
        'Не удалось подключить выбранный поток. Попробуйте ещё раз.'
      );
    }
  }

  // ——— загрузка ———

  /**
   * @param resume запускать ли воспроизведение, когда поток готов.
   */
  private async load(
    iframeUrl: string,
    positionSecs: number,
    localPath: string | null = null,
    resume = this.hasStarted()
  ): Promise<void> {
    this.cancelSelection();
    const token = ++this.generation;

    this.stopWaitingForNetwork?.();
    this.offline.set(false);

    // Старый поток гасится сразу, а не после резолва: его тикер успевал
    // обновить подпись уже чужой серии, перебивал этот резолв и подключал
    // новую серию с секунды старой — с титров, где загрузка и вставала.
    this.stopTicker();
    this.detachCurrent();
    this.manifestUrl = '';
    this.unrenewedManifest = '';
    this.resetStreamGuards();

    this.status.set('resolving');
    this.errorText.set('');
    this.skipHint.set(null);
    this.switchingQuality.set(false);

    if (localPath) {
      await this.loadLocal(token, localPath, positionSecs, iframeUrl, resume);
      return;
    }

    try {
      await this.qualityRestored;
      const manifest = await this.resolveManifest(iframeUrl);

      if (token !== this.generation || iframeUrl !== this.iframeUrl()) {
        return;
      }

      this.attach(manifest, positionSecs, iframeUrl, resume);
    } catch {
      if (token === this.generation && iframeUrl === this.iframeUrl()) {
        this.fail(RESOLVE_FAILED_TEXT, 'resolve');
      }
    }
  }

  /**
   * Ссылка на серию: заранее запрошенная, если она есть и подпись ещё
   * свежая, иначе — новый резолв.
   */
  private async resolveManifest(iframeUrl: string): Promise<string> {
    const quality = this.requestedQuality();
    const prefetched = this.prefetched;

    if (prefetched?.iframeUrl === iframeUrl && prefetched.quality === quality) {
      this.prefetched = null;
      const manifest = await prefetched.manifest.catch(() => null);
      if (manifest && !shouldRefreshAhead(manifest)) {
        return manifest;
      }
    }

    return this.resolver.resolvePlayback(iframeUrl, quality);
  }

  /**
   * Запрашивает ссылку следующей серии, пока досматривается эта. Ошибка тут
   * не страшна: при переходе серия просто резолвится как обычно.
   */
  private prefetchNext(): void {
    const next = this.nextIframeUrl();
    const quality = this.requestedQuality();
    if (
      !next ||
      (this.prefetched?.iframeUrl === next && this.prefetched.quality === quality)
    ) {
      return;
    }

    const manifest = this.resolver.resolvePlayback(next, quality);
    manifest.catch(() => undefined);
    this.prefetched = { iframeUrl: next, quality, manifest };
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
    iframeUrl: string,
    resume: boolean
  ): Promise<void> {
    try {
      await invoke('allow_playback', { path });
    } catch (error: unknown) {
      if (token === this.generation) {
        this.fail(String(error), 'local');
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
    const ready = (): void => {
      if (token === this.generation && this.iframeUrl() === iframeUrl) {
        this.pendingReady = null;
        this.onReady(video, positionSecs, resume);
      }
    };
    video.addEventListener('loadedmetadata', ready, { once: true });
    this.pendingReady = () => video.removeEventListener('loadedmetadata', ready);
    video.src = convertFileSrc(path);
    this.startTicker();
  }

  /** Новый поток начинает без следов ошибок прежнего. */
  private resetStreamGuards(): void {
    this.latch = new ReResolveOnForbidden();
    this.refreshAheadAfter = 0;
    this.forbiddenDuringRefresh = false;
    this.networkRetryUsed = false;
    this.qualityFailed.set(false);
  }

  /** До destroy старый поток ещё хранит честную позицию — сохраняем её. */
  private detachCurrent(): void {
    // Событие pause после уничтожения MediaSource уже может принести 0/0.
    this.emitPausedProgress();
    this.cancelPendingSeek();
    this.pendingReady?.();
    this.pendingReady = null;
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
    this.mediaRecoveries = 0;
    this.lastMediaRecoveryAt = 0;

    if (Hls.isSupported()) {
      const hls = new Hls(this.hlsConfig(positionSecs));
      this.hls = hls;

      // События принадлежат экземпляру потока. Во время detach/destroy
      // они ещё могут прийти, но менять загрузку новой серии уже не должны.
      const current = (): boolean =>
        this.hls === hls && this.iframeUrl() === iframeUrl;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (current()) {
          this.onHlsError(data);
        }
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (current()) {
          this.onReady(video, positionSecs, resume);
        }
      });
      // Сегмент скачан — подпись и сеть снова в порядке. Признак надёжнее
      // «видео заиграло»: hls.js докачивает буфер и на паузе, и 403 там
      // ловится так же.
      hls.on(Hls.Events.FRAG_LOADED, () => {
        if (!current()) {
          return;
        }
        this.latch.onPlaybackResumed();
        this.networkRetryUsed = false;
      });
      // WKWebView может застрять в долях секунды от конца потока и не прислать
      // `ended`: без этого не было ни отсчёта до следующей серии, ни отметки
      // досмотра, а серия начиналась заново. hls.js такой застой распознаёт
      // сам. Паузу ставим явно, чтобы вебвью не продолжил играть с начала.
      hls.on(Hls.Events.MEDIA_ENDED, (_event, data) => {
        if (current() && data.stalled && !this.endHandled) {
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
      const token = this.generation;
      const ready = (): void => {
        if (token === this.generation && this.iframeUrl() === iframeUrl) {
          this.pendingReady = null;
          this.onReady(video, positionSecs, resume);
        }
      };
      video.addEventListener('loadedmetadata', ready, { once: true });
      this.pendingReady = () => video.removeEventListener('loadedmetadata', ready);
      video.src = manifestUrl;
      this.startTicker();
      return;
    }

    this.fail(
      'Этот вебвью не умеет ни MediaSource, ни HLS — воспроизведение недоступно.',
      'unsupported'
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

    // Открытие страницы и выбор серии в списке просмотр не начинают: человек
    // мог прийти почитать описание, а не слушать опенинг. Сама стартует только
    // серия, на которую перешли из плеера, а смена качества и переролв
    // сохраняют то состояние, в котором их застали.
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

  /** @param code причина для статистики плееров — без текста ошибки. */
  private fail(message: string, code = 'playback'): void {
    this.measurement?.error(code);
    this.status.set('error');
    this.errorText.set(message);
    this.stopTicker();
  }

  // ——— ошибки и обновление подписи ———

  private onHlsError(data: ErrorData): void {
    // Во время обновления подписи подавляем только повторные 403. Другие
    // фатальные ошибки не должны оставлять остановленный hls.js со спиннером.
    if (this.refreshing && data.response?.code === 403) {
      this.forbiddenDuringRefresh = true;
      return;
    }

    switch (this.latch.onSegmentError(data.response?.code ?? -1)) {
      case 'reresolve':
        void this.refresh();
        return;
      case 'fail':
        this.fail('Подпись потока истекла, обновить не удалось.', 'expired');
        return;
      case 'propagate':
        if (!data.fatal) {
          return;
        }

        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && this.recoverMedia()) {
          return;
        }

        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (navigator.onLine === false) {
            this.waitForNetwork();
            return;
          }
          // onLine врёт при сети без интернета, а упавший узел CDN новый
          // резолв часто меняет на другой. Одна тихая попытка до ошибки.
          if (!this.networkRetryUsed && !this.refreshing) {
            this.networkRetryUsed = true;
            void this.refresh();
            return;
          }
          this.fail(NETWORK_FAILED_TEXT, 'network');
          return;
        }

        this.fail(MEDIA_FAILED_TEXT, 'media');
    }
  }

  /**
   * Ошибка декодера часто лечится без перезагрузки: hls.js пересоздаёт
   * MediaSource и продолжает с той же секунды. Рецепт из документации hls.js:
   * сначала просто восстановить, при повторе — ещё и сменить аудиокодек, и
   * только третья ошибка подряд показывается человеку.
   */
  private recoverMedia(): boolean {
    const hls = this.hls;
    if (!hls) {
      return false;
    }

    const now = performance.now();
    if (now - this.lastMediaRecoveryAt > MEDIA_RECOVERY_WINDOW_MS) {
      this.mediaRecoveries = 0;
    }
    this.lastMediaRecoveryAt = now;
    this.mediaRecoveries += 1;

    if (this.mediaRecoveries === 1) {
      hls.recoverMediaError();
      return true;
    }

    if (this.mediaRecoveries === 2) {
      hls.swapAudioCodec();
      hls.recoverMediaError();
      return true;
    }

    return false;
  }

  /**
   * Сеть пропала: hls.js исчерпал повторы и сдался. Ждём событие `online` и
   * продолжаем с той же секунды — без нажатия «Повторить». Серия резолвится
   * заново: пока сети не было, подпись могла истечь.
   */
  private waitForNetwork(): void {
    const video = this.videoRef()?.nativeElement;
    const position = video?.currentTime || this.position();
    const resume = video ? !video.paused : this.hasStarted();
    const iframeUrl = this.playbackIframeUrl || this.iframeUrl();

    video?.pause();
    this.fail('Нет подключения к интернету. Продолжу, как только сеть вернётся.');
    this.offline.set(true);

    this.stopWaitingForNetwork?.();
    const onOnline = (): void => {
      this.stopWaitingForNetwork = null;
      void this.load(iframeUrl, position, null, resume);
    };
    window.addEventListener('online', onOnline, { once: true });
    this.stopWaitingForNetwork = () => {
      window.removeEventListener('online', onOnline);
      this.stopWaitingForNetwork = null;
    };
  }

  /**
   * Тихо перезабрать манифест и продолжить с той же секунды.
   *
   * @param ahead обновление по сроку подписи, а не по 403: старый поток ещё
   * играет, поэтому ссылка без продлённой подписи ему ничего не даёт.
   */
  private async refresh(ahead = false): Promise<void> {
    if (this.refreshing) {
      return;
    }

    // Своё поколение: смена качества или серии посреди переролва делает его
    // ответ ненужным, и без проверки поток подключился бы дважды. Плановое
    // обновление поколение не забирает — его ответ может не понадобиться, и
    // отменённая им смена качества так и висела бы.
    const token = ahead ? this.generation : ++this.generation;
    this.refreshGeneration = token;
    this.forbiddenDuringRefresh = false;
    const iframeUrl = this.iframeUrl();
    let attached = false;

    try {
      const video = this.videoRef()?.nativeElement;
      const position =
        video && video.currentTime > 0
          ? video.currentTime
          : this.latch.savedPositionSecs;
      // 403 останавливает загрузку, но не ставит видео на паузу, так что
      // играющая серия продолжит играть, а стоявшая на паузе — стоять.
      const resume = video ? !video.paused : this.hasStarted();

      const manifest = await this.resolver.resolvePlayback(
        iframeUrl,
        this.requestedQuality()
      );

      if (token !== this.generation || iframeUrl !== this.iframeUrl()) {
        return;
      }

      const current = expiryEpochMs(this.manifestUrl);
      const next = expiryEpochMs(manifest);
      if (ahead && current !== null && next !== null && next <= current) {
        this.unrenewedManifest = this.manifestUrl;
        return;
      }

      attached = true;
      this.attach(manifest, position, iframeUrl, resume);
    } catch {
      if (token === this.generation && iframeUrl === this.iframeUrl()) {
        if (ahead) {
          // Подпись ещё жива и поток играет: попробуем позже, а не уроним его.
          this.refreshAheadAfter = Date.now() + REFRESH_AHEAD_RETRY_MS;
        } else {
          this.fail(RESOLVE_FAILED_TEXT, 'resolve');
        }
      }
    } finally {
      // Запрос предыдущей серии может завершиться после нового обновления.
      if (this.refreshGeneration === token) {
        this.refreshGeneration = null;
        // 403 во время обновления был подавлен, а нового потока так и не
        // подключили: hls.js стоит, и разбудить его больше некому.
        if (
          ahead &&
          this.forbiddenDuringRefresh &&
          !attached &&
          token === this.generation
        ) {
          this.forbiddenDuringRefresh = false;
          void this.refresh();
        }
      }
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
      if (!this.pickerOpen()) {
        this.updateAutoSkip(video.paused);
      }

      if (duration > 0 && duration - position <= PREFETCH_LEAD_SECS) {
        this.prefetchNext();
      }

      const now = performance.now();
      if (!video.paused && now - this.lastProgressAt >= PROGRESS_EMIT_MS) {
        this.lastProgressAt = now;
        this.progress.emit({
          iframeUrl: this.playbackIframeUrl,
          positionSecs: position,
          durationSecs: duration,
        });
      }

      if (
        !this.refreshing &&
        Date.now() >= this.refreshAheadAfter &&
        !this.switchingQuality() &&
        this.manifestUrl &&
        this.manifestUrl !== this.unrenewedManifest &&
        shouldRefreshAhead(this.manifestUrl)
      ) {
        void this.refresh(true);
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
    const hls = this.hls;
    this.hls = null;
    hls?.destroy();
  }

  private teardown(): void {
    this.stopTicker();
    this.cancelPendingSeek();
    this.pendingReady?.();
    this.pendingReady = null;
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
    this.measureTick(video);

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

  /**
   * Время просмотра и режимы, в которых серия реально играла. Режим
   * засчитывается раз за сеанс и только на идущем видео: включённый на паузе
   * и тут же выключенный — не использование.
   */
  private measureTick(video: HTMLVideoElement): void {
    const active = !video.paused && !this.buffering() && video.readyState >= 3;
    this.measurement?.observe(
      video.currentTime,
      active,
      video.seeking,
      video.playbackRate
    );
    if (!active || video.seeking) {
      return;
    }

    const quality = this.actualQuality();
    if (quality) {
      this.measurement?.feature('quality', String(quality), true);
    }
    if (this.upscaleActive()) {
      this.measurement?.feature('upscale', this.upscaleMode(), true);
    }
    if (this.autoSkipOpening()) {
      this.measurement?.feature('auto_skip', 'on', true);
    }
    if (this.isFullscreen()) {
      this.measurement?.feature('fullscreen', 'on', true);
    }
    if (this.mini()) {
      this.measurement?.feature('mini', 'on', true);
    }
    if (this.theater()) {
      this.measurement?.feature('theater', 'on', true);
    }
    this.reportHardware();
    if (
      document.pictureInPictureElement === video ||
      (video as WebKitVideo).webkitPresentationMode === 'picture-in-picture'
    ) {
      this.measurement?.feature('pip', 'on', true);
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

  /**
   * У hls.js свои ошибки через его события, а у файла с диска и нативного
   * HLS (WebKitGTK без MediaSource) других сигналов нет. Код ответа нативный
   * HLS не отдаёт, поэтому 403 и сбой сети неразличимы: один тихий переролв
   * через затвор, повтор — ошибка.
   */
  onVideoError(): void {
    if (this.isLocal()) {
      if (this.status() !== 'error') {
        this.fail('Не удалось воспроизвести файл с диска.', 'local');
      }
      return;
    }

    const video = this.videoRef()?.nativeElement;
    if (
      !video ||
      this.hls ||
      !this.manifestUrl ||
      video.getAttribute('src') !== this.manifestUrl
    ) {
      return;
    }

    if (navigator.onLine === false) {
      this.waitForNetwork();
      return;
    }
    if (this.refreshing) {
      this.forbiddenDuringRefresh = true;
      return;
    }
    if (this.latch.onSegmentError(403) === 'reresolve') {
      void this.refresh();
      return;
    }
    this.fail(NETWORK_FAILED_TEXT, 'network');
  }

  onWaiting(): void {
    if (!this.videoRef()?.nativeElement.paused) {
      this.measurement?.waiting();
    }
    this.buffering.set(true);
  }

  onPlaying(): void {
    this.measurement?.playing();
    this.framePainted.set(true);
    this.buffering.set(false);
    // Нативный HLS о сегментах не сообщает: живость потока — то, что он играет.
    if (!this.hls && !this.isLocal()) {
      this.latch.onPlaybackResumed();
      this.networkRetryUsed = false;
    }
  }

  onEnded(): void {
    if (this.endHandled) {
      return;
    }

    this.measurement?.pause();
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
    this.measurement?.request();
    // Повторный запуск после конца — новый просмотр, у которого будет свой конец.
    this.endHandled = false;
    this.paused.set(false);
    this.mediaSession.setPlaying(true);
    this.syncMediaPosition();
    this.playedOnce.set(true);
    this.resumeOffer.set(null);
    this.pokeControls();
    this.updateMini();

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
    this.measurement?.pause();
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

  /**
   * Подсказка «+10 с» у края, куда перематывают стрелками. Без неё перемотка
   * при скрытой панели выглядела как случайный рывок кадра. Серия перемоток
   * в ту же сторону копит секунды, как на YouTube.
   */
  private showSeekBadge(side: -1 | 1): void {
    const previous = this.seekBadge();
    const secs =
      previous?.side === side ? previous.secs + SEEK_STEP_SECS : SEEK_STEP_SECS;
    this.seekBadge.set({ side, secs });

    if (this.seekBadgeTimer !== null) {
      clearTimeout(this.seekBadgeTimer);
    }
    this.seekBadgeTimer = setTimeout(() => {
      this.seekBadgeTimer = null;
      this.seekBadge.set(null);
    }, SEEK_BADGE_SHOW_MS);
  }

  /** На паузе по центру и так большая ▶ — вспышка нужна только при запуске. */
  private flashPlay(): void {
    this.playFlash.set([++this.playFlashId]);

    if (this.playFlashTimer !== null) {
      clearTimeout(this.playFlashTimer);
    }
    this.playFlashTimer = setTimeout(() => {
      this.playFlashTimer = null;
      this.playFlash.set([]);
    }, PLAY_FLASH_MS);
  }

  /**
   * Громкость с клавиатуры меняется при скрытой панели — без плашки не видно,
   * сработало ли нажатие. Значение читается после того, как видео его приняло.
   */
  private showVolumeHud(): void {
    const video = this.videoRef()?.nativeElement;
    if (!video) {
      return;
    }

    this.volumeHud.set(video.muted ? 0 : Math.round(video.volume * 100));

    if (this.volumeHudTimer !== null) {
      clearTimeout(this.volumeHudTimer);
    }
    this.volumeHudTimer = setTimeout(() => {
      this.volumeHudTimer = null;
      this.volumeHud.set(null);
    }, VOLUME_HUD_SHOW_MS);
  }

  togglePlay(): void {
    const video = this.videoRef()?.nativeElement;
    if (!video) {
      return;
    }

    if (video.paused) {
      this.measurement?.request();
      this.hasStarted.set(true);
      this.flashPlay();
      void video.play().catch(() => this.measurement?.error('play_rejected'));
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

    this.measurement?.feature('upscale', mode === 'off' ? 'off' : 'requested');
    // Выбор руками старше автоматики: дальше она в эту серию не вмешивается.
    this.fallback.release();
    this.upscaleNote.set('');

    this.upscaleMode.set(mode);
    await this.settings.setUpscale(mode);
  }

  /** Видеокарта и экран — раз за сеанс и только с согласием: запрос адаптера не бесплатный. */
  private reportHardware(): void {
    const measurement = this.measurement;
    if (!measurement || !this.telemetry.enabled()) {
      return;
    }
    measurement.feature('screen', screenClass(window), true);
    void gpuClass().then((gpu) => measurement.feature('gpu', gpu, true));
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

    // Один замер скорости на запуск: первые окна — разгон шейдеров и буфера,
    // дальше ~10 секунд воспроизведения. Окна на паузе (`videoFps` = 0) не в счёт.
    let perfWindows = 0;
    let perfFps = 0;
    let perfVideoFps = 0;
    const perfDone = UPSCALE_PERF_WARMUP + UPSCALE_PERF_WINDOWS;

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
          if (
            stats.videoFps > 0 &&
            ++perfWindows > UPSCALE_PERF_WARMUP &&
            perfWindows <= perfDone
          ) {
            perfFps += stats.fps;
            perfVideoFps += stats.videoFps;
            if (perfWindows === perfDone) {
              this.measurement?.feature(
                'upscale_perf',
                upscalePerf(mode, stats.sourceHeight, perfFps / perfVideoFps)
              );
            }
          }

          const decision = this.fallback.observe(stats, performance.now());
          if (decision) {
            // Откат случается раньше полного замера — без этого самые
            // медленные запуски в статистику не попали бы вовсе.
            if (perfWindows < perfDone && stats.videoFps > 0) {
              perfWindows = perfDone;
              this.measurement?.feature(
                'upscale_perf',
                upscalePerf(mode, stats.sourceHeight, stats.fps / stats.videoFps)
              );
            }
            // Настройку не переписываем: выбор человека остаётся прежним, а
            // на другой серии или другом качестве режим может и потянуть.
            this.upscaleNote.set(decision.reason);
            this.upscaleMode.set(decision.to);
          }
        },
        onPreparing: (preparing) => {
          if (token === this.upscaleToken) {
            this.upscalePreparing.set(preparing);
          }
        },
        onError: (message) => {
          // Цикл уже остановился сам; здесь остаётся показать причину и
          // погасить канву, чтобы под ней снова было видно обычное видео.
          if (token === this.upscaleToken) {
            this.measurement?.featureError('upscale');
            this.upscaleError.set(message);
            this.upscaleStats.set(null);
            this.upscalePreparing.set(false);
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
        this.measurement?.featureError('upscale');
        this.upscalePreparing.set(false);
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
    this.upscalePreparing.set(false);
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
    if (!this.paused() && !this.pickerOpen()) {
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

      if (!this.paused() && !this.scrubbing && !this.pickerOpen()) {
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
    this.cancelSelection();
    const same =
      quality === this.shownQuality() && quality === this.effectiveQuality();
    if (same || this.switchingQuality()) {
      return;
    }

    this.measurement?.feature('quality', 'requested_' + quality);
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
    const previous = this.actualQuality() ?? this.effectiveQuality();
    this.switchingQuality.set(true);
    this.qualityFailed.set(false);

    try {
      const manifest = await this.resolver.changeManifestQuality(
        this.manifestUrl,
        quality
      );

      if (token !== this.generation) {
        return;
      }

      // Нужного качества нет, Rust вернул тот же поток — перезапускать нечего,
      // о недоступности скажет пометка в меню. Адрес прокси при каждом
      // резолве новый (новый токен), поэтому для него сравнивается высота.
      const current = qualityOf(this.manifestUrl);
      if (
        manifest === this.manifestUrl ||
        (current !== null && qualityOf(manifest) === current)
      ) {
        this.switchingQuality.set(false);
        return;
      }

      // Позиция и пауза берутся после резолва: пока Rust проверял манифесты,
      // серия продолжала играть.
      const video = this.videoRef()?.nativeElement;
      const positionSecs = video?.currentTime ?? this.position();
      const resume = video ? !video.paused : false;

      this.attach(manifest, positionSecs, iframeUrl, resume);
    } catch {
      if (token === this.generation) {
        // Старый поток цел и играет — ронять его из-за качества незачем.
        this.measurement?.error('quality');
        this.switchingQuality.set(false);
        this.requestedQuality.set(previous);
        void this.settings.setQuality(previous).catch(() => undefined);
        this.qualityFailed.set(true);
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
    if (this.isLastEpisode() || this.pickerOpen()) {
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

  private showEpisodeToast(): void {
    if (this.episodeToastTimer !== null) {
      clearTimeout(this.episodeToastTimer);
    }
    this.episodeToast.set([++this.playFlashId]);
    this.episodeToastTimer = setTimeout(() => {
      this.episodeToastTimer = null;
      this.episodeToast.set([]);
    }, EPISODE_TOAST_SHOW_MS);
  }

  goNext(): void {
    this.cancelSelection();
    this.cancelAutoNext();

    if (!this.isLastEpisode()) {
      // Переход — осознанное продолжение просмотра, новая серия стартует сама.
      this.hasStarted.set(true);
      this.playNextOnLoad = true;
      this.nextEpisode.emit();
    }
  }

  goPrevious(): void {
    this.cancelSelection();
    this.cancelAutoNext();

    if (!this.isFirstEpisode()) {
      this.hasStarted.set(true);
      this.playNextOnLoad = true;
      this.previousEpisode.emit();
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
    this.measurement?.feature(
      hint.kind === 'opening' ? 'skip_opening' : 'skip_ending'
    );
    if (hint.kind === 'opening') {
      this.openingAutoHandled = true;
      this.cancelAutoSkip();
      this.seekTo(this.skipController.skipTargetSecs(hint.segment));
      return;
    }

    this.goNext();
  }

  // ——— автопропуск опенинга ———

  /**
   * Опенинг пропускается сам, но не сразу: плашка с отсчётом даёт передумать.
   * Пока серия на паузе, отсчёт не начинается.
   */
  private updateAutoSkip(paused: boolean): void {
    if (this.skipHint()?.kind !== 'opening') {
      this.cancelAutoSkip();
      return;
    }

    if (
      paused ||
      !this.autoSkipOpening() ||
      this.openingAutoHandled ||
      this.autoSkipTimer !== null
    ) {
      return;
    }

    this.autoSkipSecs.set(AUTO_SKIP_SECS);
    this.autoSkipTimer = setInterval(() => {
      const left = (this.autoSkipSecs() ?? 0) - 1;

      if (left > 0) {
        this.autoSkipSecs.set(left);
        return;
      }

      this.skipOpeningNow();
    }, 1000);
  }

  skipOpeningNow(): void {
    const hint = this.skipHint();
    this.openingAutoHandled = true;
    this.cancelAutoSkip();

    if (hint?.kind === 'opening') {
      this.applySkip(hint);
    }
  }

  /** «Пропускать всегда»: включить автопропуск и пропустить уже этот опенинг. */
  alwaysSkipOpening(hint: SkipHint): void {
    this.setAutoSkipOpening(true);
    this.applySkip(hint);
  }

  /** «Больше не пропускать» из отсчёта: выключить и досмотреть этот опенинг. */
  disableAutoSkip(): void {
    this.setAutoSkipOpening(false);
    this.declineAutoSkip();
  }

  /** «Смотреть опенинг»: в этой серии больше не предлагать. */
  declineAutoSkip(): void {
    this.openingAutoHandled = true;
    this.cancelAutoSkip();
  }

  private cancelAutoSkip(): void {
    if (this.autoSkipTimer !== null) {
      clearInterval(this.autoSkipTimer);
      this.autoSkipTimer = null;
    }

    this.autoSkipSecs.set(null);
  }

  toggleAutoSkipOpening(): void {
    this.setAutoSkipOpening(!this.autoSkipOpening());
  }

  private setAutoSkipOpening(enabled: boolean): void {
    this.autoSkipOpening.set(enabled);
    this.measurement?.feature('auto_skip', enabled ? 'on' : 'off');
    void this.settings.setAutoSkipOpening(enabled).catch(() => undefined);

    if (!enabled) {
      this.cancelAutoSkip();
    }
  }

  // ——— кинотеатр и мини-плеер ———

  toggleTheater(): void {
    if (IS_PLAYER_WINDOW || this.theaterLeaving()) {
      return;
    }

    if (!this.theater()) {
      this.theater.set(true);
      this.mini.set(false);
      // Класс на корне документа — для глобальных стилей: страница под
      // затемнением не прокручивается (styles.scss).
      this.document.documentElement.classList.add('player-theater');
      return;
    }

    // Плеер — тот же элемент, а не @if, поэтому `animate.leave` тут не
    // поможет: класс снимается после того, как отыграла анимация ухода.
    if (this.reducedMotion) {
      this.finishTheaterExit();
      return;
    }

    this.theaterLeaving.set(true);
    this.theaterTimer = setTimeout(
      () => this.finishTheaterExit(),
      THEATER_LEAVE_MS
    );
  }

  private finishTheaterExit(): void {
    if (!this.isFullscreen()) {
      this.closePicker();
    }
    this.theaterTimer = null;
    this.theaterLeaving.set(false);
    this.theater.set(false);
    this.document.documentElement.classList.remove('player-theater');
    this.updateMini();
  }

  /**
   * В угол уходит только играющая серия: остановленную человек оставил сам.
   * На паузе внутри мини-плеера он остаётся — кнопка ▶ должна быть под рукой.
   */
  private updateMini(): void {
    if (this.hostVisible) {
      this.miniDismissed = false;
      this.mini.set(false);
      return;
    }

    if (
      !this.mini() &&
      !this.miniDismissed &&
      !this.paused() &&
      !this.theater() &&
      !this.isFullscreen()
    ) {
      this.mini.set(true);
    }
  }

  closeMini(): void {
    this.miniDismissed = true;
    this.mini.set(false);

    const video = this.videoRef()?.nativeElement;
    if (video && !video.paused) {
      video.pause();
    }
  }

  /** Вернуться к месту плеера; мини-плеер уберёт наблюдатель видимости. */
  returnFromMini(): void {
    this.host.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
      case 'KeyT':
        if (this.isFullscreen() || IS_PLAYER_WINDOW) {
          return false;
        }
        this.toggleTheater();
        return true;
      case 'KeyM':
        this.toggleMuted();
        this.showVolumeHud();
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
        this.showSeekBadge(1);
        return true;
      case 'ArrowLeft':
        this.seekBy(-SEEK_STEP_SECS);
        this.showSeekBadge(-1);
        return true;
      case 'Home':
        this.seekTo(0);
        return true;
      case 'End':
        this.seekTo(this.duration());
        return true;
      case 'ArrowUp':
        this.setVolume(this.volume() + VOLUME_STEP);
        this.showVolumeHud();
        return true;
      case 'ArrowDown':
        this.setVolume(this.volume() - VOLUME_STEP);
        this.showVolumeHud();
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

        if (this.autoSkipSecs() !== null) {
          this.declineAutoSkip();
          return true;
        }

        if (this.theater() && !this.isFullscreen()) {
          this.toggleTheater();
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
