import { inject, Injectable, signal } from '@angular/core';

import type {
  Bookmark,
  BookmarksPageQuery,
  BookmarksPageResponse,
  BookmarksResponse,
  CalendarEntry,
  CreateBookmarkPayload,
  UpdateBookmarkPayload,
} from './account.types';
import { ApiClient } from './http';

export function bookmarksToMap(
  response: BookmarksResponse
): Record<number, Bookmark> {
  const result: Record<number, Bookmark> = {};

  for (const group of Object.values(response)) {
    for (const bookmark of group) {
      result[bookmark.yumiId] = bookmark;
    }
  }

  return result;
}

/** Явная сборка тела не позволяет случайно протащить watchedEpisodes. */
export function createBookmarkBody(
  payload: CreateBookmarkPayload
): CreateBookmarkPayload {
  return {
    yumiId: payload.yumiId,
    yumiSlug: payload.yumiSlug,
    title: payload.title,
    poster: payload.poster,
    status: payload.status,
    totalEpisodes: payload.totalEpisodes,
    animeStatus: payload.animeStatus,
  };
}

export function updateBookmarkBody(
  payload: UpdateBookmarkPayload
): UpdateBookmarkPayload {
  return {
    status: payload.status,
    totalEpisodes: payload.totalEpisodes,
    animeStatus: payload.animeStatus,
  };
}

@Injectable({ providedIn: 'root' })
export class BookmarksService {
  private readonly api = inject(ApiClient);
  private readonly state = signal<Record<number, Bookmark>>({});
  private readonly loaded = signal(false);
  private pendingLoad: Promise<void> | null = null;

  readonly bookmarksByAnimeId = this.state.asReadonly();
  readonly isLoaded = this.loaded.asReadonly();

  getBookmark(animeId: number): Bookmark | null {
    return this.state()[animeId] ?? null;
  }

  ensureLoaded(): Promise<void> {
    if (this.loaded()) {
      return Promise.resolve();
    }

    if (this.pendingLoad) {
      return this.pendingLoad;
    }

    this.pendingLoad = this.api
      .get<BookmarksResponse>('/bookmarks')
      .then((response) => {
        this.state.set(bookmarksToMap(response));
        this.loaded.set(true);
      })
      .finally(() => {
        this.pendingLoad = null;
      });

    return this.pendingLoad;
  }

  getPage(query: BookmarksPageQuery): Promise<BookmarksPageResponse> {
    const params = new URLSearchParams({
      status: query.status,
      page: String(query.page),
      pageSize: String(query.pageSize),
      sort: query.sort,
    });

    return this.api.get<BookmarksPageResponse>(`/bookmarks?${params}`);
  }

  async create(payload: CreateBookmarkPayload): Promise<BookmarksResponse> {
    const response = await this.api.post<BookmarksResponse>(
      '/bookmarks',
      createBookmarkBody(payload)
    );
    this.state.set(bookmarksToMap(response));
    this.loaded.set(true);
    return response;
  }

  async update(
    animeId: number,
    payload: UpdateBookmarkPayload
  ): Promise<Bookmark> {
    const bookmark = await this.api.put<Bookmark>(
      `/bookmarks/${animeId}`,
      updateBookmarkBody(payload)
    );
    this.state.update((current) => ({ ...current, [animeId]: bookmark }));
    return bookmark;
  }

  async delete(bookmarkId: string, animeId: number): Promise<void> {
    const response = await this.api.delete<BookmarksResponse>(
      `/bookmarks/${bookmarkId}`
    );
    this.state.set(bookmarksToMap(response));
    this.loaded.set(true);

    // Защита на случай старого бэка, который вернул состояние до удаления.
    this.state.update((current) => {
      const next = { ...current };
      delete next[animeId];
      return next;
    });
  }

  getCalendar(): Promise<CalendarEntry[]> {
    return this.api.get<CalendarEntry[]>('/bookmarks/calendar');
  }

  clear(): void {
    this.state.set({});
    this.loaded.set(false);
    this.pendingLoad = null;
  }
}
