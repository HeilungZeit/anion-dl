import {
  ChangeDetectionStrategy,
  Component,
  inject,
  resource,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiLoader } from '@taiga-ui/core';

import { AnimeService } from '../../api/anime.service';
import { WatchProgressService } from '../../api/watch-progress.service';
import { AnimeCardComponent } from '../../components/anime-card/anime-card.component';

@Component({
  selector: 'app-feed',
  imports: [AnimeCardComponent, RouterLink, TuiLoader],
  templateUrl: './feed.component.html',
  styleUrl: './feed.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FeedComponent {
  private readonly api = inject(AnimeService);
  readonly watchProgress = inject(WatchProgressService);

  readonly feed = resource({
    loader: () => this.api.getFeed(),
  });

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
