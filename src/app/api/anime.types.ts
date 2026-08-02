// Типы зеркалят DTO бэка: anion-go/internal/dto/anime.go.
// Там уже camelCase в json-тегах, поэтому никакой конвертации ключей не нужно —
// в отличие от основного фронта, где этим занимается AxiosService.
//
// Правило: меняется Go-структура — правится этот файл. Ничего не выводим
// «по факту ответа», иначе рассинхрон обнаружится в рантайме.

export interface Rating {
  average: number;
  counters: number;
  kpRating?: number;
  anidubRating?: number;
  myanimelistRating?: number;
  worldartRating?: number;
  shikimoriRating?: number;
}

export interface Poster {
  fullsize: string;
  big: string;
  small: string;
  medium: string;
  huge: string;
  mega: string;
}

export interface Genre {
  id: number;
  title: string;
  url: string;
  alias: string;
}

export interface Episodes {
  aired: number;
  nextDate?: number;
  prevDate?: number;
  count: number;
}

export interface MinAge {
  value: number;
  title: string;
  titleLong: string;
}

export interface AnimeStatus {
  value: number;
  title: string;
  alias: string;
  class: string;
}

export interface AnimeType {
  name: string;
  value: number;
  shortname: string;
}

export interface RemoteIds {
  worldartId: number;
  shikimoriId: number;
  anidubId: number;
  anilibriaAlias: string;
  myanimelistId: number;
  kpId: number;
  worldartType: string;
  srId: number;
}

export interface Top {
  category: number;
  global: number;
}

export interface Schedule {
  description: string;
  poster: Poster;
  title: string;
  animeUrl: string;
  animeId: number;
  episodes: Episodes;
}

export interface Update {
  description: string;
  poster: Poster;
  title: string;
  animeUrl: string;
  animeId: number;
}

export interface AnimeDetails {
  description: string;
  poster: Poster;
  title: string;
  animeUrl: string;
  animeId: number;
  rating: Rating;
  genres: Genre[];
  year: number;
  minAge: MinAge;
  views: number;
  season: number;
  animeStatus: AnimeStatus;
  type: AnimeType;
  remoteIds: RemoteIds;
  top: Top;
  blockedIn: string[];
  episodes?: Episodes;
}

export interface VideoData {
  player: string;
  dubbing: string;
}

export interface VideoSkips {
  opening?: number;
  ending?: number;
}

/** Один эпизод в одном плеере и одной озвучке. */
export interface Video {
  videoId: number;
  data: VideoData;
  number: string;
  date: number;
  /** Готовый URL плеера — именно он уходит в резолвер манифеста на Э2. */
  iframeUrl: string;
  index: number;
  skips: VideoSkips;
}

export interface Studio {
  id: number;
  title: string;
  url: string;
}

export interface Translate {
  value: number;
  title: string;
  href: string;
}

export interface ViewingOrderData {
  text: string;
  id: number;
  index: number;
}

export interface ViewingOrder {
  animeId: number;
  animeUrl: string;
  data: ViewingOrderData;
  poster: Poster;
  title: string;
  animeStatus: AnimeStatus;
  type: AnimeType;
  year: number;
  description: string;
  rating: number;
}

export interface ScreenshotSizes {
  small: string;
  full: string;
}

export interface Screenshot {
  time: number;
  id: number;
  episode: string;
  sizes: ScreenshotSizes;
}

export interface Anime extends AnimeDetails {
  commentsCount: number;
  videos: Video[];
  randomScreenshots: Screenshot[];
  viewingOrder: ViewingOrder[];
  original: string;
  studios: Studio[];
  otherTitles: string[];
  translates: Translate[];
}

export interface AnimeFeed {
  seasonAnime: AnimeDetails[];
  schedule: Schedule[];
  updates: Update[];
}

export interface GenreGroup {
  title: string;
  id: number;
}

export interface GenreFilter {
  title: string;
  href: string;
  value: number;
  moreTitles: string[];
  groupId: number;
}

export interface GenresResponse {
  groups: GenreGroup[];
  genres: GenreFilter[];
}

/**
 * Параметры каталога и поиска.
 * Зеркалит utils.AnimeQueryParams — один и тот же тип обслуживает и
 * `GET /api/anime` (как query string), и `POST /api/anime/search` (как тело).
 */
export interface AnimeQuery {
  minAge?: number;
  maxRatingCounters?: number;
  minRatingAverage?: number;
  requireFields?: string[];
  ids?: number[];
  season?: string[];
  status?: string[];
  translates?: string[];
  types?: string[];
  excludeGenres?: string[];
  genres?: string[];
  maxRating?: number;
  minRating?: number;
  epTo?: number;
  epFrom?: number;
  toYear?: number;
  fromYear?: number;
  sortForward?: boolean;
  sort?: string;
  search?: string;
  offset?: number;
  limit?: number;
}
