import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  resource,
  untracked,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TuiLoader } from '@taiga-ui/core';

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
}

const TABS: readonly BookmarkTab[] = [
  { status: BookmarkStatus.Watching, label: 'Смотрю' },
  { status: BookmarkStatus.WillWatch, label: 'Буду смотреть' },
  { status: BookmarkStatus.Watched, label: 'Просмотрено' },
  { status: BookmarkStatus.OnHold, label: 'Отложено' },
  { status: BookmarkStatus.Dropped, label: 'Брошено' },
];

@Component({
  selector: 'app-bookmarks',
  imports: [RouterLink, TuiLoader],
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

  constructor() {
    effect(() => {
      if (this.user.isInitialized() && !this.user.isAuthenticated()) {
        untracked(() => void this.router.navigate(['/login']));
      }
    });
  }

  tabCount(status: BookmarkStatusValue): number {
    return this.bookmarks.value()?.counts[status] ?? 0;
  }

  changeSort(event: Event): void {
    const sort = (event.target as HTMLSelectElement).value;
    void this.router.navigate([], {
      queryParams: { sort: sort === DEFAULT_SORT ? null : sort, page: null },
      queryParamsHandling: 'merge',
    });
  }

  async remove(id: string, animeId: number): Promise<void> {
    await this.api.delete(id, animeId);
    this.bookmarks.reload();
  }
}
