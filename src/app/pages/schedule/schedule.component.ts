import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  resource,
  untracked,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TuiLoader } from '@taiga-ui/core';

import type { CalendarEntry } from '../../api/account.types';
import { BookmarksService } from '../../api/bookmarks.service';
import { UserService } from '../../api/user.service';

interface CalendarGroup {
  key: string;
  label: string;
  entries: CalendarEntry[];
}

@Component({
  selector: 'app-schedule',
  imports: [RouterLink, TuiLoader],
  templateUrl: './schedule.component.html',
  styleUrl: './schedule.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScheduleComponent {
  private readonly api = inject(BookmarksService);
  private readonly user = inject(UserService);
  private readonly router = inject(Router);

  readonly calendar = resource({
    params: () => (this.user.isAuthenticated() ? true : undefined),
    loader: () => this.api.getCalendar(),
  });

  readonly groups = computed<CalendarGroup[]>(() => {
    const dated = new Map<string, CalendarEntry[]>();

    for (const entry of this.calendar.value() ?? []) {
      const key = entry.nextEpisodeDate
        ? this.dateKey(new Date(entry.nextEpisodeDate * 1000))
        : 'unknown';
      dated.set(key, [...(dated.get(key) ?? []), entry]);
    }

    return [...dated.entries()]
      .sort(([left], [right]) => {
        if (left === 'unknown') return 1;
        if (right === 'unknown') return -1;
        return left.localeCompare(right);
      })
      .map(([key, entries]) => ({
        key,
        label: key === 'unknown' ? 'Дата уточняется' : this.dateLabel(key),
        entries,
      }));
  });

  constructor() {
    effect(() => {
      if (this.user.isInitialized() && !this.user.isAuthenticated()) {
        untracked(() => void this.router.navigate(['/login']));
      }
    });
  }

  episodeLabel(entry: CalendarEntry): string {
    return `${(entry.episodesAired ?? 0) + 1} серия`;
  }

  timeLabel(timestamp: number | undefined): string {
    return timestamp
      ? new Intl.DateTimeFormat('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        }).format(timestamp * 1000)
      : 'Время неизвестно';
  }

  private dateKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private dateLabel(key: string): string {
    const date = new Date(`${key}T00:00:00`);
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    if (key === this.dateKey(today)) return 'Сегодня';
    if (key === this.dateKey(tomorrow)) return 'Завтра';

    return new Intl.DateTimeFormat('ru-RU', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(date);
  }
}
