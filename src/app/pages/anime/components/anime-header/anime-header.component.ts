import { Location } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TuiIcon } from '@taiga-ui/core';

import type { Anime } from '../../../../api/anime.types';
import { nextEpisodeInfo } from '../../next-episode';
import { nextViewingTitle } from '../../viewing-order';
import { AnimeSidebarComponent } from '../anime-sidebar/anime-sidebar.component';
import { ViewingOrderComponent } from '../viewing-order/viewing-order.component';

/** Шапка тайтла: постер, название, мета и жанры. Общая для всех вкладок. */
@Component({
  selector: 'app-anime-header',
  imports: [AnimeSidebarComponent, RouterLink, TuiIcon, ViewingOrderComponent],
  templateUrl: './anime-header.component.html',
  styleUrl: './anime-header.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnimeHeaderComponent {
  private readonly location = inject(Location);
  private readonly router = inject(Router);
  private readonly now = signal(Date.now());

  readonly anime = input.required<Anime>();
  readonly orderExpanded = linkedSignal({
    source: () => this.anime().animeId,
    computation: () => false,
  });
  readonly descriptionExpanded = linkedSignal({
    source: () => this.anime().animeId,
    computation: () => false,
  });
  readonly description = computed(() => this.anime().description?.trim() ?? '');
  readonly otherTitles = computed(() => this.anime().otherTitles ?? []);
  readonly order = computed(() => this.anime().viewingOrder ?? []);
  readonly nextTitle = computed(() => nextViewingTitle(this.order(), this.anime().animeId));
  readonly nextEpisode = computed(() =>
    nextEpisodeInfo(this.anime().episodes?.nextDate, this.now())
  );

  constructor() {
    effect((onCleanup) => {
      const nextDate = this.anime().episodes?.nextDate;
      if (!nextDate) return;

      this.now.set(Date.now());
      const timer = setInterval(() => this.now.set(Date.now()), 30_000);
      onCleanup(() => clearInterval(timer));
    });
  }

  back(): void {
    const state = this.location.getState();
    // При прямом открытии страницы возвращаем в каталог, а не за пределы приложения.
    if (
      typeof state === 'object' &&
      state !== null &&
      'navigationId' in state &&
      typeof state.navigationId === 'number' &&
      state.navigationId > 1
    ) {
      this.location.back();
    } else {
      void this.router.navigate(['/catalog']);
    }
  }

  toggleOrder(): void {
    this.orderExpanded.update((expanded) => !expanded);
  }

  toggleDescription(): void {
    this.descriptionExpanded.update((expanded) => !expanded);
  }
}
