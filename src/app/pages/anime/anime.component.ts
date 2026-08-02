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

  readonly qualities = QUALITIES;
  readonly quality = signal<number>(DEFAULT_QUALITY);
  readonly stringifyQuality = (value: number): string => `${value}p`;

  /** Статусы задач по videoId — чтобы строка серии показывала свой прогресс. */
  readonly taskById = computed(
    () => new Map(this.downloads.tasks().map((task) => [task.id, task]))
  );

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
  }

  async changeQuality(value: number): Promise<void> {
    this.quality.set(value);
    await this.downloads.setQuality(value);
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

    if (episodes.length === 0) {
      return;
    }

    try {
      const anime = this.anime.value();

      await this.downloads.enqueue(
        anime?.animeId ?? 0,
        anime?.title ?? '',
        episodes
      );
    } catch (error: unknown) {
      this.lastError.set(String(error));
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
        return 'Отменено';
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
}
