import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  resource,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TuiLoader } from '@taiga-ui/core';
import { TuiTabs } from '@taiga-ui/kit';

import { AnimeService } from '../../api/anime.service';
import type { Video } from '../../api/anime.types';
import {
  latestRecordFor,
  WatchProgressService,
} from '../../api/watch-progress.service';
import { LoadErrorComponent } from '../../components/load-error/load-error.component';
import { AnimeHeaderComponent } from './components/anime-header/anime-header.component';
import { DescriptionTabComponent } from './components/description-tab/description-tab.component';
import { DownloadsTabComponent } from './components/downloads-tab/downloads-tab.component';
import { RecommendationsTabComponent } from './components/recommendations-tab/recommendations-tab.component';

/**
 * Бэк отдаёт player как человекочитаемую подпись — «Плеер Kodik», «Плеер Alloha»,
 * — а не как идентификатор. Поэтому сравнение по вхождению, а не по равенству.
 */
const KODIK_PLAYER = 'Kodik';

/**
 * Страница тайтла: шапка и вкладки.
 *
 * Оболочка держит только то, что общее для вкладок: сам тайтл, список серий
 * Kodik и выбранную озвучку. Озвучка живёт здесь намеренно — иначе просмотр и
 * загрузка разъезжались бы по разным озвучкам, и это выглядело бы поломкой.
 */
@Component({
  selector: 'app-anime',
  imports: [
    AnimeHeaderComponent,
    DescriptionTabComponent,
    DownloadsTabComponent,
    LoadErrorComponent,
    RecommendationsTabComponent,
    TuiLoader,
    TuiTabs,
  ],
  templateUrl: './anime.component.html',
  styleUrl: './anime.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnimeComponent {
  private readonly api = inject(AnimeService);
  private readonly localProgress = inject(WatchProgressService);
  private readonly watchTab = viewChild(DescriptionTabComponent);

  readonly id = input.required<string>();
  readonly episode = input<string>();
  readonly dubbing = input<string>();

  readonly requestedEpisode = computed(() => {
    const value = Number(this.episode());
    return Number.isFinite(value) && value >= 1 ? value : undefined;
  });

  readonly anime = resource({
    params: () => ({ id: this.id() }),
    loader: ({ params }) => this.api.getById(params.id),
  });

  readonly tabIndex = signal(0);

  /** Только то, что приложение умеет: Kodik и ничего больше. */
  readonly kodikVideos = computed<readonly Video[]>(
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
      .filter((video) => Number(video.number) >= 1)
      .sort((a, b) => Number(a.number) - Number(b.number));
  });

  /**
   * «Смотреть» во вкладке загрузок: на вкладку просмотра с этой серией. Она
   * сама найдёт файл на диске. Выбор прямой, а не через `?episode=`: параметр
   * адреса применяется один раз, и повторный переход на ту же серию молча
   * ничего бы не сделал.
   */
  watchEpisode(episode: Video): void {
    this.selectedDubbing.set(episode.data.dubbing);
    this.watchTab()?.select(episode);
    this.tabIndex.set(0);
  }

  constructor() {
    // Озвучка выбирается сама — иначе список серий пуст, и страница выглядит
    // сломанной, хотя данные пришли. Порядок: из адреса, та, в которой тайтл
    // смотрели последней, первая доступная. Без локальной истории выбор
    // случился бы до её чтения и вёл бы не туда, поэтому её ждём.
    effect(() => {
      const available = this.dubbings();
      if (!this.localProgress.isInitialized()) {
        return;
      }

      const requested = this.dubbing();
      const lastWatched = untracked(() => {
        const animeId = this.anime.value()?.animeId;
        return animeId === undefined
          ? undefined
          : latestRecordFor(this.localProgress.records(), animeId)?.dubbing;
      });
      const preferred = [requested, lastWatched].find(
        (name) => name !== undefined && available.includes(name)
      ) ?? available[0];

      if (preferred && !available.includes(this.selectedDubbing())) {
        this.selectedDubbing.set(preferred);
      }
    });
  }
}
