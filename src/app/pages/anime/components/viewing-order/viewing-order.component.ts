import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiElasticContainer } from '@taiga-ui/layout';

import type { Anime } from '../../../../api/anime.types';

/** Порядок и следующий тайтл берутся из списка API, как на основном фронте. */
@Component({
  selector: 'app-viewing-order',
  imports: [RouterLink, TuiElasticContainer],
  templateUrl: './viewing-order.component.html',
  styleUrl: './viewing-order.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewingOrderComponent {
  readonly anime = input.required<Anime>();
  readonly isExpanded = input(false);
  readonly order = computed(() => this.anime().viewingOrder ?? []);

  isCurrentTitle(animeId: number): boolean {
    return String(animeId) === String(this.anime().animeId);
  }
}
