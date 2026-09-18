import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    title: 'Главная — Anion Flow',
    loadComponent: () =>
      import('./pages/feed/feed.component').then((m) => m.FeedComponent),
  },
  {
    path: 'catalog',
    title: 'Каталог — Anion Flow',
    loadComponent: () =>
      import('./pages/catalog/catalog.component').then(
        (m) => m.CatalogComponent
      ),
  },
  {
    path: 'anime/:id',
    title: 'Аниме — Anion Flow',
    loadComponent: () =>
      import('./pages/anime/anime.component').then((m) => m.AnimeComponent),
  },
  {
    path: 'login',
    title: 'Вход — Anion Flow',
    loadComponent: () =>
      import('./pages/login/login.component').then((m) => m.LoginComponent),
  },
  {
    path: 'downloads',
    title: 'Загрузки — Anion Flow',
    loadComponent: () =>
      import('./pages/downloads/downloads.component').then(
        (m) => m.DownloadsComponent
      ),
  },
  {
    path: 'play/:taskId',
    title: 'Просмотр — Anion Flow',
    loadComponent: () =>
      import('./pages/play/play.component').then((m) => m.PlayComponent),
  },
  {
    path: 'bookmarks',
    redirectTo: 'bookmarks/watching',
    pathMatch: 'full',
  },
  {
    path: 'bookmarks/:status',
    title: 'Закладки — Anion Flow',
    loadComponent: () =>
      import('./pages/bookmarks/bookmarks.component').then(
        (m) => m.BookmarksComponent
      ),
  },
  {
    path: 'schedule',
    title: 'Расписание — Anion Flow',
    loadComponent: () =>
      import('./pages/schedule/schedule.component').then(
        (m) => m.ScheduleComponent
      ),
  },
  {
    path: 'seasons',
    title: 'Сезоны — Anion Flow',
    loadComponent: () =>
      import('./pages/seasons/seasons.component').then(
        (m) => m.SeasonsComponent
      ),
  },
  {
    path: 'search',
    title: 'Поиск — Anion Flow',
    loadComponent: () =>
      import('./pages/search/search.component').then((m) => m.SearchComponent),
  },
  {
    path: '**',
    redirectTo: '',
  },
];
