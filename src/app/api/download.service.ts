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
const FOLDER_PER_ANIME_KEY = 'folderPerAnime';

/**
 * Раскладка по подпапкам включена по умолчанию: после трёх сезонов плоская
 * папка перестаёт читаться. Уже сохранённые задачи хранят готовый абсолютный
 * путь, поэтому смена настройки их не ломает — она влияет только на новые.
 */
const DEFAULT_FOLDER_PER_ANIME = true;

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

/** Ответ `probe_files`: что из перечисленных путей действительно на диске. */
interface FileState {
  path: string;
  exists: boolean;
  sizeBytes: number;
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
   * Задачи со статусом `done`, у которых файла на диске больше нет.
   *
   * Не поле задачи и не часть хранилища: это состояние файловой системы, а не
   * загрузки, и живёт оно ровно до следующей сверки. Хранить его — значит
   * закрепить в `settings.json` наблюдение, которое устареет к перезапуску.
   */
  readonly missingFiles = signal<ReadonlySet<string>>(new Set());

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

  async getFolderPerAnime(): Promise<boolean> {
    return (
      (await this.store.get<boolean>(FOLDER_PER_ANIME_KEY)) ??
      DEFAULT_FOLDER_PER_ANIME
    );
  }

  async setFolderPerAnime(enabled: boolean): Promise<void> {
    await this.store.set(FOLDER_PER_ANIME_KEY, enabled);
    await this.store.save();
  }

  /**
   * Какие из серий уже лежат на диске — по факту наличия файла, а не по списку
   * задач. Проверять надо именно так: `clearFinished` стирает задачу, файл
   * остаётся, и без этой сверки серия качается заново без единого намёка.
   *
   * Отдаётся вместе с путём: вызывающей стороне он нужен, чтобы открыть файл, а
   * собирать его второй раз у себя — верный способ разойтись с этой сверкой.
   */
  async findDownloaded(
    animeTitle: string,
    episodes: Video[]
  ): Promise<ReadonlyMap<number, string>> {
    const paths = await this.plannedPaths(animeTitle, episodes);
    const states = await this.probe([...paths.values()]);

    return new Map(
      [...paths].filter(([, path]) => states.get(path))
    );
  }

  /**
   * Сверяет готовые задачи с диском. Дёргается при старте и после каждой
   * завершившейся загрузки — чаще незачем, файлы пропадают не сами по себе.
   */
  async refreshFiles(): Promise<void> {
    const finished = this.tasks().filter((task) => task.status === 'done');
    const states = await this.probe(finished.map((task) => task.outputPath));

    this.missingFiles.set(
      new Set(
        finished
          .filter((task) => !states.get(task.outputPath))
          .map((task) => task.id)
      )
    );
  }

  /** Ставит серии в очередь и запускает обработчик, если тот простаивает. */
  async enqueue(
    animeId: number,
    animeTitle: string,
    episodes: Video[]
  ): Promise<void> {
    const paths = await this.plannedPaths(animeTitle, episodes);

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
        outputPath: paths.get(episode.videoId) ?? '',
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
   * Куда легла бы каждая из серий. Общий источник пути для постановки в очередь
   * и для проверки «а не скачано ли уже» — иначе эти два места разъедутся, и
   * дедупликация начнёт смотреть не на тот файл.
   */
  private async plannedPaths(
    animeTitle: string,
    episodes: Video[]
  ): Promise<ReadonlyMap<number, string>> {
    const outputDir = await this.getOutputDir();
    if (!outputDir) {
      throw new Error('Не выбрана папка для загрузок');
    }

    const folder = (await this.getFolderPerAnime())
      ? `${outputDir}/${sanitize(animeTitle)}`
      : outputDir;

    return new Map(
      episodes.map((episode) => [
        episode.videoId,
        `${folder}/${buildFileName(animeTitle, episode)}`,
      ])
    );
  }

  /** Путь -> лежит ли файл. Пустой запрос до Rust не доходит. */
  private async probe(paths: string[]): Promise<ReadonlyMap<string, boolean>> {
    if (paths.length === 0) {
      return new Map();
    }

    const states = await invoke<FileState[]>('probe_files', { paths });

    return new Map(states.map((state) => [state.path, state.exists]));
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

      // Файл только что появился — снимаем пометку «удалён», если задача её
      // несла с прошлой сверки после «Скачать снова».
      this.missingFiles.update((missing) => {
        if (!missing.has(task.id)) {
          return missing;
        }

        const next = new Set(missing);
        next.delete(task.id);
        return next;
      });
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

    void this.refreshFiles();
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

  return `${sanitize(`${animeTitle} - E${number} [${episode.data.dubbing}]`)}.mp4`;
}

/**
 * Убирает из имени то, что ломает путь. Применяется и к файлу, и к папке
 * аниме: у названия с двоеточием (а их много — «Название: Подзаголовок») иначе
 * получилась бы лишняя вложенность, а на Windows такой каталог не создался бы
 * вовсе.
 *
 * Точка в начале тоже срезается: на macOS и Linux она делает папку скрытой,
 * и пользователь не нашёл бы свои серии в Finder.
 */
function sanitize(raw: string): string {
  return raw.replace(/[/\\:*?"<>|]/g, '').trim().replace(/^\.+/, '').trim();
}
