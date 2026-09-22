/**
 * Системная карточка «Сейчас играет» и медиаклавиши.
 *
 * Свой мост в ОС (MPNowPlayingInfoCenter, SMTC, MPRIS) не нужен: движок
 * вебвью сам публикует Media Session API в систему — WebKit на macOS и Linux,
 * WebView2 на Windows. Наличие API в WKWebView проверено пробником, включая
 * `setPositionState`. Нативный крейт поверх этого зарегистрировал бы второй
 * источник, и в Пункте управления висели бы две карточки на одну серию.
 */

export interface NowPlaying {
  title: string;
  episode: string;
  dubbing?: string;
  artwork?: string;
}

export interface MediaSessionActions {
  play(): void;
  pause(): void;
  seekBy(deltaSecs: number): void;
  seekTo(secs: number): void;
}

/** Шаг перемотки, если система не прислала свой. */
const DEFAULT_SEEK_SECS = 10;

/** Для `equal` у сигналов: пересоздание объекта не должно менять карточку. */
export function sameNowPlaying(
  a: NowPlaying | null,
  b: NowPlaying | null
): boolean {
  return (
    a?.title === b?.title &&
    a?.episode === b?.episode &&
    a?.dubbing === b?.dubbing &&
    a?.artwork === b?.artwork
  );
}

export function describeNowPlaying(info: NowPlaying): {
  title: string;
  artist: string;
} {
  const parts = [`${info.episode} серия`];
  if (info.dubbing) {
    parts.push(info.dubbing);
  }

  return { title: info.title, artist: parts.join(' · ') };
}

export class MediaSessionBridge {
  private readonly session: MediaSession | null =
    typeof navigator !== 'undefined' && 'mediaSession' in navigator
      ? navigator.mediaSession
      : null;

  bind(actions: MediaSessionActions): void {
    this.handle('play', () => actions.play());
    this.handle('pause', () => actions.pause());
    this.handle('seekbackward', (details) =>
      actions.seekBy(-(details.seekOffset ?? DEFAULT_SEEK_SECS))
    );
    this.handle('seekforward', (details) =>
      actions.seekBy(details.seekOffset ?? DEFAULT_SEEK_SECS)
    );
    this.handle('seekto', (details) => {
      if (details.seekTime !== undefined) {
        actions.seekTo(details.seekTime);
      }
    });
  }

  /**
   * Кнопка «вперёд» в системе есть, только пока есть куда идти: на последней
   * серии она была бы мёртвой.
   */
  setNext(next: (() => void) | null): void {
    this.handle('nexttrack', next ? () => next() : null);
  }

  setMetadata(info: NowPlaying | null, fallbackArtwork: string): void {
    if (!this.session) {
      return;
    }

    if (!info) {
      this.session.metadata = null;
      return;
    }

    const artwork = info.artwork || fallbackArtwork;

    this.session.metadata = new MediaMetadata({
      ...describeNowPlaying(info),
      album: 'Anion Flow',
      artwork: artwork ? [{ src: artwork }] : [],
    });
  }

  setPlaying(playing: boolean): void {
    if (this.session) {
      this.session.playbackState = playing ? 'playing' : 'paused';
    }
  }

  /**
   * Позиция сообщается на событиях, а не на каждом `timeupdate`: дальше
   * система сама ведёт отсчёт по скорости воспроизведения.
   */
  setPosition(video: HTMLVideoElement): void {
    const duration = video.duration;
    if (!this.session || !Number.isFinite(duration) || duration <= 0) {
      return;
    }

    try {
      this.session.setPositionState({
        duration,
        position: Math.min(Math.max(video.currentTime, 0), duration),
        playbackRate: video.playbackRate || 1,
      });
    } catch {
      // Вебвью мог не принять состояние (например, скорость 0) — карточка
      // просто покажет прошлую позицию.
    }
  }

  clear(): void {
    if (!this.session) {
      return;
    }

    for (const action of [
      'play',
      'pause',
      'seekbackward',
      'seekforward',
      'seekto',
      'nexttrack',
    ] as const) {
      this.handle(action, null);
    }

    this.session.metadata = null;
    this.session.playbackState = 'none';
  }

  private handle(
    action: MediaSessionAction,
    handler: MediaSessionActionHandler | null
  ): void {
    try {
      this.session?.setActionHandler(action, handler);
    } catch {
      // Действие не поддержано этим вебвью — остальные работают и без него.
    }
  }
}
