import { computed, Injectable, signal } from '@angular/core';
import { LazyStore } from '@tauri-apps/plugin-store';

import type { Poster } from './anime.types';

const STORE_FILE = 'watch-progress.json';
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
}

export type WatchProgressUpdate = Omit<
  WatchRecord,
  'finished' | 'updatedAt'
>;

type StoredWatchProgressUpdate = WatchProgressUpdate &
  Partial<Pick<WatchRecord, 'finished'>>;

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

  const next: WatchRecord = {
    ...update,
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
      right.updatedAt - left.updatedAt
  );

  return retentionOrder.slice(0, limit);
}

/** По одной самой свежей незавершённой записи на тайтл. */
export function selectContinueWatching(
  records: readonly WatchRecord[],
  limit = MAX_CONTINUE_WATCHING
): WatchRecord[] {
  const result: WatchRecord[] = [];
  const animeIds = new Set<number>();

  for (const record of [...records].sort(
    (left, right) => right.updatedAt - left.updatedAt
  )) {
    if (
      record.finished || animeIds.has(record.animeId)
    ) {
      continue;
    }

    animeIds.add(record.animeId);
    result.push(record);

    if (result.length >= limit) {
      break;
    }
  }

  return result;
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

  readonly records = signal<WatchRecord[]>([]);
  readonly isInitialized = signal(false);
  readonly continueWatching = computed(() =>
    selectContinueWatching(this.records())
  );

  constructor() {
    void this.restore().catch(() => undefined);
  }

  record(update: WatchProgressUpdate): void {
    this.records.update((records) => mergeWatchProgress(records, update));
    this.scheduleSave();
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
