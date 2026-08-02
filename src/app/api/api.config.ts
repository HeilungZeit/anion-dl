import { InjectionToken } from '@angular/core';

/**
 * База публичного API anion.online, разрешённая в Tauri capabilities.
 *
 * Именно `/proxy/api`, а не `/api`: на Vercel `/api/*` — каталог серверлес-функций
 * (там только SSR-рендер), и запросы туда отдают 404. Прокси к anion-go живёт на
 * `/proxy/api` — тот же путь использует сам сайт.
 */
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', {
  providedIn: 'root',
  factory: () => 'https://anion.online/proxy/api',
});

/**
 * Метка клиента для правила обхода в Vercel WAF.
 *
 * Нужна потому, что Attack Challenge Mode отдаёт JS-проверку под кодом 429, а
 * приложение ходит через Rust-клиент и выполнить её не может — до бэка запрос
 * просто не доходит.
 *
 * Это НЕ секрет: приложение открытое, значение видно и в исходниках, и в
 * бинаре. Оно отсекает массовые сканеры, которые заголовок не шлют, но не
 * остановит того, кто откроет DevTools. Если понадобится настоящая защита —
 * нужен серверный токен, а не заголовок клиента.
 */
export const CLIENT_HEADER = 'X-Anion-Client';

export const CLIENT_HEADER_VALUE = 'anion-dl';
