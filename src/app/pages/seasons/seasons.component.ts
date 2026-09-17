import { ChangeDetectionStrategy, Component, computed, inject, input, resource } from '@angular/core';
import { Router } from '@angular/router';
import { TuiLoader } from '@taiga-ui/core';

import { AnimeService } from '../../api/anime.service';
import { AnimeCardComponent } from '../../components/anime-card/anime-card.component';

const SEASONS = [
  { value: 'winter', label: 'Зима' },
  { value: 'spring', label: 'Весна' },
  { value: 'summer', label: 'Лето' },
  { value: 'fall', label: 'Осень' },
] as const;

function currentSeason(month = new Date().getMonth()): string {
  if (month === 11 || month <= 1) return 'winter';
  if (month <= 4) return 'spring';
  if (month <= 7) return 'summer';
  return 'fall';
}

@Component({
  selector: 'app-seasons',
  imports: [AnimeCardComponent, TuiLoader],
  templateUrl: './seasons.component.html',
  styleUrl: './seasons.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SeasonsComponent {
  private readonly api = inject(AnimeService);
  private readonly router = inject(Router);
  readonly year = input<string>(String(new Date().getFullYear()));
  readonly season = input<string>(currentSeason());
  readonly seasons = SEASONS;
  readonly years = Array.from({ length: new Date().getFullYear() - 1964 }, (_, i) => new Date().getFullYear() - i);
  readonly selectedYear = computed(() => {
    const value = Number(this.year());
    return this.years.includes(value) ? value : new Date().getFullYear();
  });
  readonly selectedSeason = computed(() =>
    SEASONS.some((item) => item.value === this.season()) ? this.season() : currentSeason()
  );
  readonly title = computed(() => `${SEASONS.find((item) => item.value === this.selectedSeason())?.label} ${this.selectedYear()}`);
  readonly anime = resource({
    params: () => ({ year: this.selectedYear(), season: this.selectedSeason() }),
    loader: ({ params }) => this.api.getByQuery({
      season: [params.season], fromYear: params.year, toYear: params.year,
      sort: 'views', sortForward: false, limit: 60,
    }),
  });

  select(year: number, season: string): void {
    void this.router.navigate(['/seasons'], { queryParams: { year, season } });
  }

  onYear(event: Event): void {
    this.select(Number((event.target as HTMLSelectElement).value), this.selectedSeason());
  }
}
