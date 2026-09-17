import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  resource,
  signal,
  untracked,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TuiButton, TuiDataList, TuiIcon, TuiTextfield } from '@taiga-ui/core';
import { TuiChevron, TuiPagination, TuiSelect } from '@taiga-ui/kit';
import { BookmarkTileComponent } from '../../components/bookmark-tile/bookmark-tile.component';
import type { Bookmark, BookmarkCounts } from '../../api/account.types';

import {
  BookmarkStatus,
  type BookmarkSort,
  type BookmarkStatusValue,
} from '../../api/account.types';
import { BookmarksService } from '../../api/bookmarks.service';
import { UserService } from '../../api/user.service';

const PAGE_SIZE = 24;
const DEFAULT_SORT: BookmarkSort = 'created_desc';
const VALID_SORTS = new Set<BookmarkSort>([
  'created_desc',
  'created_asc',
  'title_asc',
  'title_desc',
]);

interface BookmarkTab {
  status: BookmarkStatusValue;
  label: string;
  key: string;
  icon: string;
}

const TABS: readonly BookmarkTab[] = [
  { key: 'watching', icon: '@tui.play', status: BookmarkStatus.Watching, label: 'Смотрю' },
  { key: 'will_watch', icon: '@tui.clock', status: BookmarkStatus.WillWatch, label: 'Буду смотреть' },
  { key: 'watched', icon: '@tui.check', status: BookmarkStatus.Watched, label: 'Просмотрено' },
  { key: 'on_hold', icon: '@tui.pause', status: BookmarkStatus.OnHold, label: 'Отложено' },
  { key: 'dropped', icon: '@tui.x', status: BookmarkStatus.Dropped, label: 'Брошено' },
];

@Component({
  selector: 'app-bookmarks',
  imports: [RouterLink, FormsModule, TuiButton, TuiIcon, TuiTextfield, TuiChevron, TuiDataList, TuiSelect, TuiPagination, BookmarkTileComponent],
  templateUrl: './bookmarks.component.html',
  styleUrl: './bookmarks.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BookmarksComponent {
  private readonly api = inject(BookmarksService);
  private readonly user = inject(UserService);
  private readonly router = inject(Router);

  readonly status = input<string>(BookmarkStatus.Watching);
  readonly page = input<string>('1');
  readonly sort = input<string>(DEFAULT_SORT);
  readonly tabs = TABS;

  readonly activeStatus = computed<BookmarkStatusValue>(() => {
    const requested = this.status() as BookmarkStatusValue;
    return TABS.some((tab) => tab.status === requested)
      ? requested
      : BookmarkStatus.Watching;
  });
  readonly activeLabel = computed(
    () => TABS.find((tab) => tab.status === this.activeStatus())?.label ?? ''
  );

  readonly pageNumber = computed(() => {
    const value = Number(this.page());
    return Number.isInteger(value) && value > 0 ? value : 1;
  });

  readonly activeSort = computed<BookmarkSort>(() => {
    const value = this.sort() as BookmarkSort;
    return VALID_SORTS.has(value) ? value : DEFAULT_SORT;
  });

  readonly bookmarks = resource({
    params: () =>
      this.user.isAuthenticated()
        ? {
            status: this.activeStatus(),
            page: this.pageNumber(),
            sort: this.activeSort(),
          }
        : undefined,
    loader: ({ params }) =>
      this.api.getPage({ ...params, pageSize: PAGE_SIZE }),
  });

  readonly counts = linkedSignal<BookmarkCounts | undefined, BookmarkCounts | undefined>({
    source: () => this.bookmarks.hasValue() ? this.bookmarks.value().counts : undefined,
    computation: (value, previous) => value ?? previous?.value,
  });
  readonly mutationError = signal('');
  readonly totalCount = computed(() => Object.values(this.counts() ?? {}).reduce((sum, count) => sum + count, 0));
  readonly skeletonTabs = [1, 2, 3, 4, 5];
  readonly skeletonCards = Array.from({ length: 12 }, (_, i) => i);
  readonly sortOptions = [
    { value: 'created_desc', label: 'Сначала новые' },
    { value: 'created_asc', label: 'Сначала старые' },
    { value: 'title_asc', label: 'По названию А–Я' },
    { value: 'title_desc', label: 'По названию Я–А' },
  ];
  readonly stringifySort = (value: string): string => this.sortOptions.find(option => option.value === value)?.label ?? value;
  readonly errorMessage = computed(() => this.mutationError() || this.bookmarks.error()?.message || '');
  onPageChange(index: number): void {
    void this.router.navigate([], { queryParams: { page: index ? index + 1 : null }, queryParamsHandling: 'merge' });
  }
  bookmarksCountLabel(): string {
    const count = this.bookmarks.hasValue() ? this.bookmarks.value().pagination.totalItems : 0;
    return count % 10 === 1 && count % 100 !== 11 ? 'тайтл' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'тайтла' : 'тайтлов';
  }
  async onUpdateBookmark(data: { bookmark: Bookmark; status: BookmarkStatusValue; animeStatus: string }): Promise<void> {
    this.mutationError.set('');
    try {
      await this.api.update(data.bookmark.yumiId, { status: data.status, animeStatus: data.animeStatus });
      this.bookmarks.reload();
    } catch { this.mutationError.set('Не удалось обновить закладку. Попробуйте ещё раз.'); }
  }

  constructor() {
    effect(() => {
      if (this.user.isInitialized() && !this.user.isAuthenticated()) {
        untracked(() => void this.router.navigate(['/login']));
      }
    });
  }

  tabCount(status: BookmarkStatusValue): number {
    return this.counts()?.[status] ?? 0;
  }

  onSortChange(sort: string): void {
    void this.router.navigate([], {
      queryParams: { sort: sort === DEFAULT_SORT ? null : sort, page: null },
      queryParamsHandling: 'merge',
    });
  }

  async remove(id: string, animeId: number): Promise<void> {
    this.mutationError.set('');
    try {
      await this.api.delete(id, animeId);
      this.bookmarks.reload();
    } catch { this.mutationError.set('Не удалось удалить закладку. Попробуйте ещё раз.'); }
  }
}
