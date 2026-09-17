import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'timeUntil',
  standalone: true,
})
export class TimeUntilPipe implements PipeTransform {
  transform(timestamp: number): string {
    if (!timestamp) return '';

    const now = Date.now();
    const date = timestamp * 1000;
    const diff = date - now;

    if (diff <= 0) return 'Вышел';

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return 'через ' + this.pluralize(days, 'день', 'дня', 'дней');
    }
    if (hours > 0) {
      return 'через ' + this.pluralize(hours, 'час', 'часа', 'часов');
    }
    if (minutes > 0) {
      return 'через ' + this.pluralize(minutes, 'минуту', 'минуты', 'минут');
    }

    return 'через несколько секунд';
  }

  private pluralize(n: number, one: string, few: string, many: string): string {
    const mod10 = n % 10;
    const mod100 = n % 100;

    if (mod100 >= 11 && mod100 <= 19) {
      return `${n} ${many}`;
    }
    if (mod10 === 1) {
      return `${n} ${one}`;
    }
    if (mod10 >= 2 && mod10 <= 4) {
      return `${n} ${few}`;
    }
    return `${n} ${many}`;
  }
}
