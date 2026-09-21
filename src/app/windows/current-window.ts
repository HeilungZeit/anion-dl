import { parseWindowTarget, type WindowTarget } from './window-target';

let resolved: WindowTarget | null = null;

/**
 * Назначение этого вебвью. Считается один раз: адрес окна плеера переписывается
 * при старте (см. `applyWindowTarget`), и повторный разбор `location` дал бы
 * уже обычное окно.
 */
export function currentWindowTarget(): WindowTarget {
  resolved ??= parseWindowTarget(window.location.search);

  return resolved;
}

/**
 * Перевести адрес окна в маршрут **до** первой навигации роутера.
 *
 * Иначе окно плеера сначала показало бы главную (`index.html` не совпадает ни
 * с одним маршрутом и уходит в `**` → `''`), и только потом серию.
 */
export function applyWindowTarget(): void {
  const target = currentWindowTarget();

  if (target.kind === 'player') {
    window.history.replaceState(null, '', target.route);
  }
}
