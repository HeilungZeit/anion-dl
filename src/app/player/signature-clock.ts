/**
 * Срок жизни подписи в URL Kodik.
 *
 * Перенос `SignatureClock` из anion-tv. Подпись живёт до часа, зашитого в путь
 * манифеста: `…/0ba8f24…:2026091809/720.mp4:hls:manifest.m3u8` — проверено на
 * живой серии 17.09.2026. Ломается не старт, а середина длинной серии, поэтому
 * поток обновляется заранее, а не по факту 403.
 */

/** За сколько до конца срока обновлять поток. */
export const SIGNATURE_LEAD_SECONDS = 5 * 60;

/**
 * Десять цифр после двоеточия и перед слэшем или концом строки.
 *
 * Остальные двоеточия в URL (`720.mp4:hls:manifest.m3u8`) цифр за собой не
 * несут и под шаблон не попадают.
 */
const STAMP = /:(\d{10})(?:\/|$)/;

/** Время истечения подписи в миллисекундах эпохи; null — штампа в URL нет. */
export function expiryEpochMs(manifestUrl: string): number | null {
  const digits = STAMP.exec(manifestUrl)?.[1];
  if (!digits) {
    return null;
  }

  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const hour = Number(digits.slice(8, 10));

  // Проверка обязательна: десять цифр после двоеточия может дать и обычный
  // идентификатор. Без неё мусорный «штамп» превратился бы в дату далёкого
  // прошлого, и плеер переролвил бы поток на каждом тике.
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23) {
    return null;
  }

  return Date.UTC(year, month - 1, day, hour, 0, 0, 0);
}

/**
 * Пора ли обновлять поток.
 *
 * Отсутствие штампа — не повод обновляться: у ссылки просто нет известного
 * срока, и дёргать резолвер вслепую незачем.
 */
export function shouldRefreshAhead(
  manifestUrl: string,
  nowMs: number = Date.now(),
  leadSeconds: number = SIGNATURE_LEAD_SECONDS
): boolean {
  const expiry = expiryEpochMs(manifestUrl);
  return expiry !== null && nowMs >= expiry - leadSeconds * 1000;
}
