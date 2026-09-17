import { ChangeDetectionStrategy, Component, computed, effect, inject, signal,  untracked } from '@angular/core';
import { RemoveCharactersPipe } from '../../pipes/removeChars.pipe';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { TuiButton, TuiDataList, TuiIcon, TuiLoader, TuiTextfield } from '@taiga-ui/core';
import { TuiBadge, TuiChevron, TuiSelect, TuiTabs } from '@taiga-ui/kit';
import type { AnimeDetails as AnimeDetailsI } from '../../api/anime.types';
import { BookmarkStatus } from '../../api/account.types';
import { AnimeService } from '../../api/anime.service';
import { BookmarksService } from '../../api/bookmarks.service';
import { UserService } from '../../api/user.service';

@Component({
  selector: 'app-seasons',
  imports: [DatePipe, RemoveCharactersPipe, FormsModule, RouterLink, TuiButton, TuiDataList, TuiIcon, TuiLoader, TuiTextfield, TuiBadge, TuiChevron, TuiSelect, TuiTabs],
  templateUrl: './seasons.component.html',
  styleUrl: './seasons.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SeasonsComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(AnimeService);
  private readonly bookmarksApi = inject(BookmarksService);
  readonly bookmarks = inject(BookmarksService);
  readonly user = inject(UserService);
  readonly current = { year: new Date().getFullYear(), season: ['winter', 'spring', 'summer', 'fall'][Math.floor(new Date().getMonth() / 3)] };
  readonly now = Date.now();
  readonly compactNumber = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });
  readonly fullNumber = new Intl.NumberFormat('ru-RU');
  readonly seasons = [{ value: 'winter', title: 'Зима' }, { value: 'spring', title: 'Весна' }, { value: 'summer', title: 'Лето' }, { value: 'fall', title: 'Осень' }];
  readonly seasonIcons = ['@tui.snowflake', '@tui.flower-2', '@tui.sun', '@tui.leaf'];
  readonly years = Array.from({ length: this.current.year + 2 - 1965 }, (_, i) => this.current.year + 1 - i);
  private readonly params = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });
  readonly year = computed(() => {
    const value = Number(this.params().get('year'));
    return this.years.includes(value) ? value : this.current.year;
  });
  readonly seasonIndex = computed(() => {
    const index = this.seasons.findIndex(s => s.value === this.params().get('season'));
    return index < 0 ? this.seasons.findIndex(s => s.value === this.current.season) : index;
  });
  readonly label = computed(() => `${this.seasons[this.seasonIndex()].title} ${this.year()}`);
  readonly isCurrent = computed(() => this.year() === this.current.year && this.seasons[this.seasonIndex()].value === this.current.season);
  private readonly pages = signal<Record<string, { items: AnimeDetailsI[]; offset: number; hasMore: boolean; loading: boolean; error: string }>>({});
  private readonly seasonData = computed(() => this.pages()[this.label()] ?? { items: [], offset: 0, hasMore: true, loading: false, error: '' });
  readonly items = computed(() => this.seasonData().items);
  readonly loading = computed(() => this.seasonData().loading);
  readonly error = computed(() => this.seasonData().error);
  readonly bookmarkError = signal('');
  readonly saving = signal<ReadonlySet<number>>(new Set());
  readonly hasMore = computed(() => this.seasonData().hasMore);
  readonly path = (id: number, _slug: string) => ['/anime', id];

  constructor() {
    effect(() => {
      const key = this.label();
      untracked(() => { if (!this.pages()[key]) void this.loadMore(); });
    });
    effect(() => {
      if (this.user.isAuthenticated()) untracked(() => { void this.bookmarks.ensureLoaded().catch(() => this.bookmarkError.set('Не удалось загрузить закладки.')); });
    });
  }

  select(year: number, index: number): void {
    if (!this.years.includes(year) || !this.seasons[index]) return;
    void this.router.navigate(['/seasons'], { queryParams: { year, season: this.seasons[index].value } });
  }

  adjacent(offset: number): void {
    const index = this.seasonIndex() + offset;
    this.select(this.year() + Math.floor(index / 4), (index + 4) % 4);
  }

  goToCurrent(): void {
    this.select(this.current.year, this.seasons.findIndex(s => s.value === this.current.season));
  }

  async loadMore(): Promise<void> {
    const key = this.label();
    const year = this.year();
    const season = this.seasons[this.seasonIndex()].value;
    let entry = this.seasonData();
    if (entry.loading || !entry.hasMore) return;
    const update = (changes: Partial<typeof entry>) => {
      entry = { ...entry, ...changes };
      this.pages.update(pages => ({ ...pages, [key]: entry }));
    };
    update({ loading: true, error: '' });
    try {
      let added = 0;
      do {
        const page = await this.api.getByQuery({ season: [season], fromYear: year, toYear: year, sort: 'views', sortForward: false, offset: entry.offset, limit: 24 });
        const ids = new Set(entry.items.map(anime => anime.animeId));
        const visible = page.filter(anime => {
          if ((anime.rating?.average && anime.rating.average <= 5) || ids.has(anime.animeId)) return false;
          ids.add(anime.animeId);
          return true;
        });
        added += visible.length;
        update({ items: [...entry.items, ...visible], offset: entry.offset + page.length, hasMore: page.length === 24 });
      } while (entry.hasMore && added < 24);
    } catch { update({ error: 'Не удалось загрузить аниме. Попробуйте ещё раз.' }); }
    finally { update({ loading: false }); }
  }

  shortAge(age: string | undefined): string {
    const label = age?.split('(')[0].trim() ?? '';
    return /^unknown$/i.test(label) ? '' : label;
  }

  isBookmarked(anime: AnimeDetailsI): boolean {
    return !!this.bookmarks.getBookmark(Number(anime.animeId));
  }

  async bookmark(anime: AnimeDetailsI): Promise<void> {
    if (!this.user.isAuthenticated()) { void this.router.navigate(['/login']); return; }
    if (this.saving().has(anime.animeId)) return;
    this.saving.update(ids => new Set([...ids, anime.animeId]));
    this.bookmarkError.set('');
    try {
      await this.bookmarks.ensureLoaded();
      if (!this.bookmarks.isLoaded()) throw new Error('Bookmarks unavailable');
      if (this.isBookmarked(anime)) return;
      await this.bookmarksApi.create({ yumiId: Number(anime.animeId), yumiSlug: anime.animeUrl, title: anime.title, poster: anime.poster, status: BookmarkStatus.WillWatch, totalEpisodes: anime.episodes?.count || 0, animeStatus: anime.animeStatus?.alias });
    } catch {
      this.bookmarkError.set('Не удалось добавить в закладки. Попробуйте ещё раз.');
    } finally {
      this.saving.update(ids => new Set([...ids].filter(id => id !== anime.animeId)));
    }
  }
}
