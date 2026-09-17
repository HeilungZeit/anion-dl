import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TuiButton, TuiIcon } from '@taiga-ui/core';

import { BookmarksService } from '../../api/bookmarks.service';
import { UserService } from '../../api/user.service';
import { CalendarEntry } from '../../api/account.types';
import { TimeUntilPipe } from '../../pipes/time-until.pipe';

interface DayGroup {
  label: string;
  date: Date;
  isToday: boolean;
  isTomorrow: boolean;
  entries: CalendarEntry[];
}

@Component({
  selector: 'app-schedule',
  imports: [RouterLink, TuiIcon, TuiButton, TimeUntilPipe],
  templateUrl: './schedule.component.html',
  styleUrl: './schedule.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScheduleComponent {
  private bookmarksService = inject(BookmarksService);
  private router = inject(Router);
  protected userStore = inject(UserService);

  isLoading = signal(true);
  errorMessage = signal<string | null>(null);
  entries = signal<CalendarEntry[]>([]);
  // Группы-дни скелетона: числа — количество карточек в дне. Неровные значения
  // не случайны, они повторяют типичную форму расписания, где в дне 2–4 релиза.
  readonly skeletonDays = [[1, 2, 3, 4], [1, 2], [1, 2, 3], [1, 2]];

  constructor() {
    effect(() => {
      const isInitialized = this.userStore.isInitialized();
      const isAuthenticated = this.userStore.isAuthenticated();
      if (isInitialized && !isAuthenticated) {
        this.router.navigate(['/login']);
      } else if (isInitialized && isAuthenticated) {
        this.loadCalendar();
      }
    });
  }

  async loadCalendar(): Promise<void> {
    this.isLoading.set(true);
    this.errorMessage.set(null);
    try {
      const data = await this.bookmarksService.getCalendar();
      this.entries.set(data);
    } catch (err: unknown) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Ошибка при загрузке расписания');
    } finally {
      this.isLoading.set(false);
    }
  }

  readonly scheduledEntries = computed(() =>
    this.entries().filter((e) => !!e.nextEpisodeDate)
  );

  readonly unscheduledEntries = computed(() =>
    this.entries().filter((e) => !e.nextEpisodeDate)
  );

  readonly dayGroups = computed<DayGroup[]>(() => {
    const scheduled = this.scheduledEntries();
    if (!scheduled.length) return [];

    const map = new Map<string, CalendarEntry[]>();

    for (const entry of scheduled) {
      const d = new Date(entry.nextEpisodeDate! * 1000);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(entry);
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const groups: DayGroup[] = [];

    for (const [, dayEntries] of map) {
      const d = new Date(dayEntries[0].nextEpisodeDate! * 1000);
      const dayStart = new Date(d);
      dayStart.setHours(0, 0, 0, 0);

      groups.push({
        label: this.formatDayLabel(d),
        date: d,
        isToday: dayStart.getTime() === today.getTime(),
        isTomorrow: dayStart.getTime() === tomorrow.getTime(),
        entries: dayEntries,
      });
    }

    return groups.sort((a, b) => a.date.getTime() - b.date.getTime());
  });

  readonly todayEntriesCount = computed(
    () => this.dayGroups().find((group) => group.isToday)?.entries.length ?? 0
  );

  formatTime(timestamp: number): string {
    return new Date(timestamp * 1000).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private formatDayLabel(date: Date): string {
    return date.toLocaleDateString('ru-RU', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
  }

  entriesCountLabel(count: number): string {
    const mod10 = count % 10;
    const mod100 = count % 100;

    if (mod10 === 1 && mod100 !== 11) {
      return 'релиз';
    }

    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
      return 'релиза';
    }

    return 'релизов';
  }
}
