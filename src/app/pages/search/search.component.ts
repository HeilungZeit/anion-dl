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
import { TuiLoader } from '@taiga-ui/core';

import { AnimeService } from '../../api/anime.service';
import type { Anime } from '../../api/anime.types';
import { AnimeCardComponent } from '../../components/anime-card/anime-card.component';

const DEBOUNCE_MS = 400;

@Component({
  selector: 'app-search',
  imports: [AnimeCardComponent, FormsModule, TuiLoader],
  templateUrl: './search.component.html',
  styleUrl: './search.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchComponent {
  private readonly api = inject(AnimeService);
  private readonly router = inject(Router);
  readonly q = input<string>('');
  readonly draft = signal('');
  private debounce: ReturnType<typeof setTimeout> | null = null;

  readonly results = resource({
    params: () => this.q().trim(),
    loader: ({ params }) =>
      params ? this.api.search({ search: params, limit: 60 }) : Promise.resolve([]),
  });

  private readonly loaded = linkedSignal<
    readonly Anime[] | undefined,
    readonly Anime[] | undefined
  >({
    source: () => this.results.value(),
    computation: (value, previous) => value ?? previous?.value,
  });

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
