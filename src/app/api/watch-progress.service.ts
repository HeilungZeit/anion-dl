import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LazyStore } from '@tauri-apps/plugin-store';

import type { Poster } from './anime.types';
import { ApiClient } from './http';
import { UserService } from './user.service';
import { sourceOfDubbing } from './video-source';

const STORE_FILE = 'watch-progress.json';
/** Наблюдение плеера, разосланное остальным окнам. */
const SHARE_EVENT = 'watch-progress://update';
const RECORDS_KEY = 'records';
const SAVE_DEBOUNCE_MS = 2_000;
const MAX_RECORDS = 500;
const MAX_CONTINUE_WATCHING = 10;

export const FINISHED_FRACTION = 0.9;

export interface WatchRecord {
  animeId: number;
  title: string;
  poster: Poster;
  episode: number;
  dubbing: string;
  positionSecs: number;
  durationSecs: number;
  finished: boolean;
  updatedAt: number;
  /**
   * Серия последняя из вышедших в своей озвучке. Досмотренная последняя серия
   * убирает тайтл из «Продолжить смотреть»: предлагать дальше нечего. Плеер
   * скачанных серий полного списка не знает и поле не заполняет.
   */
  lastEpisode?: boolean;
  /**
   * Наблюдение вошедшего, ещё не ушедшее на сервер. Уходит на flush (пауза,
   * конец, смена серии, закрытие окна), а не дошедшее — досылается при
   * следующем запуске. У гостя не ставится никогда.
   */
  unsent?: boolean;
}

/**
 * Позиция в аккаунте (`/playback-position`): одна запись на тайтл, последняя
 * серия, общая с сайтом. Решения — anion-go/docs/playback-position.md.
 */
export interface ServerPlaybackPosition {
  animeId: number;
  episode: number;
  dubbing: string;
  player: string;
  positionSecs: number | null;
  durationSecs: number | null;
  finished: boolean;
  lastEpisode?: boolean;
  title: string;
  animeUrl: string;
  poster: Partial<Poster>;
  observedAt: string;
  upNext?: boolean;
}

/** Карточка ряда «Продолжить смотреть». */
export interface ContinueWatchingItem extends WatchRecord {
  /**
   * Последняя серия досмотрена, карточка ведёт на следующую с начала:
   * `episode` уже увеличен, `positionSecs` обнулена.
   */
  upNext: boolean;
}

export type WatchProgressUpdate = Omit<
  WatchRecord,
  'finished' | 'updatedAt'
>;

/**
 * Одно наблюдение, разосланное по окнам.
 *
 * Передаётся именно обновление, а не снимок истории: снимок памяти одного окна
 * затёр бы записи, сделанные в другом.
 */
interface SharedWatchProgress {
  /** Ярлык окна-источника: собственное эхо игнорируется. */
  source: string;
  update: StoredWatchProgressUpdate;
  updatedAt: number;
}

type StoredWatchProgressUpdate = WatchProgressUpdate &
  Partial<Pick<WatchRecord, 'finished' | 'unsent'>>;

function byFreshness(left: WatchRecord, right: WatchRecord): number {
  return right.updatedAt - left.updatedAt;
}

function sameEpisode(
  record: WatchRecord,
  animeId: number,
  episode: number,
  dubbing: string
): boolean {
  return (
    record.animeId === animeId &&
    record.episode === episode &&
    record.dubbing === dubbing
  );
}

/**
 * Применяет одно наблюдение плеера к истории.
 *
 * Функция вынесена из сервиса, чтобы правила можно было проверить без Tauri:
 * finished липкий, длительность только растёт, позиция не выходит за неё.
 */
export function mergeWatchProgress(
  records: readonly WatchRecord[],
  update: StoredWatchProgressUpdate,
  updatedAt = Date.now()
): WatchRecord[] {
  const index = records.findIndex((record) =>
    sameEpisode(record, update.animeId, update.episode, update.dubbing)
  );
  const previous = index >= 0 ? records[index] : undefined;

  // При создании/демонтаже MediaSource браузер присылает не только 0/0, но и
  // 0/известная-длительность. Ноль не является просмотром и никогда не должен
  // стирать предыдущую позицию или создавать пустую запись.
  if (update.positionSecs <= 0) {
    return [...records];
  }

  const durationSecs = Math.max(
    previous?.durationSecs ?? 0,
    Number.isFinite(update.durationSecs) ? update.durationSecs : 0,
    0
  );
  const rawPosition = Number.isFinite(update.positionSecs)
    ? Math.max(update.positionSecs, 0)
    : 0;
  const positionSecs = durationSecs > 0
    ? Math.min(rawPosition, durationSecs)
    : rawPosition;
  const finished =
    (previous?.finished ?? false) ||
    (update.finished ?? false) ||
    (durationSecs > 0 && positionSecs / durationSecs >= FINISHED_FRACTION);

  const lastEpisode = update.lastEpisode ?? previous?.lastEpisode;
  const next: WatchRecord = {
    ...update,
    ...(lastEpisode === undefined ? {} : { lastEpisode }),
    positionSecs,
    durationSecs,
    finished,
    updatedAt,
  };

  return index < 0
    ? [...records, next]
    : records.map((record, itemIndex) =>
        itemIndex === index ? next : record
      );
}

/** Сначала выбрасываются самые старые завершённые, затем самые старые вообще. */
export function trimWatchRecords(
  records: readonly WatchRecord[],
  limit = MAX_RECORDS
): WatchRecord[] {
  if (records.length <= limit) {
    return [...records];
  }

  const retentionOrder = [...records].sort(
    (left, right) =>
      Number(left.finished) - Number(right.finished) ||
      byFreshness(left, right)
  );

  return retentionOrder.slice(0, limit);
}

/**
 * По одной карточке на тайтл — по его самой свежей записи, в любой озвучке.
 *
 * Досмотренная серия тайтл не прячет: иначе только что досмотренный тайтл
 * пропадал из ряда, а на его месте висела давно брошенная серия. Вместо неё
 * предлагается следующая — кроме случая, когда досмотрена последняя.
 */
export function selectContinueWatching(
  records: readonly WatchRecord[],
  limit = MAX_CONTINUE_WATCHING
): ContinueWatchingItem[] {
  const result: ContinueWatchingItem[] = [];
  const animeIds = new Set<number>();

  for (const record of [...records].sort(byFreshness)) {
    if (animeIds.has(record.animeId)) {
      continue;
    }

    animeIds.add(record.animeId);

    if (record.finished && record.lastEpisode) {
      continue;
    }

    result.push(
      record.finished
        ? {
            ...record,
            episode: record.episode + 1,
            positionSecs: 0,
            upNext: true,
          }
        : { ...record, upNext: false }
    );

    if (result.length >= limit) {
      break;
    }
  }

  return result;
}

/**
 * Серия, с которой открыть тайтл без явного выбора: где остановился, а если
 * она досмотрена — следующая. Номер берётся только из доступных в озвучке.
 */
export function resumeEpisodeFor(
  records: readonly WatchRecord[],
  animeId: number,
  availableEpisodes: readonly number[]
): number | null {
  const latest = latestRecordFor(records, animeId);
  if (!latest) {
    return null;
  }

  const available = new Set(availableEpisodes);

  if (latest.finished && available.has(latest.episode + 1)) {
    return latest.episode + 1;
  }

  return available.has(latest.episode) ? latest.episode : null;
}

/** Самая свежая запись тайтла в любой озвучке. */
export function latestRecordFor(
  records: readonly WatchRecord[],
  animeId: number
): WatchRecord | null {
  let latest: WatchRecord | null = null;

  for (const record of records) {
    if (
      record.animeId === animeId &&
      (latest === null || record.updatedAt > latest.updatedAt)
    ) {
      latest = record;
    }
  }

  return latest;
}

/**
 * Секунда, с которой продолжить. Сначала запись этой же озвучки; если её нет —
 * самая свежая запись этой серии в любой озвучке: позиция в аккаунте общая на
 * серию, и с сайта она могла приехать под другой дорожкой.
 */
export function resumePositionFor(
  records: readonly WatchRecord[],
  animeId: number,
  episode: number,
  dubbing: string
): number {
  const record =
    records.find((item) => sameEpisode(item, animeId, episode, dubbing)) ??
    records
      .filter((item) => item.animeId === animeId && item.episode === episode)
      .sort(byFreshness)[0];

  return record && !record.finished && record.positionSecs > 0
    ? record.positionSecs
    : 0;
}

/**
 * Вливает серверную запись в локальную историю как наблюдение со своим
 * временем. Позиция без секунд (серию смотрели в iframe на сайте) не стирает
 * секунды той же серии и дорожки.
 */
export function foldServerPosition(
  records: readonly WatchRecord[],
  server: ServerPlaybackPosition,
  fallbackPoster: Poster
): WatchRecord[] {
  const updatedAt = Date.parse(server.observedAt);
  const index = records.findIndex((record) =>
    sameEpisode(record, server.animeId, server.episode, server.dubbing)
  );
  const previous = index >= 0 ? records[index] : undefined;

  const next: WatchRecord = {
    animeId: server.animeId,
    title: server.title || previous?.title || '',
    poster: { ...fallbackPoster, ...previous?.poster, ...server.poster },
    episode: server.episode,
    dubbing: server.dubbing,
    positionSecs: server.positionSecs ?? previous?.positionSecs ?? 0,
    durationSecs: server.durationSecs ?? previous?.durationSecs ?? 0,
    finished: server.finished,
    ...(server.lastEpisode === undefined ? {} : { lastEpisode: server.lastEpisode }),
    updatedAt,
  };

  return index < 0
    ? [...records, next]
    : records.map((record, itemIndex) => (itemIndex === index ? next : record));
}

/** Самое свежее неотправленное наблюдение каждого тайтла: сервер хранит одну запись. */
export function latestUnsent(records: readonly WatchRecord[]): WatchRecord[] {
  const latest = new Map<number, WatchRecord>();

  for (const record of records) {
    const current = latest.get(record.animeId);
    if (record.unsent && (!current || record.updatedAt > current.updatedAt)) {
      latest.set(record.animeId, record);
    }
  }

  return [...latest.values()];
}

const EMPTY_POSTER: Poster = { fullsize: '', big: '', small: '', medium: '', huge: '', mega: '' };

/** Карточка серверного ряда в форме локальной — шаблону ленты всё равно. */
function continueItemFromServer(server: ServerPlaybackPosition): ContinueWatchingItem {
  return {
    animeId: server.animeId,
    title: server.title,
    poster: { ...EMPTY_POSTER, ...server.poster },
    episode: server.episode,
    dubbing: server.dubbing,
    positionSecs: server.positionSecs ?? 0,
    durationSecs: server.durationSecs ?? 0,
    finished: false,
    updatedAt: Date.parse(server.observedAt),
    upNext: server.upNext ?? false,
  };
}

@Injectable({ providedIn: 'root' })
export class WatchProgressService {
  private readonly api = inject(ApiClient);
  private readonly users = inject(UserService);

  private readonly store = new LazyStore(STORE_FILE);
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveChain = Promise.resolve();
  private readonly windowLabel = getCurrentWindow().label;

  readonly records = signal<WatchRecord[]>([]);
  readonly isInitialized = signal(false);

  /** Ряд с сервера у вошедшего; null — ещё не загружен. */
  private readonly remoteContinue = signal<ContinueWatchingItem[] | null>(null);
  /** Тайтлы, чья серверная позиция уже влита в историю. */
  private readonly syncedTitles = signal<ReadonlySet<number>>(new Set());

  /** У вошедшего ряд общий с сайтом и собран сервером, у гостя — из файла. */
  readonly continueWatching = computed(() =>
    this.users.isAuthenticated()
      ? (this.remoteContinue() ?? [])
      : selectContinueWatching(this.records())
  );

  constructor() {
    void this.restore().catch(() => undefined);

    // Вошли — досылаем то, что не ушло в прошлый раз (упало приложение, не
    // было сети, смотрели скачанное офлайн). Вышли — неотправленное остаётся
    // локальным: чужому аккаунту оно не принадлежит.
    let lastUserId: number | null | undefined;
    effect(() => {
      if (!this.users.isInitialized() || !this.isInitialized()) {
        return;
      }

      const userId = this.users.user()?.id ?? null;
      if (userId === lastUserId) {
        return;
      }
      lastUserId = userId;

      untracked(() => {
        this.remoteContinue.set(null);
        this.syncedTitles.set(new Set());

        if (userId === null) {
          this.records.update((records) =>
            records.map((record) => (record.unsent ? { ...record, unsent: false } : record))
          );
          return;
        }

        void this.sendUnsent();
      });
    });

    // Серия может играть в отдельном окне, а ряд «Продолжить смотреть» —
    // висеть в главном. Каждое окно Tauri держит свой экземпляр сервиса, и
    // без этой подписки ряд обновился бы только после перезапуска.
    void listen<SharedWatchProgress>(SHARE_EVENT, ({ payload }) => {
      if (payload.source === this.windowLabel) {
        return;
      }

      this.records.update((records) =>
        mergeWatchProgress(records, payload.update, payload.updatedAt)
      );
    });
  }

  /**
   * Файл пишет только то окно, где серия играет: два окна, сохраняющие каждое
   * свой снимок истории, затирали бы записи друг друга. Остальные окна лишь
   * обновляют память — им хватает разосланного наблюдения.
   */
  record(observation: WatchProgressUpdate): void {
    const updatedAt = Date.now();
    const update: StoredWatchProgressUpdate = {
      ...observation,
      unsent: this.users.isAuthenticated(),
    };

    this.records.update((records) =>
      mergeWatchProgress(records, update, updatedAt)
    );
    this.scheduleSave();

    void emit(SHARE_EVENT, {
      source: this.windowLabel,
      update,
      updatedAt,
    } satisfies SharedWatchProgress).catch(() => undefined);
  }

  /** Любая сохранённая позиция продолжается; завершённая серия начинается заново. */
  resumePosition(
    animeId: number,
    episode: number,
    dubbing: string
  ): number {
    return resumePositionFor(this.records(), animeId, episode, dubbing);
  }

  /**
   * Сохранить файл и отправить неотправленное. Вызывается на событиях плеера —
   * пауза, конец, смена серии — и при закрытии окна: это и есть моменты
   * отправки на сервер, тики идут только в файл.
   */
  async flush(): Promise<void> {
    await this.saveFile();
    await this.sendUnsent();
  }

  /**
   * flush для закрытия окна и выхода из аккаунта: сеть ждём не дольше `ms`.
   * Не успевшее уйти останется неотправленным и дошлётся при следующем входе.
   */
  flushBeforeExit(ms = 3_000): Promise<void> {
    return Promise.race([
      this.flush(),
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    ]).catch(() => undefined);
  }

  /** Готова ли история тайтла для выбора серии: у вошедшего — после сверки с сервером. */
  isTitleReady(animeId: number): boolean {
    if (!this.isInitialized() || !this.users.isInitialized()) {
      return false;
    }

    return !this.users.isAuthenticated() || this.syncedTitles().has(animeId);
  }

  /**
   * Сверка тайтла с аккаунтом при его открытии. Более свежая серверная запись
   * вливается в историю, более свежая локальная неотправленная — досылается.
   * Сервер недоступен — работаем по локальной истории.
   */
  async syncTitle(animeId: number): Promise<void> {
    const userId = this.users.user()?.id ?? null;
    if (userId === null || this.syncedTitles().has(animeId)) {
      return;
    }

    try {
      const server = await this.api.get<ServerPlaybackPosition | null>(
        `/playback-position/${animeId}`
      );
      const local = latestRecordFor(this.records(), animeId);

      if (this.users.user()?.id !== userId) {
        return;
      }

      if (local?.unsent && (!server || local.updatedAt > Date.parse(server.observedAt))) {
        await this.sendUnsent();
      } else if (server && (!local || Date.parse(server.observedAt) > local.updatedAt)) {
        this.applyServer(server);
      }
    } catch {
      // Без сервера тайтл открывается по локальной истории.
    } finally {
      if (this.users.user()?.id === userId) {
        this.syncedTitles.update((ids) => new Set([...ids, animeId]));
      }
    }
  }

  /** Ряд «Продолжить смотреть» с сервера; у гостя ничего не делает. */
  async loadContinueWatching(): Promise<void> {
    const userId = this.users.user()?.id ?? null;
    if (userId === null) {
      return;
    }

    try {
      const items = await this.api.get<ServerPlaybackPosition[]>(
        '/playback-position/continue?limit=10'
      );
      if (this.users.user()?.id === userId) {
        this.remoteContinue.set(items.map(continueItemFromServer));
      }
    } catch {
      // Ряд просто не покажется — лента от него не зависит.
    }
  }

  /** Крестик на карточке: сразу из ряда, при ошибке — обратно. */
  async hideFromContinue(animeId: number): Promise<void> {
    const before = this.remoteContinue();
    this.remoteContinue.set((before ?? []).filter((item) => item.animeId !== animeId));

    try {
      await this.api.delete<unknown>(`/playback-position/${animeId}`);
    } catch {
      this.remoteContinue.set(before);
    }
  }

  private applyServer(server: ServerPlaybackPosition): void {
    this.records.update((records) =>
      foldServerPosition(records, server, EMPTY_POSTER)
    );
    this.scheduleSave();
  }

  /**
   * Отправка на сервер: по одному — самому свежему — наблюдению на тайтл.
   * Удачно ушедшие помечаются отправленными; если сервер ответил более свежей
   * записью с другого устройства, она вливается в историю.
   */
  private async sendUnsent(): Promise<void> {
    const userId = this.users.user()?.id ?? null;
    if (userId === null) {
      return;
    }

    for (const record of latestUnsent(this.records())) {
      let winner: ServerPlaybackPosition | null;
      try {
        winner = await this.api.put<ServerPlaybackPosition | null>(
          `/playback-position/${record.animeId}`,
          {
            episode: record.episode,
            dubbing: record.dubbing,
            // Подпись плеера как у сайта: по ней он восстановит ту же дорожку.
            player: sourceOfDubbing(record.dubbing) === 'cvh' ? 'CDNVideoHub' : 'Плеер Kodik',
            positionSecs: record.positionSecs,
            durationSecs: record.durationSecs,
            lastEpisode: record.lastEpisode,
            observedAt: new Date(record.updatedAt).toISOString(),
            title: record.title,
            animeUrl: '',
            poster: record.poster,
          }
        );
      } catch {
        // Остаётся неотправленным до следующего flush или запуска.
        continue;
      }

      if (this.users.user()?.id !== userId) {
        return;
      }

      this.records.update((records) =>
        records.map((item) =>
          item.animeId === record.animeId && item.unsent && item.updatedAt <= record.updatedAt
            ? { ...item, unsent: false }
            : item
        )
      );

      if (winner && Date.parse(winner.observedAt) > record.updatedAt) {
        this.applyServer(winner);
      } else {
        this.scheduleSave();
      }
    }
  }

  private async saveFile(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    const snapshot = trimWatchRecords(this.records());
    this.records.set(snapshot);
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(async () => {
        await this.store.set(RECORDS_KEY, snapshot);
        await this.store.save();
      });

    await this.saveChain;
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      // Тики пишутся только в файл: на сервер — по событиям, через flush.
      void this.saveFile().catch(() => undefined);
    }, SAVE_DEBOUNCE_MS);
  }

  private async restore(): Promise<void> {
    try {
      const stored =
        (await this.store.get<WatchRecord[]>(RECORDS_KEY)) ?? [];
      const current = this.records();
      let merged = trimWatchRecords(stored);

      // Плеер теоретически может успеть прислать прогресс до чтения файла.
      // Свежие записи из текущей сессии должны победить восстановленные.
      for (const record of current) {
        merged = mergeWatchProgress(merged, record, record.updatedAt);
      }

      this.records.set(trimWatchRecords(merged));

      if (stored.length > MAX_RECORDS) {
        await this.saveFile();
      }
    } finally {
      this.isInitialized.set(true);
    }
  }
}
