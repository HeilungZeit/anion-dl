import { inject, Injectable, signal } from '@angular/core';

import type { RemoteWatchProgress } from './account.types';
import { ApiClient } from './http';

interface RemoteProgressState {
  userId: number | null;
  episodesByAnimeId: Readonly<Record<number, readonly number[]>>;
  loadedAnimeIds: ReadonlySet<number>;
}

const EMPTY_STATE: RemoteProgressState = {
  userId: null,
  episodesByAnimeId: {},
  loadedAnimeIds: new Set<number>(),
};

/** Защищает UI от повторов и некорректных номеров в старых записях. */
export function normalizeRemoteEpisodes(
  episodes: readonly number[]
): number[] {
  return [...new Set(episodes)]
    .filter((episode) => Number.isInteger(episode) && episode >= 1)
    .sort((left, right) => left - right);
}

/** Последняя отмеченная серия, которая действительно есть в текущей озвучке. */
export function latestAvailableWatchedEpisode(
  availableEpisodes: readonly number[],
  watchedEpisodes: ReadonlySet<number>
): number | null {
  let latest: number | null = null;

  for (const episode of availableEpisodes) {
    if (
      watchedEpisodes.has(episode) &&
      (latest === null || episode > latest)
    ) {
      latest = episode;
    }
  }

  return latest;
}

/**
 * Read-only кэш серверных отметок серий.
 *
 * Он намеренно не связан с локальным WatchProgressService: локальный сервис
 * хранит точную позицию и озвучку для продолжения, этот только читает общие
 * для аккаунта номера просмотренных серий с бэка.
 */
@Injectable({ providedIn: 'root' })
export class RemoteWatchProgressService {
  private readonly api = inject(ApiClient);
  private readonly state = signal<RemoteProgressState>(EMPTY_STATE);
  private readonly pending = new Map<number, Promise<void>>();
  private generation = 0;

  episodesFor(animeId: number, userId: number | null): readonly number[] {
    const state = this.state();

    return state.userId === userId && userId !== null
      ? state.episodesByAnimeId[animeId] ?? []
      : [];
  }

  ensureLoaded(animeId: number, userId: number): Promise<void> {
    this.useAccount(userId);

    if (this.state().loadedAnimeIds.has(animeId)) {
      return Promise.resolve();
    }

    const pending = this.pending.get(animeId);
    if (pending) {
      return pending;
    }

    const generation = this.generation;
    const request = this.api
      .get<RemoteWatchProgress | null>(`/watch-progress/${animeId}`)
      .then((progress) => {
        if (generation !== this.generation) {
          return;
        }

        const episodes = normalizeRemoteEpisodes(progress?.episodes ?? []);
        this.state.update((current) => ({
          ...current,
          episodesByAnimeId: {
            ...current.episodesByAnimeId,
            [animeId]: episodes,
          },
          loadedAnimeIds: new Set([...current.loadedAnimeIds, animeId]),
        }));
      })
      .finally(() => {
        if (generation === this.generation) {
          this.pending.delete(animeId);
        }
      });

    this.pending.set(animeId, request);
    return request;
  }

  clear(): void {
    this.generation += 1;
    this.pending.clear();
    this.state.set(EMPTY_STATE);
  }

  private useAccount(userId: number): void {
    if (this.state().userId === userId) {
      return;
    }

    this.generation += 1;
    this.pending.clear();
    this.state.set({
      userId,
      episodesByAnimeId: {},
      loadedAnimeIds: new Set<number>(),
    });
  }
}
