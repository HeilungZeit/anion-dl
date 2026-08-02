import {
  ChangeDetectionStrategy,
  Component,
  inject,
  resource,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiLoader } from '@taiga-ui/core';

import { AnimeService } from '../../api/anime.service';
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

  readonly feed = resource({
    loader: () => this.api.getFeed(),
  });
}
