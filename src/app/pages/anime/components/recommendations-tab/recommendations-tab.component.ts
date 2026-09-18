import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  resource,
} from '@angular/core';
import { TuiLoader } from '@taiga-ui/core';

import { AnimeService } from '../../../../api/anime.service';
import { AnimeCardComponent } from '../../../../components/anime-card/anime-card.component';
import { LoadErrorComponent } from '../../../../components/load-error/load-error.component';

/** Вкладка «Похожие аниме»: та же сетка карточек, что на главной. */
@Component({
  selector: 'app-recommendations-tab',
  imports: [AnimeCardComponent, LoadErrorComponent, TuiLoader],
  templateUrl: './recommendations-tab.component.html',
  styleUrl: './recommendations-tab.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecommendationsTabComponent {
  private readonly api = inject(AnimeService);

  readonly animeId = input.required<number>();

  readonly similar = resource({
    params: () => ({ id: this.animeId() }),
    loader: ({ params }) => this.api.getRecommendations(params.id),
  });
}
