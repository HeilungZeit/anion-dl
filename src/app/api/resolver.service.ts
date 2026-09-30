import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

/**
 * Поток серии: манифест и заголовки, без которых CDN его не отдаст.
 * Зеркало `resolver::Stream` — загрузчик передаёт его в Rust как есть.
 */
export interface ResolvedStream {
  url: string;
  referer: string | null;
  userAgent: string | null;
  /** Высота кадра, если источник её знает; у Kodik она в имени манифеста. */
  height: number | null;
}

/**
 * Обёртка над Rust-командой resolve_manifest.
 *
 * Резолв делается непосредственно перед скачиванием, а не заранее для всей
 * очереди: URL сегментов подписан и протухает, так что заготовленный впрок
 * манифест к моменту старта ffmpeg окажется мёртвым.
 *
 * Первый аргумент — локатор серии: URL плеера Kodik или `cvh:<vkId>`.
 */
@Injectable({ providedIn: 'root' })
export class ResolverService {
  /**
   * @param preferredQuality высота кадра. Если такой нет, Rust берёт лучшую
   * доступную ниже.
   */
  resolveStream(
    iframeUrl: string,
    preferredQuality: number
  ): Promise<ResolvedStream> {
    return invoke<ResolvedStream>('resolve_manifest', {
      iframeUrl,
      preferredQuality,
    });
  }

  /**
   * Адрес для плеера. Kodik — прямой URL CDN; поток, которому нужны
   * заголовки, недоступные вебвью (CDNVideoHub), — адрес прокси
   * `stream://…`, см. `stream_proxy.rs`.
   */
  resolvePlayback(
    iframeUrl: string,
    preferredQuality: number
  ): Promise<string> {
    return invoke<string>('resolve_playback', {
      iframeUrl,
      preferredQuality,
    });
  }

  /**
   * Меняет качество потока плеера. У Kodik — подменой в уже подписанном URL,
   * у потока через прокси — новым резолвом той же серии.
   */
  changeManifestQuality(
    manifestUrl: string,
    preferredQuality: number
  ): Promise<string> {
    return invoke<string>('change_manifest_quality', {
      manifestUrl,
      preferredQuality,
    });
  }
}
