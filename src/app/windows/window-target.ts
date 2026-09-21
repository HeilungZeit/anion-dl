/**
 * Адресация окон: какой маршрут открыт в окне и под каким ярлыком оно живёт.
 *
 * Маршрут передаётся окну **запросом, а не путём**. В деве адреса отдаёт
 * `ng serve`, который вернёт `index.html` на любой путь, поэтому окно с
 * адресом `/play/abc` открылось бы нормально. В собранном приложении ассеты
 * отдаёт кастомный протокол по реальным путям файлов: `/play/abc` там не
 * существует, и окно оказалось бы пустым. Один и тот же `index.html` с
 * параметрами работает одинаково в обоих случаях.
 */

export const WINDOW_PARAM = 'w';
export const ROUTE_PARAM = 'r';
export const PLAYER_LABEL_PREFIX = 'player-';

/** Сколько окон плеера разрешено одновременно. */
export const MAX_PLAYER_WINDOWS = 3;

export type WindowKind = 'shell' | 'player';

export interface WindowTarget {
  kind: WindowKind;
  /** Маршрут Angular, с ведущим слешем. */
  route: string;
}

const SHELL: WindowTarget = { kind: 'shell', route: '/' };

/**
 * Разбор `location.search` при старте вебвью.
 *
 * Всё неожиданное трактуется как обычное окно приложения: пустое главное окно
 * пользователь хотя бы сможет использовать, а пустое окно плеера — нет.
 */
export function parseWindowTarget(search: string): WindowTarget {
  const params = new URLSearchParams(search);

  if (params.get(WINDOW_PARAM) !== 'player') {
    return SHELL;
  }

  const route = params.get(ROUTE_PARAM) ?? '';

  return route.startsWith('/') ? { kind: 'player', route } : SHELL;
}

/** Адрес, с которым создаётся окно плеера. */
export function playerWindowUrl(route: string): string {
  const params = new URLSearchParams([
    [WINDOW_PARAM, 'player'],
    [ROUTE_PARAM, route],
  ]);

  return `index.html?${params.toString()}`;
}

/**
 * Ярлык окна — функция от маршрута: повторное открытие той же серии обязано
 * поднять существующее окно, а не создать второе.
 *
 * Читаемая часть обрезается и теряет всё, что не латиница и цифры (озвучки
 * приходят кириллицей), поэтому уникальность держится на хвосте-хеше: без
 * него «Аниликс» и «Студийная банда» дали бы один ярлык.
 */
export function playerWindowLabel(route: string): string {
  const slug = route
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  return `${PLAYER_LABEL_PREFIX}${slug}-${hash(route)}`;
}

export function isPlayerLabel(label: string): boolean {
  return label.startsWith(PLAYER_LABEL_PREFIX);
}

/** FNV-1a: коротко, стабильно между запусками и без зависимостей. */
function hash(value: string): string {
  let result = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193) >>> 0;
  }

  return result.toString(36);
}
