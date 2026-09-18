import {
  afterNextRender,
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
import { FormsModule } from '@angular/forms';
import { TuiDataList, TuiTextfield } from '@taiga-ui/core';
import { TuiChevron, TuiSelect } from '@taiga-ui/kit';

import type { Anime, Video } from '../../../../api/anime.types';
import { DownloadService } from '../../../../api/download.service';
import {
  latestAvailableWatchedEpisode,
  RemoteWatchProgressService,
} from '../../../../api/remote-watch-progress.service';
import { UserService } from '../../../../api/user.service';
import {
  resumeEpisodeFor,
  WatchProgressService,
} from '../../../../api/watch-progress.service';
import {
  type PlaybackProgress,
  VideoPlayerComponent,
} from '../../../../player/video-player.component';
import { orderPreviewFrames } from '../../../../player/preview-frames';
import { CommentsComponent } from '../comments/comments.component';

/** Субтитры и озвучки бэк отдаёт вперемешку, различаются только подписью. */
const SUBTITLES_PREFIX = 'субтитры';

/**
 * Вкладка «Просмотр»: панель эпизодов, плеер и комментарии.
 *
 * Композиция и логика повторяют блок плеера на anion.online — панель над
 * кадром, группы «Озвучки»/«Субтитры» с числом серий, полоса просмотра и лента
 * эпизодов. Отличий два: серия играет своим плеером вместо iframe Kodik, и нет
 * выбора плеера — приложение умеет только Kodik, и список из одного пункта был
 * бы шумом.
 */
@Component({
  selector: 'app-description-tab',
  imports: [
    CommentsComponent,
    FormsModule,
    TuiChevron,
    TuiDataList,
    TuiSelect,
    TuiTextfield,
    VideoPlayerComponent,
  ],
  templateUrl: './description-tab.component.html',
  styleUrl: './description-tab.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DescriptionTabComponent {
  private readonly localProgress = inject(WatchProgressService);
  private readonly remoteProgress = inject(RemoteWatchProgressService);
  private readonly users = inject(UserService);
  private readonly downloads = inject(DownloadService);
  readonly progressInitialized = this.localProgress.isInitialized;

  /**
   * Скачанные серии этого тайтла: videoId -> путь. Такая серия играет с диска.
   * Пока сверка не прошла, плеер не монтируется: иначе он начал бы резолвить
   * поток Kodik, а через миг выяснилось бы, что файл лежит рядом.
   */
  private readonly onDisk = signal<ReadonlyMap<number, string>>(new Map());
  private readonly diskChecked = signal(false);
  readonly playerReady = computed(
    () => this.progressInitialized() && this.diskChecked()
  );

  readonly localPath = computed(() => {
    const episode = this.selectedEpisode();
    return episode ? (this.onDisk().get(episode.videoId) ?? null) : null;
  });

  /**
   * Недосмотренные серии текущей озвучки: номер -> процент. Полоса на плитке
   * показывает, где остановился, — галочка есть только у досмотренных.
   */
  readonly partialProgress = computed(() => {
    const animeId = this.anime().animeId;
    const dubbing = this.dubbing();
    const result = new Map<number, number>();

    for (const record of this.localProgress.records()) {
      if (
        record.animeId === animeId &&
        record.dubbing === dubbing &&
        !record.finished &&
        record.positionSecs > 0 &&
        record.durationSecs > 0
      ) {
        result.set(
          record.episode,
          Math.min((record.positionSecs / record.durationSecs) * 100, 100)
        );
      }
    }

    return result;
  });

  readonly anime = input.required<Anime>();
  /** Все серии Kodik: нужны, чтобы считать эпизоды по каждой озвучке. */
  readonly videos = input.required<readonly Video[]>();
  readonly episodes = input.required<readonly Video[]>();
  readonly dubbings = input.required<readonly string[]>();
  readonly dubbing = input.required<string>();
  /** Номер серии из адреса: сюда ведёт ряд «Продолжить смотреть». */
  readonly requestedEpisode = input<number>();

  /** Серверные отметки относятся к аниме целиком, а не к одной озвучке. */
  readonly watched = computed<ReadonlySet<number>>(
    () => new Set(
      this.remoteProgress.episodesFor(
        this.anime().animeId,
        this.users.user()?.id ?? null
      )
    )
  );

  readonly dubbingChange = output<string>();

  readonly selectedEpisode = signal<Video | null>(null);

  /** Озвучки и субтитры показываются отдельными группами, как на фронте. */
  readonly dubbersData = computed(() => {
    const all = this.dubbings();

    return {
      dubbers: all.filter(
        (name) => !name.toLowerCase().startsWith(SUBTITLES_PREFIX)
      ),
      subtitles: all.filter((name) =>
        name.toLowerCase().startsWith(SUBTITLES_PREFIX)
      ),
    };
  });

  private readonly countByDubbing = computed(() => {
    const counts = new Map<string, number>();

    for (const video of this.videos()) {
      const name = video.data.dubbing;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }

    return counts;
  });

  readonly watchedCount = computed(() => {
    const seen = this.watched();

    return this.episodes().filter((video) => seen.has(Number(video.number)))
      .length;
  });

  readonly watchedPercent = computed(() => {
    const total = this.episodes().length;

    return total === 0 ? 0 : Math.round((this.watchedCount() / total) * 100);
  });

  readonly isLastEpisode = computed(() => {
    const current = this.selectedEpisode();

    return (
      current !== null && this.episodes().at(-1)?.videoId === current.videoId
    );
  });

  /**
   * Заставка до первого нажатия.
   *
   * Постер тайтла вертикальный, и в кадре 16:9 он встал бы узкой полосой между
   * чёрных полей. Кадр из серии — уже нужных пропорций, поэтому берём его, а
   * постер оставляем запасным вариантом.
   */
  /** Кадры для заставки плеера: выбранной серии — первыми. */
  readonly frames = computed(() =>
    orderPreviewFrames(
      this.anime().randomScreenshots,
      this.selectedEpisode()?.number ?? null
    )
  );

  readonly preview = computed(
    () =>
      this.anime().randomScreenshots?.[0]?.sizes.full ?? this.anime().poster.big
  );

  readonly startPositionSecs = computed(() => {
    const episode = this.selectedEpisode();

    return episode
      ? this.localProgress.resumePosition(
          this.anime().animeId,
          Number(episode.number),
          episode.data.dubbing
        )
      : 0;
  });

  private readonly stripRef = viewChild<ElementRef<HTMLElement>>('strip');
  private appliedRequestedEpisode: number | undefined;
  private appliedRemoteDefault = false;
  /** Серия из локальной истории; undefined — история ещё не прочитана. */
  private localDefault: number | null | undefined;
  private selectionWasExplicit = false;

  constructor() {
    // Серверные отметки читаются отдельно от локальной позиции: её сюда не
    // переносим и отсутствие записи на бэке локальными данными не подменяем.
    effect(() => {
      const initialized = this.users.isInitialized();
      const userId = this.users.user()?.id;
      const animeId = this.anime().animeId;

      untracked(() => {
        if (!initialized || userId === undefined) {
          return;
        }

        void this.remoteProgress
          .ensureLoaded(animeId, userId)
          .catch(() => undefined);
      });
    });

    // Серия переставляется при смене озвучки и при загрузке списка. Правило
    // взято с фронта: держимся того же номера, а если его в новой озвучке нет
    // — падаем на первую серию. Иначе переключение озвучки сбрасывало бы
    // зрителя в начало сезона.
    effect(() => {
      const list = this.episodes();
      const requested = this.requestedEpisode();
      const watched = this.watched();
      const progressReady = this.progressInitialized();

      untracked(() => {
        if (list.length === 0) {
          this.selectedEpisode.set(null);
          return;
        }

        // Параметр из URL применяется один раз и после этого не перебивает
        // ручной выбор серии.
        if (
          requested !== undefined &&
          requested !== this.appliedRequestedEpisode
        ) {
          const fromUrl = list.find(
            (video) => Number(video.number) === requested
          );

          if (fromUrl) {
            this.appliedRequestedEpisode = requested;
            this.appliedRemoteDefault = true;
            this.selectedEpisode.set(fromUrl);
            return;
          }
        }

        // При обычном открытии тайтла выбираем, где человек остановился.
        // Локальная история точнее — в ней позиция и досмотренность, — но
        // серверный прогресс общий с другими устройствами и приезжает позже
        // списка серий. Побеждает бо́льший номер: если там ушли дальше,
        // возвращать на старую серию незачем. Выбор человека не перебиваем.
        if (!this.appliedRemoteDefault && !this.selectionWasExplicit) {
          const numbers = list.map((video) => Number(video.number));

          if (this.localDefault === undefined && progressReady) {
            this.localDefault = resumeEpisodeFor(
              this.localProgress.records(),
              this.anime().animeId,
              numbers
            );
          }

          const remote = latestAvailableWatchedEpisode(numbers, watched);
          if (remote !== null) {
            this.appliedRemoteDefault = true;
          }

          const target = Math.max(this.localDefault ?? 0, remote ?? 0);
          const fromHistory = list.find(
            (video) => Number(video.number) === target
          );

          if (fromHistory) {
            this.selectedEpisode.set(fromHistory);
            return;
          }
        }

        const current = this.selectedEpisode();
        const same = current
          ? list.find((video) => video.number === current.number)
          : undefined;

        this.selectedEpisode.set(same ?? list[0]);
      });
    });

    // Сверка с диском по всем озвучкам сразу, чтобы смена озвучки не ждала
    // новой. Повторяется, когда очередь закончила серию — число в работе
    // меняется; на сами задачи не подписываемся, они тикают от прогресса.
    effect(() => {
      const title = this.anime().title;
      const videos = this.videos();
      this.downloads.pending().length;

      untracked(() => {
        void this.downloads
          .findDownloaded(title, [...videos])
          .then((found) => this.onDisk.set(found))
          // Папка загрузок не выбрана — играть с диска нечего, это не ошибка.
          .catch(() => this.onDisk.set(new Map()))
          .finally(() => this.diskChecked.set(true));
      });
    });

    // Лента прокручивается вбок, и у длинного сезона текущая серия оказывается
    // за краем — особенно после перехода на следующую.
    effect(() => {
      this.selectedEpisode();
      untracked(() => this.revealSelected());
    });

    afterNextRender(() => this.revealSelected());

    inject(DestroyRef).onDestroy(() => {
      void this.localProgress.flush().catch(() => undefined);
      // Уход со страницы не должен ждать дебаунса отметок.
      void this.remoteProgress.flush();
    });
  }

  saveProgress(progress: PlaybackProgress): void {
    const episode = this.videos().find(
      (video) => video.iframeUrl === progress.iframeUrl
    );
    if (!episode) {
      return;
    }

    this.localProgress.record({
      animeId: this.anime().animeId,
      title: this.anime().title,
      poster: this.anime().poster,
      episode: Number(episode.number),
      dubbing: episode.data.dubbing,
      positionSecs: progress.positionSecs,
      durationSecs: progress.durationSecs,
      lastEpisode: this.isLastOfDubbing(episode),
    });
  }

  saveAndFlush(progress: PlaybackProgress): void {
    this.saveProgress(progress);
    void this.localProgress.flush().catch(() => undefined);
  }

  /**
   * Серия засчитывается на сервере, как только её начали смотреть — то же
   * правило, что на фронте. Там признак старта — клик по чужому iframe, здесь
   * честное событие `play`. Гостю отмечать некуда: серверный прогресс только
   * у аккаунта.
   */
  markWatched(iframeUrl: string): void {
    const userId = this.users.user()?.id;
    const episode = this.videos().find((video) => video.iframeUrl === iframeUrl);
    if (userId === undefined || !episode) {
      return;
    }

    this.remoteProgress.markWatched(
      this.anime().animeId,
      userId,
      Number(episode.number)
    );
  }

  markEnded(progress: PlaybackProgress): void {
    this.saveAndFlush({
      iframeUrl: progress.iframeUrl,
      positionSecs: progress.durationSecs,
      durationSecs: progress.durationSecs,
    });
  }

  dubbingLabel(name: string): string {
    const count = this.countByDubbing().get(name) ?? 0;

    return count > 0 ? `${name} (${count} эп.)` : name;
  }

  select(episode: Video): void {
    this.selectionWasExplicit = true;
    this.selectedEpisode.set(episode);
  }

  isSelected(episode: Video): boolean {
    return this.selectedEpisode()?.videoId === episode.videoId;
  }

  progressOf(episode: Video): number | null {
    return this.partialProgress().get(Number(episode.number)) ?? null;
  }

  isWatched(episode: Video): boolean {
    return this.watched().has(Number(episode.number));
  }

  goToNextEpisode(): void {
    const list = this.episodes();
    const current = this.selectedEpisode();
    if (!current) {
      return;
    }

    const index = list.findIndex((video) => video.videoId === current.videoId);
    const next = index >= 0 ? list[index + 1] : undefined;

    if (next) {
      this.selectionWasExplicit = true;
      this.selectedEpisode.set(next);
    }
  }

  /**
   * Колесо мыши вертикальное, а лента горизонтальная: без перевода прокрутить
   * её мышью нельзя вовсе.
   */
  onStripWheel(event: WheelEvent): void {
    const strip = this.stripRef()?.nativeElement;

    if (!strip || event.deltaY === 0 || event.shiftKey) {
      return;
    }

    strip.scrollLeft += event.deltaY;
    event.preventDefault();
  }

  /** Последняя вышедшая серия в своей озвучке — не обязательно в выбранной. */
  private isLastOfDubbing(episode: Video): boolean {
    const number = Number(episode.number);

    return !this.videos().some(
      (video) =>
        video.data.dubbing === episode.data.dubbing &&
        Number(video.number) > number
    );
  }

  private revealSelected(): void {
    // Ждём отрисовки: до неё класс ещё на прошлой плитке.
    queueMicrotask(() => {
      this.stripRef()
        ?.nativeElement.querySelector('.episode-item--selected')
        ?.scrollIntoView({ block: 'nearest', inline: 'center' });
    });
  }
}
