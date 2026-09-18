/**
 * Приведение адресов картинок к абсолютному виду.
 *
 * Бэк отдаёт аватарки комментариев протокол-относительными:
 * `//static.yani.tv/users/small/252090.webp`. В браузере на https такой адрес
 * разворачивается правильно, а в вебвью страница живёт на `tauri://localhost`,
 * и он превращается в `tauri://static.yani.tv/...` — картинки просто не
 * грузятся. Постеры и скриншоты приходят уже абсолютными, их это не касается.
 */
export function absoluteMediaUrl(url: string): string {
  const trimmed = url.trim();

  if (trimmed.startsWith('//')) {
    return `https:${trimmed}`;
  }

  return trimmed;
}
