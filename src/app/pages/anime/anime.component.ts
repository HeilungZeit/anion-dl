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
import { TuiLoader } from '@taiga-ui/core';
import { TuiTabs } from '@taiga-ui/kit';

import { AnimeService } from '../../api/anime.service';
import type { Video } from '../../api/anime.types';
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

  constructor() {
    // Первая доступная озвучка выбирается сама — иначе список серий пуст,
    // и страница выглядит сломанной, хотя данные пришли.
    effect(() => {
      const available = this.dubbings();

      const requested = this.dubbing();
      const preferred = requested && available.includes(requested)
        ? requested
        : available[0];

      if (preferred && !available.includes(this.selectedDubbing())) {
        this.selectedDubbing.set(preferred);
      }
    });
  }
}
