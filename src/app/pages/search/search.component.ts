import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  linkedSignal,
  resource,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TuiIcon } from '@taiga-ui/core';

import { AnimeService } from '../../api/anime.service';
import type { Anime } from '../../api/anime.types';
import { CatalogTileComponent } from '../../components/catalog-tile/catalog-tile.component';

const DEBOUNCE_MS = 400;

@Component({
  selector: 'app-search',
  imports: [CatalogTileComponent, FormsModule, TuiIcon],
  templateUrl: './search.component.html',
  styleUrl: './search.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchComponent {
  private readonly api = inject(AnimeService);
  private readonly router = inject(Router);
  readonly q = input('', { transform: (value: string | undefined) => value ?? '' });
  readonly draft = signal('');
  private debounce: ReturnType<typeof setTimeout> | null = null;

  readonly results = resource({
    params: () => this.q().trim(),
    loader: ({ params }) =>
      params.length >= 3 ? this.api.search({ search: params, limit: 60 }) : Promise.resolve([]),
  });

  private readonly loaded = linkedSignal<
    readonly Anime[] | undefined,
    readonly Anime[] | undefined
  >({
    source: () => this.results.hasValue() ? this.results.value() : undefined,
    computation: (value, previous) => value ?? previous?.value,
  });

  readonly hasEnoughInput = computed(() => this.draft().trim().length >= 3);
  readonly isCountPending = computed(() => this.results.isLoading() || this.draft().trim() !== this.q().trim());

  readonly items = computed(() => this.loaded() ?? []);

  constructor() {
    effect(() => {
      const query = this.q();
      untracked(() => this.draft.set(query));
    });
    inject(DestroyRef).onDestroy(() => {
      if (this.debounce !== null) clearTimeout(this.debounce);
    });
  }

  onInput(value: string): void {
    this.draft.set(value);
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      void this.router.navigate(['/search'], {
        queryParams: { q: value.trim() || null },
        replaceUrl: true,
      });
    }, DEBOUNCE_MS);
  }
}
