import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TuiIcon } from '@taiga-ui/core';

import { isCvhDubbing, voiceOf } from '../api/video-source';
import type { NativePlaybackOption } from './native-playback-option';

const RANGE_SIZE = 100;

/** Только интерфейс выбора. Потоки загружает плеер, каталог хранит родитель. */
@Component({
  selector: 'app-playback-picker',
  imports: [TuiIcon],
  templateUrl: './playback-picker.component.html',
  styleUrl: './playback-picker.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlaybackPickerComponent {
  readonly options = input.required<readonly NativePlaybackOption[]>();
  readonly currentUrl = input.required<string>();
  readonly pendingUrl = input<string | null>(null);
  readonly error = input('');
  readonly choose = output<string>();
  readonly closed = output<void>();
  readonly tab = signal<'episodes' | 'dubbing'>('episodes');
  readonly range = signal(0);
  readonly voiceOf = voiceOf;
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');
  readonly current = computed(() => this.options().find((option) => option.iframeUrl === this.currentUrl()));
  readonly episodes = computed(() =>
    this.options()
      .filter((option) => option.dubbing === this.current()?.dubbing)
      .sort((a, b) => a.episode - b.episode),
  );
  readonly ranges = computed(() => {
    const episodes = this.episodes();
    return episodes.length > RANGE_SIZE
      ? Array.from({ length: Math.ceil(episodes.length / RANGE_SIZE) }, (_, index) => ({
          index,
          label: `${episodes[index * RANGE_SIZE].episode}–${episodes[Math.min((index + 1) * RANGE_SIZE, episodes.length) - 1].episode}`,
        }))
      : [];
  });
  readonly visibleEpisodes = computed(() =>
    this.ranges().length ? this.episodes().slice(this.range() * RANGE_SIZE, (this.range() + 1) * RANGE_SIZE) : this.episodes(),
  );
  readonly dubbings = computed(() =>
    [...new Set(this.options().map((option) => option.dubbing))].map((name) => {
      const episodes = this.options().filter((option) => option.dubbing === name);
      return {
        name,
        label: voiceOf(name),
        count: episodes.length,
        cvh: isCvhDubbing(name),
        subtitle: name.toLowerCase().startsWith('субтитры'),
        target: episodes.find((option) => option.episode === this.current()?.episode),
      };
    }),
  );
  /** Те же группы, что над плеером на странице тайтла. */
  readonly groups = computed(() =>
    [
      { title: 'Озвучки', items: this.dubbings().filter((item) => !item.cvh && !item.subtitle) },
      { title: 'Субтитры', items: this.dubbings().filter((item) => !item.cvh && item.subtitle) },
      { title: 'CDNVideoHub · до 1080p', items: this.dubbings().filter((item) => item.cvh) },
    ].filter((group) => group.items.length > 0),
  );

  constructor() {
    effect(() => {
      const url = this.currentUrl();
      const index = untracked(() => this.episodes().findIndex((option) => option.iframeUrl === url));
      this.range.set(Math.floor(Math.max(index, 0) / RANGE_SIZE));
    });
    afterRenderEffect(() => {
      const list = this.list()?.nativeElement;
      this.currentUrl();
      this.tab();
      this.range();
      if (list) {
        // Только собственный список: scrollIntoView мог бы прокрутить страницу.
        const active = list.querySelector<HTMLElement>('[aria-current="true"]');
        if (active) list.scrollTop = Math.max(0, active.offsetTop - list.clientHeight / 2);
      }
    });
  }

  selectRange(index: number): void {
    this.range.set(index);
    this.list()?.nativeElement.scrollTo({ top: 0 });
  }
}
