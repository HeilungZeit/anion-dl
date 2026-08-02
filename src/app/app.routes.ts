import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    title: 'Главная — anion-dl',
    loadComponent: () =>
      import('./pages/feed/feed.component').then((m) => m.FeedComponent),
  },
  {
    path: 'catalog',
    title: 'Каталог — anion-dl',
    loadComponent: () =>
      import('./pages/catalog/catalog.component').then(
        (m) => m.CatalogComponent
      ),
  },
  {
    path: 'anime/:id',
    title: 'Аниме — anion-dl',
    loadComponent: () =>
      import('./pages/anime/anime.component').then((m) => m.AnimeComponent),
  },
  {
    path: 'downloads',
    title: 'Загрузки — anion-dl',
    loadComponent: () =>
      import('./pages/downloads/downloads.component').then(
        (m) => m.DownloadsComponent
      ),
  },
  {
    path: '**',
    redirectTo: '',
  },
];
