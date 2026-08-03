import {
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  input,
  viewChildren,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { revealItemInDir } from '@tauri-apps/plugin-opener';

import { DownloadService, DownloadTask } from '../../api/download.service';

@Component({
  selector: 'app-downloads',
  imports: [RouterLink],
  templateUrl: './downloads.component.html',
  styleUrl: './downloads.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DownloadsComponent {
  private readonly downloads = inject(DownloadService);

  readonly tasks = this.downloads.tasks;
  readonly pending = this.downloads.pending;

  readonly revealLabel = revealLabel();

  /** `?task=<id>` — с какой задачи пришли со страницы аниме. */
  readonly highlight = input<string | undefined>(undefined, { alias: 'task' });

  private readonly items =
    viewChildren<ElementRef<HTMLElement>>('taskItem');

  /** Прокрутка нужна один раз: дальше список живёт своей жизнью. */
  private scrolled = false;

  constructor() {
    // Задачи восстанавливаются из хранилища асинхронно, поэтому «доскроллить»
    // в afterNextRender нечего — ждём появления самого элемента.
    effect(() => {
      const id = this.highlight();
      const target = this.items().find(
        (item) => item.nativeElement.dataset['taskId'] === id
      );

      if (this.scrolled || !id || !target) {
        return;
      }

      this.scrolled = true;
      target.nativeElement.scrollIntoView({ block: 'center' });
    });
  }

  percent(task: DownloadTask): number {
    if (task.status === 'done') {
      return 100;
    }

    if (task.totalSecs <= 0) {
      return 0;
    }

    return Math.min(100, Math.round((task.processedSecs / task.totalSecs) * 100));
  }

  label(task: DownloadTask): string {
    switch (task.status) {
      case 'queued':
        return 'В очереди';
      case 'resolving':
        return 'Ищу поток…';
      case 'downloading':
        return `${this.percent(task)}% · ${megabytes(task.sizeBytes)} МБ`;
      case 'done':
        return task.warning
          ? `Готово с замечанием · ${megabytes(task.sizeBytes)} МБ`
          : `Готово · ${megabytes(task.sizeBytes)} МБ`;
      case 'cancelled':
        return 'Отменено';
      case 'failed':
        return task.error;
    }
  }

  canCancel(task: DownloadTask): boolean {
    return (
      task.status === 'queued' ||
      task.status === 'resolving' ||
      task.status === 'downloading'
    );
  }

  cancel(task: DownloadTask): Promise<void> {
    return this.downloads.cancel(task.id);
  }

  retry(task: DownloadTask): Promise<void> {
    return this.downloads.retry(task.id);
  }

  clearFinished(): Promise<void> {
    return this.downloads.clearFinished();
  }

  reveal(task: DownloadTask): Promise<void> {
    return revealItemInDir(task.outputPath);
  }
}

function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

/**
 * Подпись кнопки «показать файл» зависит от файлового менеджера ОС. Платформу
 * берём из user agent вебвью, а не из `plugin-os`: ради одной строки плагин
 * тянет за собой Rust-зависимость и запись в capabilities.
 */
function revealLabel(): string {
  const agent = navigator.userAgent;

  if (agent.includes('Macintosh')) {
    return 'Показать в Finder';
  }

  return agent.includes('Windows')
    ? 'Показать в проводнике'
    : 'Показать в папке';
}
