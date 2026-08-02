import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { Genre, Poster } from '../../api/anime.types';

@Component({
  selector: 'app-anime-card',
  imports: [RouterLink],
  template: `
    <a
      class="card"
      [class.card--wide]="wide()"
      [routerLink]="['/anime', animeId()]"
      [attr.aria-label]="'Открыть аниме «' + title() + '»'"
    >
      <div class="card__media">
        <img
          class="card__poster"
          [src]="poster().big || poster().medium"
          [alt]="'Постер: ' + title()"
          loading="lazy"
        />
        <span class="card__shade" aria-hidden="true"></span>

        @if (statusTitle()) {
          <span
            class="card__status"
            [class.card__status--ongoing]="statusAlias() === 'ongoing'"
            [class.card__status--released]="statusAlias() === 'released'"
          >
            {{ statusTitle() }}
          </span>
        }

        <span class="card__poster-meta">
          @if (rating() !== undefined) {
            <span class="card__rating">★ {{ rating()?.toFixed(1) }}</span>
          }

          @if (episodesCount()) {
            <span>
              @if (episodesAired() && episodesAired() !== episodesCount()) {
                {{ episodesAired() }} из
              }
              {{ episodesCount() }} эп.
            </span>
          }
        </span>
      </div>

      <div class="card__body">
        @if (type() || year()) {
          <span class="card__kicker">
            {{ type() }}
            @if (type() && year()) { · }
            {{ year() }}
          </span>
        }

        <span class="card__title">{{ title() }}</span>

        @if (subtitle()) {
          <span class="card__subtitle">{{ subtitle() }}</span>
        }

        @if (wide() && genres().length > 0) {
          <span class="card__genres">
            @for (genre of genres(); track genre.id; let last = $last) {
              {{ genre.title }}@if (!last) {, }
            }
          </span>
        }
      </div>
    </a>
  `,
  styleUrl: './anime-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnimeCardComponent {
  readonly animeId = input.required<number>();
  readonly title = input.required<string>();
  readonly poster = input.required<Poster>();
  readonly subtitle = input<string>('');
  readonly year = input<number>();
  readonly type = input<string>('');
  readonly statusTitle = input<string>('');
  readonly statusAlias = input<string>('');
  readonly rating = input<number>();
  readonly episodesAired = input<number>();
  readonly episodesCount = input<number>();
  readonly genres = input<readonly Genre[]>([]);
  readonly wide = input(false);
}
