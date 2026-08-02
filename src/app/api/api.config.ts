import { InjectionToken } from '@angular/core';

/**
 * База API. Локальный anion-go по умолчанию.
 *
 * Прод-адрес сюда подставлять нельзя без правки capabilities: разрешённые хосты
 * перечислены в src-tauri/capabilities/default.json, и запрос на неразрешённый
 * origin плагин отклонит.
 */
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', {
  providedIn: 'root',
  factory: () => 'http://localhost:8080/api',
});
