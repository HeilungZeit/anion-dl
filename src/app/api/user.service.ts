import { computed, inject, Injectable, signal } from '@angular/core';

import type {
  Challenge,
  LoginPayload,
  LoginResponse,
  UserResponse,
} from './account.types';
import { ApiClient } from './http';

/**
 * Состояние аккаунта.
 *
 * Токена на клиенте нет и не должно быть: бэк ставит сессию httpOnly-кукой
 * `X-Session-ID`, а возит её cookie jar плагина http. Поэтому единственный
 * способ узнать, вошли мы или нет, — спросить `GET /user`; локально
 * запоминать «вошли» нельзя, сессия протухает на сервере.
 *
 * `isInitialized` существует ради редиректов: без него страница под
 * авторизацией успела бы отправить гостя на /login ещё до первого ответа
 * `fetchUser()`.
 */
@Injectable({ providedIn: 'root' })
export class UserService {
  private readonly api = inject(ApiClient);

  private readonly state = signal<UserResponse | null>(null);
  private readonly initialized = signal(false);

  readonly user = this.state.asReadonly();
  readonly isInitialized = this.initialized.asReadonly();
  readonly isAuthenticated = computed(() => this.state() !== null);
  readonly isAdmin = computed(() => this.state()?.role === 'admin');

  /** Имя для шапки: username, а при его отсутствии — часть адреса до собаки. */
  readonly displayName = computed(() => {
    const user = this.state();
    if (!user) {
      return '';
    }

    return user.username || user.email.split('@')[0] || '';
  });

  async fetchUser(): Promise<void> {
    try {
      this.state.set(await this.api.get<UserResponse>('/user'));
    } catch {
      // Любая неудача здесь означает «не вошли»: и отсутствие куки (бэк
      // отвечает 403 с кодом UNAUTHORIZED), и протухшую сессию, и обрыв сети.
      // Различать их незачем — гость и гость.
      this.state.set(null);
    } finally {
      this.initialized.set(true);
    }
  }

  /** Бросает ApiError: форме входа нужен код, чтобы показать капчу или отсчёт. */
  async login(payload: LoginPayload): Promise<void> {
    const response = await this.api.post<LoginResponse>('/user/login', payload);
    this.state.set(response);
    this.initialized.set(true);
  }

  loginChallenge(): Promise<Challenge> {
    return this.api.get<Challenge>('/user/login-challenge');
  }

  async logout(): Promise<void> {
    try {
      await this.api.post<unknown>('/user/logout');
    } catch {
      // Сессии на сервере может уже не быть (404 SESSION_NOT_FOUND). Для
      // пользователя это всё равно выход, поэтому состояние чистим всегда.
    }

    this.state.set(null);
  }
}
