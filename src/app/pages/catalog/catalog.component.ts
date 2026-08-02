import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  resource,
  signal,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TuiIcon, TuiLoader, TuiTextfield } from '@taiga-ui/core';
import {
  TuiChevron,
  TuiDataListWrapper,
  TuiSelect,
} from '@taiga-ui/kit';

import { AnimeService } from '../../api/anime.service';
import type { AnimeQuery } from '../../api/anime.types';
import { AnimeCardComponent } from '../../components/anime-card/anime-card.component';

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 400;

interface CatalogOption {
  readonly value: string;
  readonly title: string;
}

interface CatalogFilters {
  readonly genres: readonly number[];
  readonly type?: string;
  readonly status?: string;
  readonly yearFrom?: number;
  readonly yearTo?: number;
  readonly sort: string;
}

const TYPE_OPTIONS: readonly CatalogOption[] = [
  { value: 'tv', title: 'Сериал' },
  { value: 'movie', title: 'Полнометражный фильм' },
  { value: 'ova', title: 'OVA' },
  { value: 'special', title: 'Спешл' },
  { value: 'shortfilm', title: 'Короткометражный фильм' },
  { value: 'shorttv', title: 'Малометражный сериал' },
  { value: 'ona', title: 'ONA' },
];

const STATUS_OPTIONS: readonly CatalogOption[] = [
  { value: 'ongoing', title: 'Онгоинг' },
  { value: 'released', title: 'Вышел' },
  { value: 'announce', title: 'Анонс' },
];

const SORT_OPTIONS: readonly CatalogOption[] = [
  { value: 'top', title: 'Релевантности' },
  { value: 'title', title: 'Названию' },
  { value: 'year', title: 'Дате выхода' },
  { value: 'rating', title: 'Рейтингу' },
  { value: 'rating_counters', title: 'Голосам' },
  { value: 'views', title: 'Просмотрам' },
];

const DEFAULT_SORT = SORT_OPTIONS[0] as CatalogOption;

@Component({
  selector: 'app-catalog',
  imports: [
    AnimeCardComponent,
    FormsModule,
    TuiChevron,
    TuiDataListWrapper,
    TuiIcon,
    TuiLoader,
    TuiSelect,
    TuiTextfield,
  ],
  templateUrl: './catalog.component.html',
  styleUrl: './catalog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CatalogComponent {
  private readonly api = inject(AnimeService);
  private readonly document = inject(DOCUMENT);

  /** То, что напечатано прямо сейчас. Меняется на каждый символ. */
  readonly draft = signal('');

  /** То, по чему реально идёт запрос. Отстаёт от draft на дебаунс. */
  private readonly query = signal('');

  readonly genres = resource({
    loader: () => this.api.getGenres(),
  });

  readonly selectedGenres = signal<ReadonlySet<number>>(new Set());
  readonly selectedType = signal<CatalogOption | null>(null);
  readonly selectedStatus = signal<CatalogOption | null>(null);
  readonly selectedSort = signal<CatalogOption>(DEFAULT_SORT);
  readonly yearFrom = signal<number | null>(null);
  readonly yearTo = signal<number | null>(null);
  readonly typeOptions = TYPE_OPTIONS;
  readonly statusOptions = STATUS_OPTIONS;
  readonly sortOptions = SORT_OPTIONS;
  readonly nextYear = new Date().getFullYear() + 1;
  readonly page = signal(1);
  readonly stringifyOption = (option: CatalogOption): string => option.title;

  private readonly appliedFilters = signal<CatalogFilters>({
    genres: [],
    sort: DEFAULT_SORT.value,
  });

  private debounce?: ReturnType<typeof setTimeout>;

  readonly results = resource({
    params: () => ({
      search: this.query(),
      filters: this.appliedFilters(),
      page: this.page(),
    }),
    loader: ({ params }) => {
      const search = params.search.trim();
      const filters = params.filters;
      const query: AnimeQuery = {
        // Берём один элемент сверх страницы: API не возвращает total,
        // поэтому дополнительная запись — единственный точный hasNext.
        limit: PAGE_SIZE + 1,
        offset: (params.page - 1) * PAGE_SIZE,
        sort: filters.sort,
        genres: filters.genres.map(String),
        types: filters.type ? [filters.type] : undefined,
        status: filters.status ? [filters.status] : undefined,
        fromYear: filters.yearFrom,
        toYear: filters.yearTo,
      };

      // Поиск и каталог — разные ручки на бэке: POST /anime/search против
      // GET /anime. Пустая строка означает «просто покажи каталог».
      return search
        ? this.api.search({ ...query, search })
        : this.api.getByQuery(query);
    },
  });

  readonly isSearching = computed(
    () => this.draft().trim() !== this.query().trim()
  );

  readonly pageItems = computed(() =>
    this.results.value()?.slice(0, PAGE_SIZE)
  );

  readonly hasNextPage = computed(
    () => (this.results.value()?.length ?? 0) > PAGE_SIZE
  );

  onInput(value: string): void {
    this.draft.set(value);

    clearTimeout(this.debounce);
    this.debounce = setTimeout(
      () => {
        this.page.set(1);
        this.query.set(value);
      },
      SEARCH_DEBOUNCE_MS
    );
  }

  toggleGenre(value: number, applyImmediately = false): void {
    this.selectedGenres.update((current) => {
      const next = new Set(current);
      next.has(value) ? next.delete(value) : next.add(value);
      return next;
    });

    if (applyImmediately) {
      this.applyFilters();
    }
  }

  isGenreSelected(value: number): boolean {
    return this.selectedGenres().has(value);
  }

  applyFilters(): void {
    this.page.set(1);
    this.appliedFilters.set({
      genres: [...this.selectedGenres()],
      type: this.selectedType()?.value,
      status: this.selectedStatus()?.value,
      yearFrom: this.yearFrom() ?? undefined,
      yearTo: this.yearTo() ?? undefined,
      sort: this.selectedSort().value,
    });
  }

  resetFilters(): void {
    clearTimeout(this.debounce);
    this.draft.set('');
    this.query.set('');
    this.selectedGenres.set(new Set());
    this.selectedType.set(null);
    this.selectedStatus.set(null);
    this.selectedSort.set(DEFAULT_SORT);
    this.yearFrom.set(null);
    this.yearTo.set(null);
    this.applyFilters();
  }

  goToPage(page: number): void {
    if (page < 1 || (page > this.page() && !this.hasNextPage())) {
      return;
    }

    this.page.set(page);
    this.document.querySelector<HTMLElement>('.content')?.scrollTo({
      top: 0,
      behavior: 'smooth',
    });
  }
}
