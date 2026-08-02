import { Injectable } from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { confirm, message } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';

@Injectable({ providedIn: 'root' })
export class UpdateService {
  async checkForUpdates(): Promise<void> {
    if (!isTauri()) return;

    const update = await this.checkSilently();
    if (!update) return;

    const accepted = await confirm(`Доступна версия ${update.version}. Установить обновление?`, {
      title: 'Обновление anion-dl',
      kind: 'info',
      okLabel: 'Установить',
      cancelLabel: 'Позже',
    });

    if (!accepted) {
      await update.close();
      return;
    }

    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch (error: unknown) {
      console.error('Не удалось установить обновление anion-dl', error);
      await update.close();
      await message('Не удалось скачать или установить обновление. Попробуйте позже.', {
        title: 'Обновление anion-dl',
        kind: 'error',
      });
    }
  }

  private async checkSilently(): Promise<Update | null> {
    try {
      return await check({ timeout: 10_000 });
    } catch (error: unknown) {
      // Отсутствие сети не должно мешать обычному запуску приложения.
      console.warn('Не удалось проверить обновления anion-dl', error);
      return null;
    }
  }
}
