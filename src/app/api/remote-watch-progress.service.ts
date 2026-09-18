import { inject, Injectable, signal } from '@angular/core';

import type { RemoteWatchProgress } from './account.types';
import { ApiClient } from './http';

interface RemoteProgressState {
  userId: number | null;
  episodesByAnimeId: Readonly<Record<number, readonly number[]>>;
  loadedAnimeIds: ReadonlySet<number>;
}

/**
 * Отметки уходят пачкой, как на фронте: перемотка туда-обратно и повторный
 * play не должны превращаться в серию запросов.
 */
const FLUSH_DELAY_MS = 2000;

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

/** Добавляет серию к отсортированному списку без повторов. */
export function withEpisode(
  episodes: readonly number[],
  episode: number
): number[] {
  return normalizeRemoteEpisodes([...episodes, episode]);
}

/**
 * Серверные отметки просмотренных серий: чтение и запись.
 *
 * Он намеренно не связан с локальным WatchProgressService: локальный сервис
 * хранит точную позицию и озвучку для продолжения, этот работает только с
 * общими для аккаунта номерами серий. Запись повторяет фронт
 * (`anion/src/app/store/watch-progress.store.ts`): `PUT /watch-progress/:id`
 * с номерами серий, сервер объединяет их с уже отмеченными, поэтому повтор
 * после обрыва ничего не портит.
 */
@Injectable({ providedIn: 'root' })
export class RemoteWatchProgressService {
  private readonly api = inject(ApiClient);
  private readonly state = signal<RemoteProgressState>(EMPTY_STATE);
  private readonly pending = new Map<number, Promise<void>>();
  /** Отметки, которые ещё не ушли на сервер: animeId → номера серий. */
  private readonly unsent = new Map<number, Set<number>>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  episodesFor(animeId: number, userId: number | null): readonly number[] {
    const state = this.state();

    return state.userId === userId && userId !== null
      ? state.episodesByAnimeId[animeId] ?? []
      : [];
  }

  ensureLoaded(animeId: number, userId: number): Promise<void> {
    this.useAccount(userId);

    // Открытие тайтла — удобный повод дослать то, что не ушло из-за сети.
    if (this.unsent.size > 0 && this.flushTimer === null) {
      void this.flush();
    }

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

        // Серия могла быть отмечена, пока ехал ответ: он её ещё не содержит,
        // поэтому склеиваем, а не затираем.
        const episodes = normalizeRemoteEpisodes([
          ...(progress?.episodes ?? []),
          ...(this.state().episodesByAnimeId[animeId] ?? []),
        ]);
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

  /** Отметить серию просмотренной: сразу в UI, на сервер — с дебаунсом. */
  markWatched(animeId: number, userId: number, episode: number): void {
    if (!Number.isInteger(episode) || episode < 1) {
      return;
    }

    this.useAccount(userId);

    const current = this.state().episodesByAnimeId[animeId] ?? [];
    if (current.includes(episode)) {
      return;
    }

    this.state.update((state) => ({
      ...state,
      episodesByAnimeId: {
        ...state.episodesByAnimeId,
        [animeId]: withEpisode(current, episode),
      },
    }));

    const queued = this.unsent.get(animeId) ?? new Set<number>();
    this.unsent.set(animeId, queued.add(episode));
    this.scheduleFlush();
  }

  /**
   * Досылка накопленного. Неудачная отметка возвращается в очередь и уйдёт
   * со следующей: плеер стримит с Kodik, так что без сети новых отметок не
   * будет, а при восстановлении связи старые догонят их.
   */
  async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const generation = this.generation;
    const batches = [...this.unsent.entries()];
    this.unsent.clear();

    for (const [animeId, episodes] of batches) {
      try {
        await this.api.put<RemoteWatchProgress>(`/watch-progress/${animeId}`, {
          episodes: [...episodes].sort((left, right) => left - right),
        });
      } catch {
        // Отметки чужого аккаунта после выхода досылать нельзя.
        if (generation !== this.generation) {
          continue;
        }

        const queued = this.unsent.get(animeId) ?? new Set<number>();
        this.unsent.set(animeId, new Set([...queued, ...episodes]));
      }
    }
  }

  clear(): void {
    this.generation += 1;
    this.pending.clear();
    this.dropUnsent();
    this.state.set(EMPTY_STATE);
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DELAY_MS);
  }

  private dropUnsent(): void {
    this.unsent.clear();
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private useAccount(userId: number): void {
    if (this.state().userId === userId) {
      return;
    }

    this.generation += 1;
    this.pending.clear();
    this.dropUnsent();
    this.state.set({
      userId,
      episodesByAnimeId: {},
      loadedAnimeIds: new Set<number>(),
    });
  }
}
