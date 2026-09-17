import { inject, Injectable } from '@angular/core';
import { fetch } from '@tauri-apps/plugin-http';

import { API_BASE_URL, CLIENT_HEADER, CLIENT_HEADER_VALUE } from './api.config';

const DEVICE_HEADERS = {
  platform: 'X-Client-Platform',
  os: 'X-Client-OS',
  name: 'X-Device-Name',
} as const;

const DEVICE_NAME = 'Anion Flow';

/**
 * Бэкенд хранит ОС как часть стабильного ключа устройства. Версию намеренно
 * не добавляем: обновление системы не должно создавать ещё одну запись.
 */
function operatingSystem(userAgent: string): string {
  if (userAgent.includes('Windows')) {
    return 'Windows';
  }

  if (userAgent.includes('Macintosh') || userAgent.includes('Mac OS')) {
    return 'macOS';
  }

  return userAgent.includes('Linux') ? 'Linux' : 'Unknown OS';
}

/**
 * Машиночитаемые коды ошибок бэка. Значения — часть публичного контракта
 * (`anion-go/pkg/errors/errors.go`): текст сообщения меняется, код — нет,
 * поэтому ветвиться надо именно по нему.
 */
export const ApiErrorCode = {
  Internal: 'INTERNAL_ERROR',
  NotFound: 'NOT_FOUND',
  BadRequest: 'BAD_REQUEST',
  ValidationFailed: 'VALIDATION_FAILED',
  Unauthorized: 'UNAUTHORIZED',
  Forbidden: 'FORBIDDEN',
  RateLimited: 'RATE_LIMITED',
  UpstreamError: 'UPSTREAM_ERROR',
  UpstreamUnavailable: 'UPSTREAM_UNAVAILABLE',
  UpstreamTimeout: 'UPSTREAM_TIMEOUT',
  NotConfigured: 'NOT_CONFIGURED',
  BookmarkNotFound: 'BOOKMARK_NOT_FOUND',
  SessionNotFound: 'SESSION_NOT_FOUND',
  CaptchaInvalid: 'CAPTCHA_INVALID',
  CaptchaRequired: 'CAPTCHA_REQUIRED',
  TooManyAttempts: 'TOO_MANY_ATTEMPTS',
} as const;

export type ApiErrorCodeValue = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

/** Тело, которое отдаёт любой упавший эндпоинт (`handlers.ErrorResponse`). */
interface ApiErrorBody {
  error?: string;
  code?: string;
  message?: string;
  statusCode?: number;
  details?: Record<string, string>;
}

/**
 * Ошибка запроса с кодом бэка. Обычный Error здесь не годится: форме входа
 * нужно отличать «неверный пароль» от «теперь нужна капча» и от «подождите
 * пять минут», а по тексту это не сделать.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, string> = {}
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function hasApiErrorCode(error: unknown, code: string): boolean {
  return isApiError(error) && error.code === code;
}

/**
 * Сколько ждать до следующей попытки, в секундах.
 *
 * Берётся из `details.retryAfter`, а не из заголовка `Retry-After`: бэк кладёт
 * значение в оба места именно потому, что заголовок читается не везде.
 */
export function getRetryAfterSeconds(error: unknown): number | null {
  if (!isApiError(error)) {
    return null;
  }

  const raw = Number(error.details['retryAfter']);
  return Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : null;
}

/**
 * Единственное место, где приложение ходит в API anion-go.
 *
 * Используется fetch из tauri-plugin-http, а не браузерный: запрос уходит через
 * Rust и потому не подчиняется браузерной CORS-политике. Origin всё равно
 * должен быть разрешён в Tauri capabilities.
 *
 * Сессия здесь нигде не видна и это правильно: у плагина есть собственный
 * персистентный cookie jar (фича `cookies` включена по умолчанию), и куку
 * `X-Session-ID` он возит сам. Подставить заголовок `Cookie` вручную всё равно
 * нельзя — плагин молча выбрасывает его как forbidden header по fetch spec.
 */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly baseUrl = inject(API_BASE_URL);

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const headers: Record<string, string> = {
      [CLIENT_HEADER]: CLIENT_HEADER_VALUE,
      [DEVICE_HEADERS.platform]: 'desktop',
      [DEVICE_HEADERS.os]: operatingSystem(navigator.userAgent),
      [DEVICE_HEADERS.name]: DEVICE_NAME,
      Accept: 'application/json',
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      throw await this.toError(response, path);
    }

    // 204 — штатный ответ «данных нет», а не ошибка. Пустую строку нельзя
    // отдавать в json(): она упадёт разбором.
    if (response.status === 204) {
      return null as T;
    }

    return (await response.json()) as T;
  }

  private async toError(response: Response, path: string): Promise<ApiError> {
    // Vercel отдаёт свой JS-челлендж тоже под кодом 429, и раньше это
    // выглядело как рейт-лимит бэка — на самом деле запрос до бэка не доходит
    // вовсе. Отличаем по заголовку, который ставит edge.
    if (response.headers.get('x-vercel-mitigated')) {
      return new ApiError(
        response.status,
        ApiErrorCode.Forbidden,
        'Запрос заблокирован защитой Vercel (Attack Challenge Mode): она требует ' +
          'выполнить JS-проверку, чего приложение сделать не может. Отключите ' +
          'челлендж или добавьте правило обхода для API.'
      );
    }

    const body = await this.readErrorBody(response);

    if (body) {
      return new ApiError(
        response.status,
        body.code ?? ApiErrorCode.Internal,
        body.message || body.error || this.fallbackMessage(response, path),
        body.details ?? {}
      );
    }

    return new ApiError(
      response.status,
      ApiErrorCode.Internal,
      this.fallbackMessage(response, path)
    );
  }

  /**
   * Тело ошибки — не всегда JSON: edge-заглушки и прокси отвечают HTML. Разбор
   * поэтому в try/catch, иначе поверх настоящей ошибки прилетела бы ошибка
   * парсинга и настоящая потерялась бы.
   */
  private async readErrorBody(
    response: Response
  ): Promise<ApiErrorBody | null> {
    try {
      const parsed: unknown = await response.json();
      return parsed && typeof parsed === 'object'
        ? (parsed as ApiErrorBody)
        : null;
    } catch {
      return null;
    }
  }

  private fallbackMessage(response: Response, path: string): string {
    if (response.status === 429) {
      return 'Бэк ограничил частоту запросов (429). Подождите немного.';
    }

    return `Запрос ${path} завершился со статусом ${response.status}`;
  }
}
