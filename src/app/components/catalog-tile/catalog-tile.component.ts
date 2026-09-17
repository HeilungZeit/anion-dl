import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiFormatNumberPipe, TuiIcon } from '@taiga-ui/core';
import type { AnimeDetails } from '../../api/anime.types';
@Component({
  selector: 'app-catalog-tile', imports: [RouterLink, TuiIcon, TuiFormatNumberPipe],
  templateUrl: './catalog-tile.component.html', styleUrl: './catalog-tile.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CatalogTileComponent {
  readonly anime = input.required<AnimeDetails>();
  get genres(): string { return this.anime().genres.map(genre => genre.title).join(', '); }
}
