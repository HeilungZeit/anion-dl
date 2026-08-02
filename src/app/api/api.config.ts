import { InjectionToken } from '@angular/core';

/** База публичного API anion.online, разрешённая в Tauri capabilities. */
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', {
  providedIn: 'root',
  factory: () => 'https://anion.online/api',
});
