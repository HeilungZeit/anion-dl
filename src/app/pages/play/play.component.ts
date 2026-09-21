import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TuiLoader } from '@taiga-ui/core';

import { DownloadService, type DownloadTask } from '../../api/download.service';
import { RemoteWatchProgressService } from '../../api/remote-watch-progress.service';
import { UserService } from '../../api/user.service';
import { WatchProgressService } from '../../api/watch-progress.service';
import {
  type PlaybackProgress,
  VideoPlayerComponent,
} from '../../player/video-player.component';
import { PlayerWindowService } from '../../windows/player-window.service';

/**
 * Просмотр скачанной серии без сети.
 *
 * Страница аниме тоже играет файлы с диска, но она целиком зависит от бэка:
 * без сети не откроется ни описание, ни список серий. Здесь всё берётся из
 * задачи загрузки — её хватает и на плеер, и на соседние серии, и на прогресс.
 */
@Component({
  selector: 'app-play',
  imports: [RouterLink, TuiLoader, VideoPlayerComponent],
  templateUrl: './play.component.html',
  styleUrl: './play.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlayComponent {
  private readonly downloads = inject(DownloadService);
  private readonly localProgress = inject(WatchProgressService);
  private readonly remoteProgress = inject(RemoteWatchProgressService);
  private readonly users = inject(UserService);
  private readonly playerWindows = inject(PlayerWindowService);
  private readonly router = inject(Router);

  readonly taskId = input.required<string>();

  readonly ready = computed(
    () => this.downloads.restored() && this.localProgress.isInitialized()
  );

  readonly task = computed(
    () => this.downloads.tasks().find((item) => item.id === this.taskId()) ?? null
  );

  readonly isMissing = computed(() => {
    const task = this.task();
    return task !== null && this.downloads.missingFiles().has(task.id);
  });

  /** Скачанные серии того же тайтла и озвучки — по ним ходит «следующая». */
  readonly siblings = computed(() => {
    const task = this.task();
    if (!task) {
      return [];
    }

    const missing = this.downloads.missingFiles();

    return this.downloads
      .tasks()
      .filter(
        (item) =>
          item.animeId === task.animeId &&
          item.dubbing === task.dubbing &&
          item.status === 'done' &&
          !missing.has(item.id)
      )
      .sort((left, right) => Number(left.episode) - Number(right.episode));
  });

  readonly nextTask = computed(() => {
    const list = this.siblings();
    const index = list.findIndex((item) => item.id === this.taskId());
    return index >= 0 ? (list[index + 1] ?? null) : null;
  });

  readonly detachRoute = computed(
    () => `/window/player?task=${encodeURIComponent(this.taskId())}`
  );

  readonly startPositionSecs = computed(() => {
    const task = this.task();
    return task
      ? this.localProgress.resumePosition(
          task.animeId,
          Number(task.episode),
          task.dubbing
        )
      : 0;
  });

  constructor() {
    // Файл могли удалить, пока приложение было открыто.
    void this.downloads.refreshFiles();

    inject(DestroyRef).onDestroy(() => {
      void this.localProgress.flush().catch(() => undefined);
      void this.remoteProgress.flush();
    });
  }

  saveProgress(progress: PlaybackProgress): void {
    const task = this.task();
    const poster = task ? this.posterOf(task) : null;

    // Без постера запись в ряд «Продолжить смотреть» вышла бы битой
    // карточкой. Такое бывает только у задач из версий до постеров.
    if (!task || !poster) {
      return;
    }

    this.localProgress.record({
      animeId: task.animeId,
      title: task.title,
      poster,
      episode: Number(task.episode),
      dubbing: task.dubbing,
      positionSecs: progress.positionSecs,
      durationSecs: progress.durationSecs,
    });
  }

  saveAndFlush(progress: PlaybackProgress): void {
    this.saveProgress(progress);
    void this.localProgress.flush().catch(() => undefined);
  }

  markEnded(progress: PlaybackProgress): void {
    this.saveAndFlush({
      ...progress,
      positionSecs: progress.durationSecs,
    });
  }

  /** Та же отметка, что на странице аниме; без сети она дождётся связи. */
  markWatched(): void {
    const task = this.task();
    const userId = this.users.user()?.id;

    if (task && task.animeId && userId !== undefined) {
      this.remoteProgress.markWatched(task.animeId, userId, Number(task.episode));
    }
  }

  /** Скачанная серия уезжает в своё окно; страница остаётся на паузе. */
  detachToWindow(route: string): void {
    const task = this.task();
    const title = task
      ? `${task.title} · ${task.episode} серия`
      : 'Anion Flow';

    void this.playerWindows.open(route, title).catch(() => undefined);
  }

  goNext(): void {
    const next = this.nextTask();
    if (next) {
      void this.router.navigate(['/play', next.id], { replaceUrl: true });
    }
  }

  private posterOf(task: DownloadTask) {
    return (
      task.poster ??
      this.localProgress.records().find((record) => record.animeId === task.animeId)
        ?.poster ??
      null
    );
  }
}
