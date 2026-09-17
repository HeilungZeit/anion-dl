import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { Router } from '@angular/router';
import { openUrl } from '@tauri-apps/plugin-opener';
import { TuiIcon, TuiInput, TuiLoader } from '@taiga-ui/core';

import type { Challenge, LoginPayload } from '../../api/account.types';
import { SITE_BASE_URL } from '../../api/api.config';
import {
  ApiErrorCode,
  getRetryAfterSeconds,
  isApiError,
} from '../../api/http';
import { UserService } from '../../api/user.service';

/** Оставшееся ожидание в виде «5 мин 09 с» — так понятнее, чем голые секунды. */
function formatWait(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;

  return minutes > 0
    ? `${minutes} мин ${String(rest).padStart(2, '0')} с`
    : `${rest} с`;
}

@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule, TuiIcon, TuiInput, TuiLoader],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginComponent {
  private readonly users = inject(UserService);
  private readonly router = inject(Router);

  readonly isLoading = signal(false);
  readonly errorMessage = signal('');

  /**
   * Бэк включает проверку только после нескольких неудачных попыток входа в
   * одну учётную запись. До этого момента блока капчи в форме просто нет.
   */
  readonly challenge = signal<Challenge | null>(null);
  readonly challengeLoading = signal(false);

  /** Сколько секунд осталось до конца блокировки; 0 — блокировки нет. */
  readonly blockedFor = signal(0);
  readonly blockedLabel = computed(() => formatWait(this.blockedFor()));

  readonly form = new FormGroup({
    email: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.email],
    }),
    password: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(6)],
    }),
    captchaAnswer: new FormControl('', { nonNullable: true }),
  });

  private countdown: ReturnType<typeof setInterval> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopCountdown());
  }

  async submit(): Promise<void> {
    if (this.form.invalid || this.blockedFor() > 0 || this.isLoading()) {
      this.form.markAllAsTouched();
      return;
    }

    const challenge = this.challenge();
    const answer = Number(this.form.controls.captchaAnswer.value);

    if (challenge && !Number.isInteger(answer)) {
      this.errorMessage.set('Решите проверку от роботов');
      return;
    }

    const payload: LoginPayload = {
      email: this.form.controls.email.value.trim(),
      password: this.form.controls.password.value,
    };

    if (challenge) {
      payload.captchaToken = challenge.token;
      payload.captchaAnswer = answer;
    }

    this.isLoading.set(true);
    this.errorMessage.set('');

    try {
      await this.users.login(payload);
      this.challenge.set(null);
      await this.router.navigate(['/']);
    } catch (error: unknown) {
      await this.handleFailure(error);
    } finally {
      this.isLoading.set(false);
    }
  }

  async refreshChallenge(): Promise<void> {
    this.challengeLoading.set(true);
    this.form.controls.captchaAnswer.setValue('');

    try {
      this.challenge.set(await this.users.loginChallenge());
    } catch {
      this.challenge.set(null);
      this.errorMessage.set(
        'Не удалось загрузить проверку. Попробуйте ещё раз.'
      );
    } finally {
      this.challengeLoading.set(false);
    }
  }

  openSignUp(): Promise<void> {
    return openUrl(`${SITE_BASE_URL}/sign-up`);
  }

  openResetPassword(): Promise<void> {
    return openUrl(`${SITE_BASE_URL}/reset-password`);
  }

  private async handleFailure(error: unknown): Promise<void> {
    const code = isApiError(error) ? error.code : '';

    if (
      code === ApiErrorCode.TooManyAttempts ||
      code === ApiErrorCode.RateLimited
    ) {
      this.startCountdown(getRetryAfterSeconds(error) ?? 0);
      this.errorMessage.set(
        isApiError(error) && error.message
          ? error.message
          : 'Слишком много попыток. Подождите и попробуйте снова.'
      );
      return;
    }

    // Проверка либо только что понадобилась, либо решена неверно — в обоих
    // случаях нужна свежая задача: использованный токен второй раз не пройдёт.
    if (
      code === ApiErrorCode.CaptchaRequired ||
      code === ApiErrorCode.CaptchaInvalid
    ) {
      await this.refreshChallenge();
      this.errorMessage.set(
        code === ApiErrorCode.CaptchaInvalid
          ? 'Неверный или устаревший ответ на проверку'
          : 'Подтвердите, что вы не робот'
      );
      return;
    }

    if (code === ApiErrorCode.Unauthorized) {
      // Ответ бэка одинаков и для несуществующего адреса, и для неверного
      // пароля — намеренно, иначе форма входа стала бы способом проверять,
      // какие адреса зарегистрированы. Поэтому и текст здесь общий.
      this.errorMessage.set('Неверный логин или пароль');

      if (isApiError(error) && error.details['captchaRequired'] === 'true') {
        await this.refreshChallenge();
      }
      return;
    }

    this.errorMessage.set(
      isApiError(error) && error.message
        ? error.message
        : 'Не удалось войти. Попробуйте ещё раз.'
    );
  }

  /**
   * Держит кнопку заблокированной и показывает остаток: без этого человек
   * добивает форму вслепую и продлевает себе же блокировку.
   */
  private startCountdown(seconds: number): void {
    this.stopCountdown();
    this.blockedFor.set(seconds);

    if (seconds <= 0) {
      return;
    }

    this.countdown = setInterval(() => {
      const left = this.blockedFor() - 1;
      this.blockedFor.set(Math.max(left, 0));

      if (left <= 0) {
        this.stopCountdown();
      }
    }, 1000);
  }

  private stopCountdown(): void {
    if (this.countdown !== null) {
      clearInterval(this.countdown);
      this.countdown = null;
    }
  }
}
