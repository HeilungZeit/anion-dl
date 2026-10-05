import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  resource,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiIcon, TuiLoader } from '@taiga-ui/core';

import { AnimeService } from '../../api/anime.service';
import { UserService } from '../../api/user.service';
import { WatchProgressService } from '../../api/watch-progress.service';
import { AnimeCardComponent } from '../../components/anime-card/anime-card.component';
import { LoadErrorComponent } from '../../components/load-error/load-error.component';

@Component({
  selector: 'app-feed',
  imports: [AnimeCardComponent, LoadErrorComponent, RouterLink, TuiIcon, TuiLoader],
  templateUrl: './feed.component.html',
  styleUrl: './feed.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FeedComponent {
  private readonly api = inject(AnimeService);
  readonly watchProgress = inject(WatchProgressService);
  readonly users = inject(UserService);

  readonly feed = resource({
    loader: () => this.api.getFeed(),
  });

  constructor() {
    // У вошедшего ряд общий с сайтом и приходит с сервера — при каждом
    // заходе на ленту: позиция могла смениться на другом устройстве.
    effect(() => {
      if (this.users.isAuthenticated()) {
        void this.watchProgress.loadContinueWatching();
      }
    });
  }

  /** Крестик: ссылка под кнопкой не должна сработать. */
  hide(animeId: number, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    void this.watchProgress.hideFromContinue(animeId);
  }

  progressPercent(positionSecs: number, durationSecs: number): number {
    return durationSecs > 0
      ? Math.min(Math.max((positionSecs / durationSecs) * 100, 0), 100)
      : 0;
  }

  formatPosition(totalSecs: number): string {
    const secs = Math.max(Math.floor(totalSecs), 0);
    const minutes = Math.floor(secs / 60);

    return `${minutes}:${String(secs % 60).padStart(2, '0')}`;
  }
}
