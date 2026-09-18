import { describe, expect, test } from 'bun:test';

import { summarizeDownloads } from './download-notice';

const task = (episode: string) => ({ title: 'Фрирен', episode });

describe('summarizeDownloads', () => {
  test('stays silent when nothing finished', () => {
    expect(summarizeDownloads([], [])).toBeNull();
  });

  test('names a single episode', () => {
    expect(summarizeDownloads([task('3')], [])).toEqual({
      title: 'Серия скачана',
      body: 'Фрирен — серия 3',
    });
  });

  test('counts a batch', () => {
    expect(summarizeDownloads([task('1'), task('2')], [])?.body).toBe(
      'Скачано серий: 2'
    );
  });

  test('reports failures', () => {
    expect(summarizeDownloads([], [task('4')])?.title).toBe(
      'Загрузка не удалась'
    );
    expect(summarizeDownloads([task('1')], [task('2')])).toEqual({
      title: 'Загрузки завершены с ошибками',
      body: 'Скачано: 1, с ошибкой: 1',
    });
  });
});
