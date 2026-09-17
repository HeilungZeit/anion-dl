import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import type { Anime } from '../../../../api/anime.types';
import { AnimeSidebarComponent } from '../anime-sidebar/anime-sidebar.component';

/** Шапка тайтла: постер, название, мета и жанры. Общая для всех вкладок. */
@Component({
  selector: 'app-anime-header',
  imports: [AnimeSidebarComponent],
  templateUrl: './anime-header.component.html',
  styleUrl: './anime-header.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnimeHeaderComponent {
  readonly anime = input.required<Anime>();
}
