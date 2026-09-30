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
import { CvhService } from '../../api/cvh.service';
import {
  isKodik,
  sourceOfDubbing,
  type VideoSource,
} from '../../api/video-source';
import {
  latestRecordFor,
  WatchProgressService,
} from '../../api/watch-progress.service';
import { PlayerSettingsService } from '../../player/player-settings.service';
import { LoadErrorComponent } from '../../components/load-error/load-error.component';
import { pickDubbing } from './pick-dubbing';
import { AnimeHeaderComponent } from './components/anime-header/anime-header.component';
import { DescriptionTabComponent } from './components/description-tab/description-tab.component';
import { DownloadsTabComponent } from './components/downloads-tab/downloads-tab.component';
import { RecommendationsTabComponent } from './components/recommendations-tab/recommendations-tab.component';

/**
 * Страница тайтла: шапка и вкладки.
 *
 * Оболочка держит только то, что общее для вкладок: сам тайтл, серии обоих
 * источников (Kodik и CDNVideoHub) и выбранную озвучку. Озвучка живёт здесь
 * намеренно — иначе просмотр и загрузка разъезжались бы по разным озвучкам,
 * и это выглядело бы поломкой.
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
  private readonly cvh = inject(CvhService);
  private readonly settings = inject(PlayerSettingsService);
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

  /**
   * Серии CDNVideoHub — второй источник, с 1080p. Ищутся по MAL id: его же
   * использует Shikimori, откуда источник и взят. Отдельный ресурс, чтобы
   * Kodik не ждал чужой API.
   */
  readonly cvhVideos = resource({
    params: () => {
      const ids = this.anime.value()?.remoteIds;
      const malId = ids?.myanimelistId || ids?.shikimoriId;
      return malId ? { malId } : undefined;
    },
    loader: ({ params }) => this.cvh.videosFor(params.malId),
  });

  /** Всё, что приложение умеет играть или качать: Kodik, затем CDNVideoHub. */
  readonly playableVideos = computed<readonly Video[]>(() => [
    ...(this.anime.value()?.videos.filter(isKodik) ?? []),
    ...(this.cvhVideos.value() ?? []),
  ]);

  readonly dubbings = computed(() => [
    ...new Set(this.playableVideos().map((video) => video.data.dubbing)),
  ]);

  readonly selectedDubbing = signal<string>('');

  /** `undefined` — настройка ещё читается, `null` — человек ещё не выбирал. */
  private readonly preferredSource = signal<VideoSource | null | undefined>(
    undefined
  );

  /**
   * Выбор озвучки человеком — в отличие от автоматического. Источник этой
   * озвучки становится предпочитаемым для тайтлов, которые ещё не смотрели.
   */
  chooseDubbing(dubbing: string): void {
    this.selectedDubbing.set(dubbing);

    const source = sourceOfDubbing(dubbing);
    if (source !== this.preferredSource()) {
      this.preferredSource.set(source);
      void this.settings.setPreferredSource(source).catch(() => undefined);
    }
  }

  readonly episodes = computed(() => {
    const dubbing = this.selectedDubbing();

    return this.playableVideos()
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
    void this.settings
      .getPreferredSource()
      .catch(() => null)
      .then((source) => this.preferredSource.set(source));

    // Озвучка выбирается сама — иначе список серий пуст, и страница выглядит
    // сломанной, хотя данные пришли. Правила — в `pickDubbing`. Без локальной
    // истории и настройки выбор случился бы до их чтения и вёл бы не туда,
    // поэтому их ждём.
    effect(() => {
      const available = this.dubbings();
      const preferredSource = this.preferredSource();
      if (!this.localProgress.isInitialized() || preferredSource === undefined) {
        return;
      }

      // Выбор уже сделан — в том числе кликом, который только что поменял
      // предпочтение и перезапустил этот эффект.
      if (available.includes(this.selectedDubbing())) {
        return;
      }

      const lastWatched = untracked(() => {
        const animeId = this.anime.value()?.animeId;
        return animeId === undefined
          ? undefined
          : latestRecordFor(this.localProgress.records(), animeId)?.dubbing;
      });
      const choice = pickDubbing({
        available,
        requested: this.dubbing(),
        lastWatched,
        preferredSource,
        cvhLoading: this.cvhVideos.isLoading(),
      });

      if (choice !== null && choice !== 'wait') {
        this.selectedDubbing.set(choice);
      }
    });
  }
}
