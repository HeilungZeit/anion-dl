import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  resource,
  signal,
  untracked,
} from '@angular/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { AnimeService } from '../../api/anime.service';
import type { Video } from '../../api/anime.types';
import { DownloadService } from '../../api/download.service';
import { RemoteWatchProgressService } from '../../api/remote-watch-progress.service';
import { UserService } from '../../api/user.service';
import { WatchProgressService } from '../../api/watch-progress.service';
import { orderPreviewFrames } from '../../player/preview-frames';
import {
  type PlaybackProgress,
  VideoPlayerComponent,
} from '../../player/video-player.component';

const KODIK_PLAYER = 'Kodik';

/**
 * Единственная страница окна плеера: кадр и ничего вокруг.
 *
 * Оторвать страницу тайтла целиком было бы проще, но в отдельном окне не
 * нужны ни описание, ни вкладки, ни комментарии — нужен плеер. Поэтому серия
 * задаётся параметрами и собирается здесь заново: либо скачанная задача
 * (`?task=`), либо серия тайтла (`?anime=&episode=&dubbing=`).
 */
@Component({
  selector: 'app-window-player',
  imports: [VideoPlayerComponent],
  templateUrl: './window-player.component.html',
  styleUrl: './window-player.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WindowPlayerComponent {
  private readonly api = inject(AnimeService);
  private readonly downloads = inject(DownloadService);
  private readonly localProgress = inject(WatchProgressService);
  private readonly remoteProgress = inject(RemoteWatchProgressService);
  private readonly users = inject(UserService);

  /** Скачанная серия: идентификатор задачи загрузки. */
  readonly task = input<string>();
  /** Серия тайтла: идентификатор аниме, номер серии и озвучка. */
  readonly anime = input<string>();
  readonly episode = input<string>();
  readonly dubbing = input<string>();

  private readonly onDisk = signal<ReadonlyMap<number, string>>(new Map());
  private readonly diskChecked = signal(false);
  /** Выбранная серия тайтла: меняется кнопкой «следующая». */
  private readonly selected = signal<Video | null>(null);

  private readonly animeData = resource({
    params: () => {
      const id = this.anime();

      return id ? { id } : undefined;
    },
    loader: ({ params }) => this.api.getById(params.id),
  });

  readonly taskItem = computed(
    () => this.downloads.tasks().find((item) => item.id === this.task()) ?? null
  );

  /** Только то, что приложение умеет: Kodik и ничего больше. */
  private readonly videos = computed<readonly Video[]>(() => {
    const dubbing = this.dubbing();

    return (this.animeData.value()?.videos ?? [])
      .filter((video) => video.data.player.includes(KODIK_PLAYER))
      .filter((video) => !dubbing || video.data.dubbing === dubbing)
      .filter((video) => Number(video.number) >= 1)
      .sort((left, right) => Number(left.number) - Number(right.number));
  });

  readonly ready = computed(() => {
    if (this.task()) {
      return this.downloads.restored() && this.localProgress.isInitialized();
    }

    return (
      this.animeData.hasValue() &&
      this.localProgress.isInitialized() &&
      this.diskChecked()
    );
  });

  readonly isMissing = computed(() => {
    const task = this.taskItem();

    return task !== null && this.downloads.missingFiles().has(task.id);
  });

  readonly errorText = computed(() => {
    if (this.task()) {
      return this.taskItem() === null ? 'Серия не найдена в загрузках.' : '';
    }

    if (this.animeData.error()) {
      return 'Не удалось загрузить тайтл.';
    }

    return this.ready() && !this.selected() ? 'Серия не найдена.' : '';
  });

  readonly iframeUrl = computed(
    () => this.taskItem()?.iframeUrl ?? this.selected()?.iframeUrl ?? ''
  );

  /**
   * Скачанная серия играет с диска и без сети — и в режиме тайтла тоже, если
   * файл уже лежит рядом.
   */
  readonly localPath = computed(() => {
    const task = this.taskItem();
    if (task) {
      return this.isMissing() ? null : task.outputPath;
    }

    const episode = this.selected();

    return episode ? (this.onDisk().get(episode.videoId) ?? null) : null;
  });

  readonly poster = computed(
    () =>
      this.taskItem()?.poster?.big ??
      this.animeData.value()?.randomScreenshots?.[0]?.sizes.full ??
      this.animeData.value()?.poster.big ??
      ''
  );

  readonly frames = computed(() =>
    this.task()
      ? []
      : orderPreviewFrames(
          this.animeData.value()?.randomScreenshots,
          this.selected()?.number ?? null
        )
  );

  readonly skips = computed(() => this.selected()?.skips ?? {});

  readonly isLastEpisode = computed(() => {
    if (this.task()) {
      return true;
    }

    const list = this.videos();
    const current = this.selected();

    return (
      current !== null && list[list.length - 1]?.videoId === current.videoId
    );
  });

  readonly startPositionSecs = computed(() => {
    const task = this.taskItem();
    if (task) {
      return this.localProgress.resumePosition(
        task.animeId,
        Number(task.episode),
        task.dubbing
      );
    }

    const episode = this.selected();
    const animeId = this.animeData.value()?.animeId;

    return episode && animeId !== undefined
      ? this.localProgress.resumePosition(
          animeId,
          Number(episode.number),
          episode.data.dubbing
        )
      : 0;
  });

  constructor() {
    // Файл могли удалить, пока приложение было открыто.
    void this.downloads.refreshFiles();

    // Номер серии из адреса применяется один раз: дальше по сериям ходит
    // кнопка «следующая», и перевыбор вернул бы зрителя назад.
    effect(() => {
      const list = this.videos();
      const requested = Number(this.episode());

      untracked(() => {
        if (list.length === 0 || this.selected() !== null) {
          return;
        }

        this.selected.set(
          list.find((video) => Number(video.number) === requested) ??
            list[0] ??
            null
        );
      });
    });

    // Сверка с диском — по сериям выбранной озвучки, как на странице тайтла.
    effect(() => {
      const title = this.animeData.value()?.title;
      const videos = this.videos();

      untracked(() => {
        if (!title) {
          return;
        }

        void this.downloads
          .findDownloaded(title, [...videos])
          .then((found) => this.onDisk.set(found))
          // Папка загрузок не выбрана — играть с диска нечего, это не ошибка.
          .catch(() => this.onDisk.set(new Map()))
          .finally(() => this.diskChecked.set(true));
      });
    });

    // Заголовок окна — единственное, что сообщает, какая серия в нём идёт:
    // шапки здесь нет.
    effect(() => {
      const title = this.windowTitle();

      untracked(() => {
        void getCurrentWindow()
          .setTitle(title)
          .catch(() => undefined);
      });
    });

    inject(DestroyRef).onDestroy(() => {
      void this.localProgress.flush().catch(() => undefined);
      void this.remoteProgress.flush();
    });
  }

  saveProgress(progress: PlaybackProgress): void {
    const task = this.taskItem();

    if (task) {
      const poster = this.posterOf(task.animeId) ?? task.poster;

      // Без постера запись в ряд «Продолжить смотреть» вышла бы битой
      // карточкой. Такое бывает только у задач из версий до постеров.
      if (!poster) {
        return;
      }

      this.localProgress.record({
        animeId: task.animeId,
        title: task.title,
        poster,
        episode: Number(task.episode),
        dubbing: task.dubbing,
        positionSecs: progress.positionSecs,
        durationSecs: progress.durationSecs,
      });
      return;
    }

    const anime = this.animeData.value();
    const episode = this.videos().find(
      (video) => video.iframeUrl === progress.iframeUrl
    );

    if (!anime || !episode) {
      return;
    }

    this.localProgress.record({
      animeId: anime.animeId,
      title: anime.title,
      poster: anime.poster,
      episode: Number(episode.number),
      dubbing: episode.data.dubbing,
      positionSecs: progress.positionSecs,
      durationSecs: progress.durationSecs,
      lastEpisode: this.isLastEpisode(),
    });
  }

  saveAndFlush(progress: PlaybackProgress): void {
    this.saveProgress(progress);
    void this.localProgress.flush().catch(() => undefined);
  }

  markEnded(progress: PlaybackProgress): void {
    this.saveAndFlush({
      ...progress,
      positionSecs: progress.durationSecs,
    });
  }

  /** Та же отметка, что на странице тайтла; без сети она дождётся связи. */
  markWatched(): void {
    const userId = this.users.user()?.id;
    if (userId === undefined) {
      return;
    }

    const task = this.taskItem();
    const animeId = task?.animeId ?? this.animeData.value()?.animeId;
    const episode = task?.episode ?? this.selected()?.number;

    if (animeId !== undefined && episode !== undefined) {
      this.remoteProgress.markWatched(animeId, userId, Number(episode));
    }
  }

  goToNextEpisode(): void {
    const list = this.videos();
    const current = this.selected();
    if (!current) {
      return;
    }

    const index = list.findIndex((video) => video.videoId === current.videoId);
    const next = index >= 0 ? list[index + 1] : undefined;

    if (next) {
      this.selected.set(next);
    }
  }

  private windowTitle(): string {
    const task = this.taskItem();
    if (task) {
      return `${task.title} · ${task.episode} серия`;
    }

    const anime = this.animeData.value();
    const episode = this.selected();

    if (!anime) {
      return 'Anion Flow';
    }

    return episode
      ? `${anime.title} · ${episode.number} серия`
      : anime.title;
  }

  /** Постер задачи мог не сохраниться — берём его из истории просмотра. */
  private posterOf(animeId: number) {
    return (
      this.localProgress.records().find((record) => record.animeId === animeId)
        ?.poster ?? null
    );
  }
}
