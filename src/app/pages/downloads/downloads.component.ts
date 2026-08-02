import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
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
