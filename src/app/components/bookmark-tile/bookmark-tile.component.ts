import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TuiButton, TuiIcon, TuiDropdown, TuiDataList } from '@taiga-ui/core';
import {
  Bookmark,
  BookmarkStatusValue,
} from '../../api/account.types';

interface StatusOption {
  key: string;
  label: string;
  status: BookmarkStatusValue;
  icon: string;
}

/**
 * Подписи статусов тайтла. Статус в закладку пишет сервер из Yani, у анонса
 * там alias `announcement`; `anons` остался у старых закладок, где статус
 * выставляли руками.
 */
const ANIME_STATUS_LABELS: Record<string, string> = {
  ongoing: 'Онгоинг',
  released: 'Вышло',
  announcement: 'Анонс',
  anons: 'Анонс',
};

@Component({
  selector: 'app-bookmark-tile',
  imports: [
    RouterLink,
    FormsModule,
    TuiButton,
    TuiIcon,
    TuiDropdown,
    TuiDataList,
  ],
  templateUrl: './bookmark-tile.component.html',
  styleUrl: './bookmark-tile.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BookmarkTileComponent {

  bookmark = input.required<Bookmark>();
  allStatuses = input.required<readonly StatusOption[]>();

  delete = output<Bookmark>();
  update = output<{ bookmark: Bookmark; status: BookmarkStatusValue }>();

  isEditing = signal(false);
  editedStatus = signal<BookmarkStatusValue | null>(null);
  showStatusDropdown = signal(false);
  showDeleteConfirm = signal(false);
  private readonly refreshedPoster = signal<{
    animeId: number;
    url: string;
  } | null>(null);
  readonly posterUrl = computed(() => {
    const bookmark = this.bookmark();
    const refreshed = this.refreshedPoster();

    return refreshed?.animeId === bookmark.yumiId
      ? refreshed.url
      : bookmark.poster.huge || bookmark.poster.big || 'assets/image-placeholder.svg';
  });

  get episodesText(): string {
    const b = this.bookmark();
    if (b.totalEpisodes > 0) {
      return `${b.watchedEpisodes} / ${b.totalEpisodes}`;
    }
    return `${b.watchedEpisodes} эп.`;
  }

  get progressPercent(): number {
    const { watchedEpisodes, totalEpisodes } = this.bookmark();
    if (totalEpisodes <= 0) return 0;

    return Math.min(100, Math.max(0, Math.round((watchedEpisodes / totalEpisodes) * 100)));
  }

  get animeStatusLabel(): string {
    return ANIME_STATUS_LABELS[this.bookmark().animeStatus] ?? 'Статус неизвестен';
  }

  get isAnnouncement(): boolean {
    const alias = this.bookmark().animeStatus;
    return alias === 'announcement' || alias === 'anons';
  }

  get currentStatusLabel(): string {
    const status = this.editedStatus() || this.bookmark().status;
    const found = this.allStatuses().find((s) => s.status === status);
    return found?.label || status;
  }

  onEdit() {
    this.editedStatus.set(this.bookmark().status);
    this.isEditing.set(true);
  }

  onCancelEdit() {
    this.isEditing.set(false);
    this.editedStatus.set(null);
    this.showStatusDropdown.set(false);
  }

  onSaveEdit() {
    const status = this.editedStatus();
    if (!status) return;

    // Серии считает плеер (watch progress), статус тайтла — сервер по Yani,
    // так что руками правится только список.
    this.update.emit({ bookmark: this.bookmark(), status });
    this.isEditing.set(false);
    this.showStatusDropdown.set(false);
  }

  onSelectStatus(status: BookmarkStatusValue) {
    this.editedStatus.set(status);
    this.showStatusDropdown.set(false);
  }

  onDeleteClick() {
    this.showDeleteConfirm.set(true);
  }

  onConfirmDelete() {
    this.delete.emit(this.bookmark());
    this.showDeleteConfirm.set(false);
  }

  onCancelDelete() {
    this.showDeleteConfirm.set(false);
  }

  onPosterError(): void {
    this.refreshedPoster.set({ animeId: this.bookmark().yumiId, url: 'assets/image-placeholder.svg' });
  }
}
