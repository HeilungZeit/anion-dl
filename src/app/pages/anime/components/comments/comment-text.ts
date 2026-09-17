/**
 * Разбор текста комментария.
 *
 * Бэк отдаёт не HTML, а собственную разметку: `[спойлер]…[/спойлер]` и
 * `[ник]…[/ник]`. Без разбора эти скобки просто показывались бы зрителю, а
 * спойлер перестал бы быть спойлером.
 */

export type CommentPartKind = 'text' | 'spoiler' | 'mention';

export interface CommentPart {
  kind: CommentPartKind;
  content: string;
  /** Уникален среди спойлеров одного комментария: по нему раскрывают нужный. */
  id: number;
}

const MARKUP =
  /\[спойлер(?:="[^"]*")?\]([\s\S]*?)\[\/спойлер\]|\[ник\]([\s\S]*?)\[\/ник\]/gi;

export function parseCommentText(text: string): CommentPart[] {
  const parts: CommentPart[] = [];
  let lastIndex = 0;
  let spoilerId = 0;

  // Регулярка с флагом g носит собственный lastIndex, поэтому экземпляр
  // создаётся на каждый разбор: общий сохранил бы позицию между вызовами.
  const regex = new RegExp(MARKUP.source, MARKUP.flags);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({
        kind: 'text',
        content: text.slice(lastIndex, match.index),
        id: -1,
      });
    }

    if (match[1] !== undefined) {
      parts.push({ kind: 'spoiler', content: match[1], id: spoilerId++ });
    } else if (match[2] !== undefined) {
      parts.push({ kind: 'mention', content: match[2], id: -1 });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push({ kind: 'text', content: text.slice(lastIndex), id: -1 });
  }

  return parts;
}
