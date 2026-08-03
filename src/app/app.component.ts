import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
} from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TuiIcon, TuiRoot } from '@taiga-ui/core';

import { DownloadService } from './api/download.service';
import { UpdateService } from './api/update.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, TuiIcon, TuiRoot],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements OnInit {
  private readonly updates = inject(UpdateService);

  // Сервис инжектится в шапке, а значит поднимается при старте приложения:
  // прерванная выходом очередь возобновляется сразу, а не когда пользователь
  // случайно зайдёт на страницу загрузок.
  private readonly downloads = inject(DownloadService);

  readonly pendingCount = computed(() => this.downloads.pending().length);

  ngOnInit(): void {
    void this.updates.checkForUpdates();
  }
}
