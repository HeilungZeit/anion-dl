import { computed, Injectable, signal } from '@angular/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LazyStore } from '@tauri-apps/plugin-store';

import type { Poster } from './anime.types';

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
  Partial<Pick<WatchRecord, 'finished'>>;

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

export function resumePositionFor(
  records: readonly WatchRecord[],
  animeId: number,
  episode: number,
  dubbing: string
): number {
  const record = records.find((item) =>
    sameEpisode(item, animeId, episode, dubbing)
  );

  return record && !record.finished && record.positionSecs > 0
    ? record.positionSecs
    : 0;
}

@Injectable({ providedIn: 'root' })
export class WatchProgressService {
  private readonly store = new LazyStore(STORE_FILE);
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveChain = Promise.resolve();
  private readonly windowLabel = getCurrentWindow().label;

  readonly records = signal<WatchRecord[]>([]);
  readonly isInitialized = signal(false);
  readonly continueWatching = computed(() =>
    selectContinueWatching(this.records())
  );

  constructor() {
    void this.restore().catch(() => undefined);

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
  record(update: WatchProgressUpdate): void {
    const updatedAt = Date.now();

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

  async flush(): Promise<void> {
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
      void this.flush().catch(() => undefined);
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
        await this.flush();
      }
    } finally {
      this.isInitialized.set(true);
    }
  }
}
