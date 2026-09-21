import { describe, expect, test } from 'bun:test';

import {
  parseWindowTarget,
  playerWindowLabel,
  playerWindowUrl,
} from './window-target';

describe('parseWindowTarget', () => {
  test('без параметров — обычное окно приложения', () => {
    expect(parseWindowTarget('')).toEqual({ kind: 'shell', route: '/' });
  });

  test('окно плеера получает свой маршрут', () => {
    expect(parseWindowTarget('?w=player&r=%2Fplay%2Fabc')).toEqual({
      kind: 'player',
      route: '/play/abc',
    });
  });

  test('маршрут с параметрами серии переживает круговой путь', () => {
    const route = '/anime/5?episode=8&dubbing=Студийная банда';
    const search = playerWindowUrl(route).slice('index.html'.length);

    expect(parseWindowTarget(search)).toEqual({ kind: 'player', route });
  });

  // Пустое окно плеера бесполезно, а пустое главное окно — рабочее.
  test('маршрут без ведущего слеша не открывает плеер', () => {
    expect(parseWindowTarget('?w=player&r=play/abc').kind).toBe('shell');
  });

  test('окно плеера без маршрута не открывает плеер', () => {
    expect(parseWindowTarget('?w=player').kind).toBe('shell');
  });
});

describe('playerWindowLabel', () => {
  test('ярлык годится для Tauri: латиница, цифры и дефисы', () => {
    const label = playerWindowLabel('/anime/5?episode=8&dubbing=Аниликс');

    expect(label).toMatch(/^player-[a-z0-9-]+$/);
  });

  test('один маршрут — один ярлык', () => {
    expect(playerWindowLabel('/play/abc')).toBe(playerWindowLabel('/play/abc'));
  });

  // Озвучки приходят кириллицей и из читаемой части ярлыка выпадают целиком:
  // без хвоста-хеша обе серии делили бы одно окно.
  test('разные озвучки одной серии не делят окно', () => {
    const left = playerWindowLabel('/anime/5?episode=8&dubbing=Аниликс');
    const right = playerWindowLabel('/anime/5?episode=8&dubbing=AniLibria');

    expect(left).not.toBe(right);
  });

  test('разные серии одного тайтла не делят окно', () => {
    expect(playerWindowLabel('/anime/5?episode=8')).not.toBe(
      playerWindowLabel('/anime/5?episode=9')
    );
  });
});
