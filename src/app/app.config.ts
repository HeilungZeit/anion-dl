import {
  ApplicationConfig,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import {
  provideRouter,
  withComponentInputBinding,
  withInMemoryScrolling,
} from '@angular/router';
import { provideTaiga } from '@taiga-ui/core';

import { routes } from './app.routes';
import { applyWindowTarget } from './windows/current-window';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    // Строго до provideRouter: окно плеера открывается по `index.html?…`, и
    // маршрут должен оказаться в адресе раньше первой навигации роутера.
    provideAppInitializer(applyWindowTarget),
    provideRouter(
      routes,
      withInMemoryScrolling({
        scrollPositionRestoration: 'top',
        anchorScrolling: 'disabled',
      }),
      withComponentInputBinding()
    ),
    provideTaiga(),
  ],
};
