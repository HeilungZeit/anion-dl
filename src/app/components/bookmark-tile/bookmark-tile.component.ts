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

interface AnimeStatusOption {
  alias: string;
  label: string;
}

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
  update = output<{
    bookmark: Bookmark;
    status: BookmarkStatusValue;
    animeStatus: string;
  }>();

  readonly animeStatusOptions: AnimeStatusOption[] = [
    { alias: 'ongoing', label: 'Онгоинг' },
    { alias: 'released', label: 'Вышло' },
    { alias: 'anons', label: 'Анонс' },
  ];

  isEditing = signal(false);
  editedStatus = signal<BookmarkStatusValue | null>(null);
  editedAnimeStatus = signal<string>('ongoing');
  showStatusDropdown = signal(false);
  showAnimeStatusDropdown = signal(false);
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
    const alias = this.bookmark().animeStatus;
    return this.animeStatusOptions.find((option) => option.alias === alias)?.label ?? 'Статус неизвестен';
  }

  get currentStatusLabel(): string {
    const status = this.editedStatus() || this.bookmark().status;
    const found = this.allStatuses().find((s) => s.status === status);
    return found?.label || status;
  }

  get currentAnimeStatusLabel(): string {
    const alias = this.editedAnimeStatus();
    return this.animeStatusOptions.find((o) => o.alias === alias)?.label ?? alias;
  }

  onEdit() {
    const b = this.bookmark();
    this.editedStatus.set(b.status);
    this.editedAnimeStatus.set(b.animeStatus || 'ongoing');
    this.isEditing.set(true);
  }

  onCancelEdit() {
    this.isEditing.set(false);
    this.editedStatus.set(null);
    this.showStatusDropdown.set(false);
    this.showAnimeStatusDropdown.set(false);
  }

  onSaveEdit() {
    const status = this.editedStatus();
    if (!status) return;

    this.update.emit({
      bookmark: this.bookmark(),
      status,
      animeStatus: this.editedAnimeStatus(),
    });
    this.isEditing.set(false);
    this.showStatusDropdown.set(false);
    this.showAnimeStatusDropdown.set(false);
  }

  onSelectStatus(status: BookmarkStatusValue) {
    this.editedStatus.set(status);
    this.showStatusDropdown.set(false);
  }

  onSelectAnimeStatus(alias: string) {
    this.editedAnimeStatus.set(alias);
    this.showAnimeStatusDropdown.set(false);
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
