import { inject, Injectable } from '@angular/core';

import { ApiClient } from './http';
import type {
  Anime,
  AnimeFeed,
  AnimeQuery,
  Comment,
  GenresResponse,
} from './anime.types';

/**
 * Сколько живёт запись кэша. Бессрочный кэш держал ленту и страницу тайтла
 * до перезапуска: вышедшая за это время серия не появлялась, пока приложение
 * открыто, а открыто оно, бывает, сутками. Пять минут с запасом защищают
 * от 429 при навигации туда-обратно.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Жанры меняются реже релизов приложения — держим их час. */
const GENRES_TTL_MS = 60 * 60 * 1000;

/**
 * Потолок записей. Каждый набор фильтров каталога — свой ключ, и за долгую
 * сессию их набегали сотни, вместе с полными списками тайтлов в памяти.
 */
const CACHE_LIMIT = 100;

interface CacheEntry {
  promise: Promise<unknown>;
  expiresAt: number;
}

/**
 * Каталожная часть API. Компоненты не ходят в сеть сами.
 *
 * Транспорт, заголовки и разбор ошибок живут в ApiClient — здесь остаётся
 * только то, что специфично для каталога: адреса, сборка query и кэш.
 *
 * Кэш обязателен, а не «на будущее»: на /api бэка висит RateLimiterMiddleware,
 * и без кэша навигация туда-сюда быстро упирается в 429.
 */
@Injectable({ providedIn: 'root' })
export class AnimeService {
  private readonly api = inject(ApiClient);
  private readonly cache = new Map<string, CacheEntry>();

  getFeed(): Promise<AnimeFeed> {
    return this.cached('feed', () => this.api.get<AnimeFeed>('/anime/feed'));
  }

  getById(id: string | number): Promise<Anime> {
    return this.cached(`anime:${id}`, () =>
      this.api.get<Anime>(`/anime/${id}`)
    );
  }

  getGenres(): Promise<GenresResponse> {
    return this.cached(
      'genres',
      () => this.api.get<GenresResponse>('/anime/genres'),
      GENRES_TTL_MS
    );
  }

  /** Каталог с фильтрами. Пустой запрос — просто список по сортировке. */
  getByQuery(query: AnimeQuery): Promise<Anime[]> {
    const qs = this.toQueryString(query);
    return this.cached(`catalog:${qs}`, () =>
      this.api.get<Anime[]>(`/anime?${qs}`)
    );
  }

  getRecommendations(id: string | number): Promise<Anime[]> {
    return this.cached(`recommendations:${id}`, () =>
      this.api.get<Anime[]>(`/anime/${id}/recommendations`)
    );
  }

  /**
   * Комментарии к тайтлу. Не кэшируются: страница листается по offset, и
   * каждый её кусок пришлось бы держать отдельным ключом ради одного прохода.
   */
  getComments(
    id: string | number,
    query: CommentsQuery
  ): Promise<Comment[]> {
    const qs = new URLSearchParams({
      limit: String(query.limit),
      offset: String(query.offset),
      sort: query.sort,
    });

    return this.api.get<Comment[]>(`/anime/${id}/comments?${qs.toString()}`);
  }

  getCommentReplies(parentId: number, skip = 0): Promise<Comment[]> {
    return this.api.get<Comment[]>(
      `/anime/comments/replies/${parentId}?skip=${skip}`
    );
  }

  /**
   * Поиск. Отдельный метод, потому что на бэке это POST с телом, а не query.
   * Не кэшируем — строка меняется на каждое нажатие.
   */
  search(query: AnimeQuery): Promise<Anime[]> {
    return this.api.post<Anime[]>('/anime/search', query);
  }

  private cached<T>(
    key: string,
    load: () => Promise<T>,
    ttlMs = CACHE_TTL_MS
  ): Promise<T> {
    const now = Date.now();
    const hit = this.cache.get(key);

    if (hit && hit.expiresAt > now) {
      // Map помнит порядок вставки: перекладывая ключ в конец, получаем LRU —
      // вытесняется то, к чему дольше всего не обращались.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.promise as Promise<T>;
    }

    // Промис кладётся в кэш до резолва — это склеивает параллельные запросы
    // одного ключа в один поход в сеть. Упавший промис выбрасывается, иначе
    // единичная сетевая ошибка залипла бы навсегда. Сверка по ссылке нужна,
    // чтобы опоздавшая ошибка не стёрла уже более свежую запись.
    const entry: CacheEntry = { promise: Promise.resolve(), expiresAt: now + ttlMs };
    const pending = load().catch((error: unknown) => {
      if (this.cache.get(key) === entry) {
        this.cache.delete(key);
      }
      throw error;
    });
    entry.promise = pending;

    this.cache.delete(key);
    this.cache.set(key, entry);
    this.evictOverflow();

    return pending;
  }

  private evictOverflow(): void {
    for (const key of this.cache.keys()) {
      if (this.cache.size <= CACHE_LIMIT) {
        return;
      }

      this.cache.delete(key);
    }
  }

  private toQueryString(query: AnimeQuery): string {
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }

      // Массивы бэк ждёт одной строкой через запятую: parseStringArray
      // в internal/utils/url-params.go делает strings.Split(val, ",").
      // Повторяющиеся ключи он бы не увидел — c.Query вернёт только первый.
      if (Array.isArray(value)) {
        if (value.length > 0) {
          params.set(key, value.join(','));
        }
        continue;
      }

      params.set(key, String(value));
    }

    return params.toString();
  }
}

export interface CommentsQuery {
  limit: number;
  offset: number;
  sort: 'new' | 'old' | 'nice';
}
