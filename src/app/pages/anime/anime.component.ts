import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  resource,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { confirm } from '@tauri-apps/plugin-dialog';
import { openPath } from '@tauri-apps/plugin-opener';
import { TuiLoader, TuiTextfield } from '@taiga-ui/core';
import {
  TuiChevron,
  TuiDataListWrapper,
  TuiSelect,
} from '@taiga-ui/kit';

import { AnimeService } from '../../api/anime.service';
import type { Video } from '../../api/anime.types';
import {
  DEFAULT_QUALITY,
  DownloadService,
  QUALITIES,
} from '../../api/download.service';

/**
 * Бэк отдаёт player как человекочитаемую подпись — «Плеер Kodik», «Плеер Alloha»,
 * — а не как идентификатор. Поэтому сравнение по вхождению, а не по равенству.
 */
const KODIK_PLAYER = 'Kodik';

@Component({
  selector: 'app-anime',
  imports: [
    FormsModule,
    RouterLink,
    TuiChevron,
    TuiDataListWrapper,
    TuiLoader,
    TuiSelect,
    TuiTextfield,
  ],
  templateUrl: './anime.component.html',
  styleUrl: './anime.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnimeComponent {
  private readonly api = inject(AnimeService);
  private readonly downloads = inject(DownloadService);

  readonly id = input.required<string>();

  readonly anime = resource({
    params: () => ({ id: this.id() }),
    loader: ({ params }) => this.api.getById(params.id),
  });

  /** Только то, что вообще можно скачать: Kodik и ничего больше. */
  private readonly kodikVideos = computed<Video[]>(
    () =>
      this.anime
        .value()
        ?.videos.filter((video) => video.data.player.includes(KODIK_PLAYER)) ??
      []
  );

  readonly dubbings = computed(() => [
    ...new Set(this.kodikVideos().map((video) => video.data.dubbing)),
  ]);

  readonly selectedDubbing = signal<string>('');

  readonly episodes = computed(() => {
    const dubbing = this.selectedDubbing();

    return this.kodikVideos()
      .filter((video) => video.data.dubbing === dubbing)
      .sort((a, b) => Number(a.number) - Number(b.number));
  });

  readonly outputDir = signal<string>('');
  readonly lastError = signal<string>('');
  /** Нейтральное сообщение об исходе действия — в отличие от lastError. */
  readonly notice = signal<string>('');

  readonly folderPerAnime = signal<boolean>(true);

  /**
   * Серии, файлы которых уже лежат на диске: videoId -> путь.
   *
   * Источник правды здесь — файловая система, а не список задач: после
   * «Очистить завершённые» задач нет, а файлы есть, и без этой сверки страница
   * предлагала бы скачать заново весь сезон.
   */
  readonly onDisk = signal<ReadonlyMap<number, string>>(new Map());

  readonly qualities = QUALITIES;
  readonly quality = signal<number>(DEFAULT_QUALITY);
  readonly stringifyQuality = (value: number): string => `${value}p`;

  /** Статусы задач по videoId — чтобы строка серии показывала свой прогресс. */
  readonly taskById = computed(
    () => new Map(this.downloads.tasks().map((task) => [task.id, task]))
  );

  /**
   * Сколько серий этого аниме сейчас в работе. Считается от очереди, а не от
   * последнего клика: после «Скачать все» строк слишком много, чтобы понять по
   * ним, что что-то вообще происходит, а перезаход на страницу такой счётчик
   * не сбрасывает.
   */
  readonly queuedCount = computed(() => {
    const own = new Set(this.kodikVideos().map((video) => `${video.videoId}`));

    return this.downloads.pending().filter((task) => own.has(task.id)).length;
  });

  constructor() {
    // Первая доступная озвучка выбирается сама — иначе список серий пуст,
    // и страница выглядит сломанной, хотя данные пришли.
    effect(() => {
      const available = this.dubbings();

      if (available.length > 0 && !available.includes(this.selectedDubbing())) {
        this.selectedDubbing.set(available[0]);
      }
    });

    void this.downloads
      .getOutputDir()
      .then((dir) => this.outputDir.set(dir ?? ''));

    void this.downloads.getQuality().then((value) => this.quality.set(value));

    void this.downloads
      .getFolderPerAnime()
      .then((value) => this.folderPerAnime.set(value));

    // Сверка с диском. Зависит и от pending().length: когда очередь
    // дорабатывает серию, счётчик меняется — это и есть сигнал пересверить.
    // На сами tasks() подписываться нельзя, они дёргаются раз в секунду от
    // событий прогресса.
    effect(() => {
      const episodes = this.episodes();
      const title = this.anime.value()?.title;

      this.outputDir();
      this.folderPerAnime();
      this.downloads.pending().length;

      if (!title || episodes.length === 0) {
        return;
      }

      void this.downloads
        .findDownloaded(title, episodes)
        .then((found) => this.onDisk.set(found))
        // Папка не выбрана — сверять не с чем. Это штатное состояние до первой
        // настройки, а не ошибка, которую стоит показывать.
        .catch(() => this.onDisk.set(new Map()));
    });
  }

  async changeQuality(value: number): Promise<void> {
    this.quality.set(value);
    await this.downloads.setQuality(value);
  }

  async changeFolderPerAnime(enabled: boolean): Promise<void> {
    this.folderPerAnime.set(enabled);
    await this.downloads.setFolderPerAnime(enabled);
  }

  async chooseDir(): Promise<void> {
    const picked = await this.downloads.chooseOutputDir();

    if (picked) {
      this.outputDir.set(picked);
    }
  }

  readonly selected = signal<ReadonlySet<number>>(new Set());

  readonly hasSelection = computed(() => this.selected().size > 0);

  toggle(episode: Video): void {
    this.selected.update((current) => {
      const next = new Set(current);
      next.has(episode.videoId)
        ? next.delete(episode.videoId)
        : next.add(episode.videoId);
      return next;
    });
  }

  isSelected(episode: Video): boolean {
    return this.selected().has(episode.videoId);
  }

  async downloadSelected(): Promise<void> {
    const chosen = this.episodes().filter((episode) => this.isSelected(episode));
    await this.enqueue(chosen);
    this.selected.set(new Set());
  }

  async downloadAll(): Promise<void> {
    await this.enqueue(this.episodes());
  }

  async download(episode: Video): Promise<void> {
    await this.enqueue([episode]);
  }

  private async enqueue(episodes: Video[]): Promise<void> {
    this.lastError.set('');
    this.notice.set('');

    if (episodes.length === 0) {
      return;
    }

    try {
      const anime = this.anime.value();
      const title = anime?.title ?? '';

      const wanted = await this.withoutRedundant(title, episodes);
      if (wanted.length === 0) {
        return;
      }

      await this.downloads.enqueue(anime?.animeId ?? 0, title, wanted);
    } catch (error: unknown) {
      this.lastError.set(String(error));
    }
  }

  /**
   * Отсеивает то, что уже скачано, спросив один раз на всю пачку.
   *
   * Вопрос по каждой серии превратил бы «Скачать все серии» в двадцать
   * диалогов, поэтому спрашиваем разом; отказ означает «пропустить готовые», а
   * не «отменить всё» — иначе одна старая серия в выборке блокировала бы
   * докачку остальных.
   */
  private async withoutRedundant(
    title: string,
    episodes: Video[]
  ): Promise<Video[]> {
    const downloaded = await this.downloads.findDownloaded(title, episodes);
    if (downloaded.size === 0) {
      return episodes;
    }

    const again = await confirm(
      `Уже скачано серий: ${downloaded.size}. Скачать их заново поверх файлов?`,
      {
        title: 'Серии уже на диске',
        kind: 'warning',
        okLabel: 'Скачать заново',
        cancelLabel: 'Пропустить',
      }
    );

    if (again) {
      return episodes;
    }

    const rest = episodes.filter(
      (episode) => !downloaded.has(episode.videoId)
    );

    if (rest.length === 0) {
      this.notice.set('Все выбранные серии уже скачаны.');
    }

    return rest;
  }

  /** Файл уже на диске — открываем, а не качаем второй раз. */
  isOnDisk(episode: Video): boolean {
    return this.onDisk().has(episode.videoId);
  }

  async play(episode: Video): Promise<void> {
    const path = this.onDisk().get(episode.videoId);
    if (!path) {
      return;
    }

    try {
      await openPath(path);
    } catch {
      // Файл исчез между сверкой и кликом — снимаем пометку, строка сама
      // вернётся к кнопке «Скачать».
      this.onDisk.update((current) => {
        const next = new Map(current);
        next.delete(episode.videoId);
        return next;
      });
    }
  }

  percent(episode: Video): number {
    const task = this.taskById().get(`${episode.videoId}`);

    if (!task || task.totalSecs <= 0) {
      return 0;
    }

    return Math.min(100, Math.round((task.processedSecs / task.totalSecs) * 100));
  }

  statusOf(episode: Video): string {
    const task = this.taskById().get(`${episode.videoId}`);

    if (!task) {
      return '';
    }

    switch (task.status) {
      case 'queued':
        return 'В очереди';
      case 'resolving':
        return 'Ищу поток…';
      case 'downloading':
        return 'Скачивается';
      case 'done':
        return 'Готово';
      case 'cancelled':
        // Кнопка отменённой серии снова запускает загрузку, поэтому подпись —
        // действие, а не состояние: «Отменено» выглядело неактивной пометкой.
        return 'Повторить';
      case 'failed':
        return 'Ошибка';
    }
  }

  /** Скачанное и отменённое можно ставить заново, идущее — нет. */
  isBusy(episode: Video): boolean {
    const status = this.taskById().get(`${episode.videoId}`)?.status;

    return status === 'queued' || status === 'resolving' || status === 'downloading';
  }

  isFailed(episode: Video): boolean {
    return this.taskById().get(`${episode.videoId}`)?.status === 'failed';
  }

  /** Скачанная серия качается не заново, а открывается в загрузках. */
  isDone(episode: Video): boolean {
    return this.taskById().get(`${episode.videoId}`)?.status === 'done';
  }
}
