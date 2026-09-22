import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';
import { TuiButton, TuiDropdown, TuiIcon } from '@taiga-ui/core';

import {
  BookmarkStatus,
  type BookmarkStatusValue,
} from '../../../../api/account.types';
import type { Anime } from '../../../../api/anime.types';
import { BookmarksService } from '../../../../api/bookmarks.service';
import { UserService } from '../../../../api/user.service';
import { SubscribeButtonComponent } from '../subscribe-button/subscribe-button.component';

const STATUSES: readonly { value: BookmarkStatusValue; label: string }[] = [
  { value: BookmarkStatus.Watching, label: 'Смотрю' },
  { value: BookmarkStatus.WillWatch, label: 'Буду смотреть' },
  { value: BookmarkStatus.Watched, label: 'Просмотрено' },
  { value: BookmarkStatus.OnHold, label: 'Отложено' },
  { value: BookmarkStatus.Dropped, label: 'Брошено' },
];

@Component({
  selector: 'app-anime-sidebar',
  imports: [TuiButton, TuiDropdown, TuiIcon, SubscribeButtonComponent],
  templateUrl: './anime-sidebar.component.html',
  styleUrl: './anime-sidebar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnimeSidebarComponent {
  private readonly bookmarks = inject(BookmarksService);
  private readonly user = inject(UserService);
  private readonly router = inject(Router);

  readonly anime = input.required<Anime>();
  readonly statuses = STATUSES;
  readonly saving = signal(false);
  readonly error = signal('');
  readonly bookmark = computed(
    () => this.bookmarks.bookmarksByAnimeId()[this.anime().animeId] ?? null
  );
  readonly currentStatusLabel = computed(
    () =>
      STATUSES.find((status) => status.value === this.bookmark()?.status)
        ?.label ?? 'Добавить в закладки'
  );
  dropdownOpen = false;

  isActive(status: BookmarkStatusValue): boolean {
    return this.bookmark()?.status === status;
  }

  constructor() {
    effect(() => {
      this.anime();
      if (this.user.isAuthenticated()) {
        untracked(() => void this.bookmarks.ensureLoaded().catch(() => undefined));
      }
    });
  }

  async setStatus(status: BookmarkStatusValue): Promise<void> {
    this.dropdownOpen = false;

    if (!this.user.isAuthenticated()) {
      await this.router.navigate(['/login']);
      return;
    }

    if (this.saving()) return;
    this.saving.set(true);
    this.error.set('');

    try {
      const anime = this.anime();
      const current = this.bookmark();
      const common = {
        status,
        totalEpisodes: anime.episodes?.count ?? 0,
        animeStatus: anime.animeStatus.alias,
      };

      if (current) {
        await this.bookmarks.update(anime.animeId, common);
      } else {
        await this.bookmarks.create({
          ...common,
          yumiId: anime.animeId,
          yumiSlug: anime.animeUrl,
          title: anime.title,
          poster: anime.poster,
        });
      }
    } catch (error: unknown) {
      this.error.set(
        error instanceof Error ? error.message : 'Не удалось обновить закладку'
      );
    } finally {
      this.saving.set(false);
    }
  }

  async remove(): Promise<void> {
    this.dropdownOpen = false;

    const bookmark = this.bookmark();
    if (!bookmark || this.saving()) return;

    this.saving.set(true);
    this.error.set('');
    try {
      await this.bookmarks.delete(bookmark.id, bookmark.yumiId);
    } catch (error: unknown) {
      this.error.set(
        error instanceof Error ? error.message : 'Не удалось удалить закладку'
      );
    } finally {
      this.saving.set(false);
    }
  }
}
