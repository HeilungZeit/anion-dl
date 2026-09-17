import type { AnimeStatus, Poster } from './anime.types';

/**
 * Типы аккаунта, закладок и календаря. Формы сняты с DTO бэка
 * (`anion-go/internal/dto/user.go`, `bookmarks.go`, `calendar.go`), а не с
 * интерфейсов веб-фронта: фронт местами описывает поля неполно.
 */

export interface UserDevice {
  platform: 'desktop' | 'mobile' | 'tv';
  title: string;
  location?: string;
  ip?: string;
  lastSeenAt: string;
}

export interface UserResponse {
  id: number;
  role?: string;
  email: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
  devices?: UserDevice[];
}

/**
 * Ответ на вход и регистрацию. Отличается от GetUserResponse полем `session`:
 * бэк кладёт идентификатор сессии и в тело, и в куку. Приложению нужна только
 * кука — её возит cookie jar плагина, а тело служит признаком успеха.
 */
export interface LoginResponse extends UserResponse {
  session: string;
}

export interface LoginPayload {
  /** Бэк принимает вход либо по email, либо по username — одно из двух. */
  email?: string;
  username?: string;
  password: string;
  /** Капча включается только после нескольких неудачных попыток. */
  captchaToken?: string;
  captchaAnswer?: number;
}

/** Арифметическая задача для входа: `question` вида «7 + 5». */
export interface Challenge {
  question: string;
  token: string;
  expiresAt: string;
}

export const BookmarkStatus = {
  Watching: 'watching',
  WillWatch: 'will_watch',
  Watched: 'watched',
  OnHold: 'on_hold',
  Dropped: 'dropped',
} as const;

export type BookmarkStatusValue =
  (typeof BookmarkStatus)[keyof typeof BookmarkStatus];

export type BookmarkSort =
  | 'created_desc'
  | 'created_asc'
  | 'title_asc'
  | 'title_desc';

export interface Bookmark {
  id: string;
  userId: number;
  status: BookmarkStatusValue;
  watchedEpisodes: number;
  totalEpisodes: number;
  yumiId: number;
  yumiSlug: string;
  title: string;
  poster: Poster;
  animeStatus: string;
  estimatedEndDate?: string;
  shikimoriId?: number;
}

export interface BookmarksResponse {
  watching: Bookmark[];
  willWatch: Bookmark[];
  watched: Bookmark[];
  onHold: Bookmark[];
  dropped: Bookmark[];
}

export type BookmarkCounts = Record<BookmarkStatusValue, number>;

export interface BookmarksPageResponse {
  items: Bookmark[];
  status: BookmarkStatusValue;
  sort: BookmarkSort;
  counts: BookmarkCounts;
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

export interface BookmarksPageQuery {
  status: BookmarkStatusValue;
  page: number;
  pageSize: number;
  sort: BookmarkSort;
}

export interface CreateBookmarkPayload {
  yumiId: number;
  yumiSlug: string;
  title: string;
  poster: Poster;
  status: BookmarkStatusValue;
  totalEpisodes?: number;
  animeStatus?: string;
}

/**
 * Правка закладки.
 *
 * Поля `watchedEpisodes` здесь намеренно нет: счётчик выводит сервер из
 * watch-progress, а устаревшее число с десктопа урезало бы прогресс сайта.
 * Ровно эти грабли чинили для ТВ (anion-tv/docs/watch-progress-sync.md, Э0).
 */
export interface UpdateBookmarkPayload {
  status: BookmarkStatusValue;
  totalEpisodes?: number;
  animeStatus?: string;
}

/** Даты — unix-секунды. */
export interface CalendarEntry {
  animeId: number;
  title: string;
  poster: Poster;
  animeUrl: string;
  animeStatus: AnimeStatus;
  nextEpisodeDate?: number;
  prevEpisodeDate?: number;
  episodesAired?: number;
  episodesTotal?: number;
  bookmarkStatus: string;
}

/**
 * Серверные отметки просмотренных серий.
 *
 * Это отдельный поток данных от локального WatchRecord: сервер не знает
 * позицию внутри серии и озвучку, а приложение не отправляет ему локальные
 * тики плеера.
 */
export interface RemoteWatchProgress {
  animeId: number;
  episodes: number[];
  maxEpisode: number;
  updatedAt: string;
}
