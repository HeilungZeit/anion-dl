import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'removeChars',
  standalone: true,
})
export class RemoveCharactersPipe implements PipeTransform {
  transform(value: string): string {
    if (!value) {
      return value;
    }

    return value.replace(/\[.*?\]/g, '');
  }
}
