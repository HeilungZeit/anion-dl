import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';

import { AnimeService, type CommentsQuery } from '../../../../api/anime.service';
import type { Comment } from '../../../../api/anime.types';
import { absoluteMediaUrl } from '../../../../api/media-url';
import { parseCommentText, type CommentPart } from './comment-text';

const PAGE_SIZE = 20;

type Sort = CommentsQuery['sort'];

/** Секция комментариев под описанием — как на фронте, внизу первой вкладки. */
@Component({
  selector: 'app-comments',
  templateUrl: './comments.component.html',
  styleUrl: './comments.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CommentsComponent {
  private readonly api = inject(AnimeService);

  readonly animeId = input.required<number>();

  readonly comments = signal<readonly Comment[]>([]);
  readonly isLoading = signal(false);
  readonly errorText = signal('');
  readonly hasMore = signal(false);
  readonly sort = signal<Sort>('new');

  readonly replies = signal<ReadonlyMap<number, readonly Comment[]>>(new Map());
  private readonly openThreads = signal<ReadonlySet<number>>(new Set());
  private readonly revealed = signal<ReadonlySet<string>>(new Set());

  /** Отсекает ответы по тайтлу или сортировке, которые уже сменили. */
  private generation = 0;

  constructor() {
    effect(() => {
      const id = this.animeId();
      const sort = this.sort();

      void this.reload(id, sort);
    });
  }

  /** Аватарка приходит без схемы — в вебвью такой адрес не грузится. */
  avatar(comment: Comment): string {
    return absoluteMediaUrl(comment.avatars.small);
  }

  parts(comment: Comment): CommentPart[] {
    return parseCommentText(comment.text);
  }

  isRevealed(comment: Comment, part: CommentPart): boolean {
    return this.revealed().has(`${comment.id}:${part.id}`);
  }

  reveal(comment: Comment, part: CommentPart): void {
    this.revealed.update((current) => {
      const next = new Set(current);
      next.add(`${comment.id}:${part.id}`);
      return next;
    });
  }

  isThreadOpen(comment: Comment): boolean {
    return this.openThreads().has(comment.id);
  }

  async toggleThread(comment: Comment): Promise<void> {
    if (this.isThreadOpen(comment)) {
      this.openThreads.update((current) => {
        const next = new Set(current);
        next.delete(comment.id);
        return next;
      });
      return;
    }

    this.openThreads.update((current) => new Set(current).add(comment.id));

    if (this.replies().has(comment.id)) {
      return;
    }

    try {
      const loaded = await this.api.getCommentReplies(comment.id);

      this.replies.update((current) =>
        new Map(current).set(comment.id, loaded)
      );
    } catch {
      // Ветку ответов не открыли — не повод рушить всю секцию. Тред просто
      // останется пустым, а основной список работает.
      this.replies.update((current) => new Map(current).set(comment.id, []));
    }
  }

  async loadMore(): Promise<void> {
    if (this.isLoading()) {
      return;
    }

    const token = this.generation;
    this.isLoading.set(true);

    try {
      const page = await this.api.getComments(this.animeId(), {
        limit: PAGE_SIZE,
        offset: this.comments().length,
        sort: this.sort(),
      });

      if (token !== this.generation) {
        return;
      }

      this.comments.update((current) => [...current, ...page]);
      this.hasMore.set(page.length === PAGE_SIZE);
    } catch (error: unknown) {
      if (token === this.generation) {
        this.errorText.set(
          error instanceof Error ? error.message : 'Не удалось загрузить'
        );
      }
    } finally {
      if (token === this.generation) {
        this.isLoading.set(false);
      }
    }
  }

  changeSort(sort: Sort): void {
    if (sort !== this.sort()) {
      this.sort.set(sort);
    }
  }

  /** «3 дня назад» читается лучше, чем дата с временем. */
  formatTime(unixSecs: number): string {
    const diffSecs = Math.max(0, Date.now() / 1000 - unixSecs);

    // Пары «граница — единица» одним списком: параллельные массивы границ и
    // делителей слишком легко разъехаться при правке.
    const scale: readonly {
      limit: number;
      secs: number;
      unit: Intl.RelativeTimeFormatUnit;
    }[] = [
      { limit: 60, secs: 1, unit: 'second' },
      { limit: 3600, secs: 60, unit: 'minute' },
      { limit: 86400, secs: 3600, unit: 'hour' },
      { limit: 2592000, secs: 86400, unit: 'day' },
      { limit: 31536000, secs: 2592000, unit: 'month' },
      { limit: Number.POSITIVE_INFINITY, secs: 31536000, unit: 'year' },
    ];

    const step = scale.find((item) => diffSecs < item.limit) ?? scale[0];

    return new Intl.RelativeTimeFormat('ru', { numeric: 'auto' }).format(
      -Math.floor(diffSecs / step.secs),
      step.unit
    );
  }

  private async reload(animeId: number, sort: Sort): Promise<void> {
    const token = ++this.generation;

    this.comments.set([]);
    this.replies.set(new Map());
    this.openThreads.set(new Set());
    this.errorText.set('');
    this.isLoading.set(true);

    try {
      const page = await this.api.getComments(animeId, {
        limit: PAGE_SIZE,
        offset: 0,
        sort,
      });

      if (token !== this.generation) {
        return;
      }

      this.comments.set(page);
      this.hasMore.set(page.length === PAGE_SIZE);
    } catch (error: unknown) {
      if (token === this.generation) {
        this.errorText.set(
          error instanceof Error ? error.message : 'Не удалось загрузить'
        );
      }
    } finally {
      if (token === this.generation) {
        this.isLoading.set(false);
      }
    }
  }
}
