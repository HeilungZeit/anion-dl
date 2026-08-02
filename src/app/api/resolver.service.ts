import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

/**
 * Обёртка над Rust-командой resolve_manifest.
 *
 * Резолв делается непосредственно перед скачиванием, а не заранее для всей
 * очереди: URL сегментов подписан и протухает, так что заготовленный впрок
 * манифест к моменту старта ffmpeg окажется мёртвым.
 */
@Injectable({ providedIn: 'root' })
export class ResolverService {
  /**
   * @param preferredQuality высота кадра. Плеер стартует с 360p, поэтому нужное
   * качество Rust добирает подменой числа в имени манифеста и проверяет запросом.
   */
  resolveManifest(iframeUrl: string, preferredQuality: number): Promise<string> {
    return invoke<string>('resolve_manifest', { iframeUrl, preferredQuality });
  }
}
