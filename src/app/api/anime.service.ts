import { inject, Injectable } from '@angular/core';
import { fetch } from '@tauri-apps/plugin-http';

import {
  API_BASE_URL,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
} from './api.config';
import type {
  Anime,
  AnimeFeed,
  AnimeQuery,
  GenresResponse,
} from './anime.types';

/**
 * Единственная точка входа в API. Компоненты не ходят в сеть сами.
 *
 * Используется fetch из tauri-plugin-http, а не браузерный: запрос уходит через
 * Rust и потому не подчиняется браузерной CORS-политике. Доступный origin всё
 * равно должен быть явно разрешён в Tauri capabilities.
 *
 * Кэш здесь обязателен, а не «на будущее»: на /api бэка висит RateLimiterMiddleware,
 * и без кэша навигация туда-сюда быстро упирается в 429.
 */
@Injectable({ providedIn: 'root' })
export class AnimeService {
  private readonly baseUrl = inject(API_BASE_URL);
  private readonly cache = new Map<string, Promise<unknown>>();

  getFeed(): Promise<AnimeFeed> {
    return this.cached('feed', () => this.get<AnimeFeed>('/anime/feed'));
  }

  getById(id: string | number): Promise<Anime> {
    return this.cached(`anime:${id}`, () => this.get<Anime>(`/anime/${id}`));
  }

  getGenres(): Promise<GenresResponse> {
    return this.cached('genres', () =>
      this.get<GenresResponse>('/anime/genres')
    );
  }

  /** Каталог с фильтрами. Пустой запрос — просто список по сортировке. */
  getByQuery(query: AnimeQuery): Promise<Anime[]> {
    const qs = this.toQueryString(query);
    return this.cached(`catalog:${qs}`, () => this.get<Anime[]>(`/anime?${qs}`));
  }

  /**
   * Поиск. Отдельный метод, потому что на бэке это POST с телом, а не query.
   * Не кэшируем — строка меняется на каждое нажатие.
   */
  async search(query: AnimeQuery): Promise<Anime[]> {
    const response = await fetch(`${this.baseUrl}/anime/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [CLIENT_HEADER]: CLIENT_HEADER_VALUE,
      },
      body: JSON.stringify(query),
    });

    if (!response.ok) {
      throw new Error(this.describeFailure(response, '/anime/search'));
    }

    return response.json() as Promise<Anime[]>;
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE },
    });

    if (!response.ok) {
      throw new Error(this.describeFailure(response, path));
    }

    return response.json() as Promise<T>;
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit) {
      return hit as Promise<T>;
    }

    // Промис кладётся в кэш до резолва — это склеивает параллельные запросы
    // одного ключа в один поход в сеть. Упавший промис выбрасывается, иначе
    // единичная сетевая ошибка залипла бы навсегда.
    const pending = load().catch((error: unknown) => {
      this.cache.delete(key);
      throw error;
    });

    this.cache.set(key, pending);
    return pending;
  }

  private describeFailure(response: Response, path: string): string {
    // Vercel отдаёт свой JS-челлендж тоже под кодом 429, и раньше это
    // выглядело как рейт-лимит бэка — на самом деле запрос до бэка не доходит
    // вовсе. Отличаем по заголовку, который ставит edge.
    if (response.headers.get('x-vercel-mitigated')) {
      return (
        'Запрос заблокирован защитой Vercel (Attack Challenge Mode): она требует ' +
        'выполнить JS-проверку, чего приложение сделать не может. Отключите ' +
        'челлендж или добавьте правило обхода для API.'
      );
    }

    if (response.status === 429) {
      return 'Бэк ограничил частоту запросов (429). Подождите немного.';
    }

    return `Запрос ${path} завершился со статусом ${response.status}`;
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
