import { describe, expect, test } from 'bun:test';

import { parseCommentText } from './comment-text';

describe('parseCommentText', () => {
  test('обычный текст остаётся одним куском', () => {
    expect(parseCommentText('просто текст')).toEqual([
      { kind: 'text', content: 'просто текст', id: -1 },
    ]);
  });

  test('спойлер вырезается из текста', () => {
    const parts = parseCommentText('до [спойлер]тайна[/спойлер] после');

    expect(parts.map((p) => p.kind)).toEqual(['text', 'spoiler', 'text']);
    expect(parts[1].content).toBe('тайна');
  });

  test('спойлер с подписью тоже разбирается', () => {
    const parts = parseCommentText('[спойлер="глава 3"]тайна[/спойлер]');

    expect(parts).toEqual([{ kind: 'spoiler', content: 'тайна', id: 0 }]);
  });

  test('спойлеры нумеруются, чтобы раскрывался нужный', () => {
    const parts = parseCommentText(
      '[спойлер]раз[/спойлер] и [спойлер]два[/спойлер]'
    );

    expect(parts.filter((p) => p.kind === 'spoiler').map((p) => p.id)).toEqual([
      0, 1,
    ]);
  });

  test('упоминание отделяется от текста', () => {
    const parts = parseCommentText('привет, [ник]Вася[/ник]!');

    expect(parts.map((p) => p.kind)).toEqual(['text', 'mention', 'text']);
    expect(parts[1].content).toBe('Вася');
  });

  test('многострочный спойлер не обрывается на переводе строки', () => {
    const parts = parseCommentText('[спойлер]первая\nвторая[/спойлер]');

    expect(parts[0].content).toBe('первая\nвторая');
  });

  test('повторный разбор не зависит от прошлого вызова', () => {
    const text = '[спойлер]тайна[/спойлер]';

    // Общая регулярка с флагом g сохранила бы lastIndex и во второй раз
    // вернула бы другой результат — ровно эту ловушку и проверяем.
    expect(parseCommentText(text)).toEqual(parseCommentText(text));
  });

  test('незакрытый тег остаётся обычным текстом', () => {
    expect(parseCommentText('[спойлер]без конца')).toEqual([
      { kind: 'text', content: '[спойлер]без конца', id: -1 },
    ]);
  });
});
