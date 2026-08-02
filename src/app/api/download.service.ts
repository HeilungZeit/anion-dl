import { computed, inject, Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { LazyStore } from '@tauri-apps/plugin-store';

import { ResolverService } from './resolver.service';
import type { Video } from './anime.types';

const PROGRESS_EVENT = 'download://progress';
const SETTINGS_FILE = 'settings.json';
const OUTPUT_DIR_KEY = 'outputDir';
const QUALITY_KEY = 'quality';
const TASKS_KEY = 'tasks';

/**
 * Referer для CDN. Сегменты отдаются только с ним, поэтому он не косметика.
 * Совпадает с origin плеера, а не сайта: страницу мы грузим напрямую с Kodik.
 */
const CDN_REFERER = 'https://kodikplayer.com/';

/** Что реально встречается у Kodik. 1080p наблюдалось как 404. */
export const QUALITIES = [720, 480, 360] as const;

export const DEFAULT_QUALITY = 720;

/** Текст, которым Rust помечает убитый по отмене процесс. */
const CANCELLED = 'Отменено';

interface ProgressPayload {
  taskId: string;
  processedSecs: number;
  totalSecs: number;
  sizeBytes: number;
}

export type TaskStatus =
  | 'queued'
  | 'resolving'
  | 'downloading'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface DownloadTask {
  id: string;
  animeId: number;
  title: string;
  episode: string;
  dubbing: string;
  iframeUrl: string;
  status: TaskStatus;
  processedSecs: number;
  totalSecs: number;
  sizeBytes: number;
  outputPath: string;
  error: string;
  /** Файл скачан, но ffmpeg ворчал. Не ошибка — задача остаётся успешной. */
  warning: string;
}

interface DownloadReport {
  path: string;
  warning: string | null;
}

/** Что переживает перезапуск. Прогресс не хранится — он всё равно обнулится. */
type StoredTask = Omit<
  DownloadTask,
  'processedSecs' | 'totalSecs' | 'sizeBytes'
>;

const ACTIVE: readonly TaskStatus[] = ['queued', 'resolving', 'downloading'];

@Injectable({ providedIn: 'root' })
export class DownloadService {
  private readonly store = new LazyStore(SETTINGS_FILE);
  private readonly resolver = inject(ResolverService);

  readonly tasks = signal<DownloadTask[]>([]);

  readonly pending = computed(() =>
    this.tasks().filter((task) => ACTIVE.includes(task.status))
  );

  /**
   * Параллелизм намеренно равен единице. CDN уже показал таймауты на одном
   * потоке (см. PLAN.md), а несколько одновременных ffmpeg только увеличат
   * шанс потерять сегмент — ради выигрыша, которого нет: упирается всё в сеть.
   */
  private running = false;

  constructor() {
    // Прогресс приходит из Rust потоком по всем задачам сразу, поэтому
    // подписка одна на сервис, а не на задачу.
    void listen<ProgressPayload>(PROGRESS_EVENT, ({ payload }) => {
      this.patch(payload.taskId, {
        processedSecs: payload.processedSecs,
        totalSecs: payload.totalSecs,
        sizeBytes: payload.sizeBytes,
      });
    });

    void this.restore();
  }

  async chooseOutputDir(): Promise<string | null> {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked !== 'string') {
      return null;
    }

    await this.store.set(OUTPUT_DIR_KEY, picked);
    await this.store.save();
    return picked;
  }

  getOutputDir(): Promise<string | undefined> {
    return this.store.get<string>(OUTPUT_DIR_KEY);
  }

  async getQuality(): Promise<number> {
    return (await this.store.get<number>(QUALITY_KEY)) ?? DEFAULT_QUALITY;
  }

  async setQuality(quality: number): Promise<void> {
    await this.store.set(QUALITY_KEY, quality);
    await this.store.save();
  }

  /** Ставит серии в очередь и запускает обработчик, если тот простаивает. */
  async enqueue(
    animeId: number,
    animeTitle: string,
    episodes: Video[]
  ): Promise<void> {
    const outputDir = await this.getOutputDir();
    if (!outputDir) {
      throw new Error('Не выбрана папка для загрузок');
    }

    for (const episode of episodes) {
      const id = `${episode.videoId}`;

      // Повторный клик по уже идущей серии не должен плодить дубликаты.
      if (this.tasks().some((task) => task.id === id && isActive(task))) {
        continue;
      }

      this.upsert({
        id,
        animeId,
        title: animeTitle,
        episode: episode.number,
        dubbing: episode.data.dubbing,
        iframeUrl: episode.iframeUrl,
        status: 'queued',
        processedSecs: 0,
        totalSecs: 0,
        sizeBytes: 0,
        outputPath: `${outputDir}/${buildFileName(animeTitle, episode)}`,
        error: '',
        warning: '',
      });
    }

    await this.persist();
    void this.drain();
  }

  async cancel(id: string): Promise<void> {
    const task = this.tasks().find((item) => item.id === id);
    if (!task) {
      return;
    }

    // Задача, до которой очередь ещё не дошла, снимается без похода в Rust —
    // процесса там пока нет.
    if (task.status !== 'downloading' && task.status !== 'resolving') {
      this.patch(id, { status: 'cancelled', error: '' });
      await this.persist();
      return;
    }

    await invoke('cancel_download', { taskId: id });
  }

  async retry(id: string): Promise<void> {
    this.patch(id, {
      status: 'queued',
      error: '',
      warning: '',
      processedSecs: 0,
    });
    await this.persist();
    void this.drain();
  }

  async clearFinished(): Promise<void> {
    this.tasks.update((tasks) => tasks.filter(isActive));
    await this.persist();
  }

  /**
   * Последовательно разбирает очередь. Повторный вызов во время работы
   * безопасен: флаг running гарантирует единственного обработчика.
   */
  private async drain(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      for (;;) {
        const next = this.tasks().find((task) => task.status === 'queued');
        if (!next) {
          return;
        }

        await this.process(next);
        await this.persist();
      }
    } finally {
      this.running = false;
    }
  }

  private async process(task: DownloadTask): Promise<void> {
    try {
      this.patch(task.id, { status: 'resolving' });

      // Резолв идёт здесь, а не при постановке в очередь: подписи в URL
      // сегментов протухают, и манифест, добытый впрок для всего сезона, к
      // старту ffmpeg будет мёртв.
      const manifestUrl = await this.resolver.resolveManifest(
        task.iframeUrl,
        await this.getQuality()
      );

      this.patch(task.id, { status: 'downloading' });

      const report = await invoke<DownloadReport>('download_episode', {
        taskId: task.id,
        manifestUrl,
        outputPath: task.outputPath,
        referer: CDN_REFERER,
      });

      this.patch(task.id, { status: 'done', warning: report.warning ?? '' });
    } catch (error: unknown) {
      const message = String(error);

      this.patch(task.id, {
        status: message.includes(CANCELLED) ? 'cancelled' : 'failed',
        error: message.includes(CANCELLED) ? '' : message,
      });
    }
  }

  private async restore(): Promise<void> {
    const stored = (await this.store.get<StoredTask[]>(TASKS_KEY)) ?? [];

    this.tasks.set(
      stored.map((task) => ({
        ...task,
        processedSecs: 0,
        totalSecs: 0,
        sizeBytes: 0,
        // Прерванная выходом из приложения загрузка возобновляется с нуля:
        // ffmpeg дописывать частичный mp4 не умеет.
        status: isActive(task) ? 'queued' : task.status,
      }))
    );

    void this.drain();
  }

  private async persist(): Promise<void> {
    const stored: StoredTask[] = this.tasks().map(
      ({ processedSecs, totalSecs, sizeBytes, ...rest }) => rest
    );

    await this.store.set(TASKS_KEY, stored);
    await this.store.save();
  }

  private upsert(task: DownloadTask): void {
    this.tasks.update((tasks) => [
      ...tasks.filter((item) => item.id !== task.id),
      task,
    ]);
  }

  private patch(id: string, patch: Partial<DownloadTask>): void {
    this.tasks.update((tasks) =>
      tasks.map((task) => (task.id === id ? { ...task, ...patch } : task))
    );
  }
}

function isActive(task: { status: TaskStatus }): boolean {
  return ACTIVE.includes(task.status);
}

/** `Название - E01 [Озвучка].mp4`, безопасное для файловой системы. */
export function buildFileName(animeTitle: string, episode: Video): string {
  const number = episode.number.padStart(2, '0');
  const raw = `${animeTitle} - E${number} [${episode.data.dubbing}]`;

  // Слэши и двоеточия ломают путь, остальное — вопрос читаемости в Finder.
  return `${raw.replace(/[/\\:*?"<>|]/g, '').trim()}.mp4`;
}
