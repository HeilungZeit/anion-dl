import { DestroyRef, Directive, ElementRef, inject } from '@angular/core';

/** Сколько меню может висеть открытым без касаний, прежде чем закрыться. */
const IDLE_CLOSE_MS = 5000;

/** Пункт, который отмечен выбранным, — на него встаёт фокус при открытии. */
const ACTIVE_OPTION = '.quality__option--active';

/**
 * Поведение `<details>`-меню плеера, которого у нативного элемента нет:
 *
 * - закрывается по клику мимо, по уходу фокуса наружу клавишей Tab и после
 *   5 секунд бездействия внутри — забытое меню висело бы поверх кадра;
 * - управляется с клавиатуры: стрелки ходят по пунктам, Esc закрывает и
 *   возвращает фокус на кнопку меню.
 *
 * Клавиши внутри открытого меню не всплывают к плееру: иначе стрелки
 * перематывали бы серию, а пробел на пункте ставил бы её на паузу вместо
 * выбора.
 */
@Directive({
  selector: 'details[appAutoCloseMenu]',
  host: {
    '(toggle)': 'onToggle()',
    '(pointermove)': 'restartTimer()',
    '(pointerdown)': 'restartTimer()',
    '(wheel)': 'restartTimer()',
    '(keydown)': 'onKeydown($event)',
    '(document:pointerdown)': 'onDocumentPointerDown($event)',
  },
})
export class AutoCloseMenuDirective {
  private readonly details = inject<ElementRef<HTMLDetailsElement>>(ElementRef)
    .nativeElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.clearTimer());
  }

  onToggle(): void {
    if (!this.details.open) {
      this.clearTimer();
      return;
    }

    this.restartTimer();

    // Фокус на выбранный пункт, чтобы стрелки сразу работали от него. После
    // клика мышью браузер не рисует кольцо у программного фокуса.
    const options = this.options();
    (
      this.details.querySelector<HTMLElement>(ACTIVE_OPTION) ?? options[0]
    )?.focus();
  }

  onKeydown(event: KeyboardEvent): void {
    // Enter и пробел нажимают сфокусированную кнопку меню или его summary,
    // даже закрытого. Плееру их видеть незачем: он поставил бы серию на паузу.
    if (event.key === 'Enter' || event.key === ' ') {
      event.stopPropagation();
      this.restartTimer();
      return;
    }

    if (!this.details.open) {
      return;
    }

    this.restartTimer();

    switch (event.key) {
      case 'Escape':
        this.close(true);
        break;
      case 'ArrowDown':
        this.moveFocus(1);
        break;
      case 'ArrowUp':
        this.moveFocus(-1);
        break;
      case 'Home':
        this.options()[0]?.focus();
        break;
      case 'End':
        this.options().at(-1)?.focus();
        break;
      case 'Tab':
        // Фокус переедет после обработки клавиши — проверяем уже на месте.
        // Через focusout это делать нельзя: в WebKit клик по кнопке не даёт
        // ей фокус, он уходит на плеер (у него tabindex), и меню закрывалось
        // на нажатии мыши — клик приходился уже на скрытый пункт.
        setTimeout(() => {
          if (!this.details.contains(document.activeElement)) {
            this.close(false);
          }
        });
        return;
      default:
        return;
    }

    event.preventDefault();
    event.stopPropagation();
  }

  restartTimer(): void {
    if (!this.details.open) {
      return;
    }

    this.clearTimer();
    this.timer = setTimeout(() => this.close(false), IDLE_CLOSE_MS);
  }

  onDocumentPointerDown(event: PointerEvent): void {
    if (
      this.details.open &&
      !this.details.contains(event.target as Node | null)
    ) {
      this.close(false);
    }
  }

  private close(returnFocus: boolean): void {
    this.details.open = false;

    if (returnFocus) {
      this.details.querySelector<HTMLElement>('summary')?.focus();
    }
  }

  private options(): HTMLElement[] {
    return [...this.details.querySelectorAll<HTMLElement>('button')];
  }

  private moveFocus(step: number): void {
    const options = this.options();
    if (options.length === 0) {
      return;
    }

    const current = options.indexOf(document.activeElement as HTMLElement);
    const next =
      current < 0
        ? step > 0
          ? 0
          : options.length - 1
        : (current + step + options.length) % options.length;

    options[next].focus();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
