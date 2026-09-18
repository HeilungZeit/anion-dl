# Anion Flow

Десктопное приложение anion для просмотра и скачивания аниме: собственный
HLS-плеер, аккаунт и закладки, локальное «Продолжить смотреть» с восстановлением
позиции и загрузка серий в MP4 для офлайна. Angular 22 + Taiga UI 5 в оболочке
Tauri 2; MP4 собирается встроенным минимальным LGPL ffmpeg без перекодирования.

Перед изменениями прочитайте [AGENT.md](AGENT.md). История решений и проверок —
в [PLAN.md](PLAN.md).

## Скачать

- [Последний релиз для всех платформ](https://github.com/HeilungZeit/anion-dl/releases/latest)
- [macOS — Apple Silicon](https://github.com/HeilungZeit/anion-dl/releases/latest/download/anion-dl-macos-arm64.dmg)
- [macOS — Intel](https://github.com/HeilungZeit/anion-dl/releases/latest/download/anion-dl-macos-x64.dmg)
- [Windows x64](https://github.com/HeilungZeit/anion-dl/releases/latest/download/anion-dl-windows-x64-setup.exe)
- [Linux x64 — AppImage](https://github.com/HeilungZeit/anion-dl/releases/latest/download/anion-dl-linux-x64.AppImage)
- [Linux x64 — DEB](https://github.com/HeilungZeit/anion-dl/releases/latest/download/anion-dl-linux-x64.deb)

Сборки не подписаны. macOS Gatekeeper и Windows SmartScreen покажут системное
предупреждение при первом запуске.

## Разработка

```bash
./scripts/fetch-ffmpeg.sh
bun install
bun run tauri dev
```

## Сборка macOS

```bash
bun run tauri build --bundles dmg
```

Результат: `src-tauri/target/release/bundle/dmg/Anion Flow_2.0.1_aarch64.dmg`.
Приложение подписывается ad-hoc; для распространения без предупреждений
Gatekeeper потребуются Developer ID Application и нотарификация Apple.

## Публикация

Версия тега должна совпадать с `version` в `src-tauri/tauri.conf.json`:

```bash
git tag app-v0.1.1
git push origin app-v0.1.1
```

GitHub Actions соберёт macOS ARM/Intel, Windows x64 и Linux x64, после чего
создаст GitHub Release и обновит постоянные ссылки выше.

## Название и иконка

Пользовательское название — **Anion Flow**. Технические идентификаторы
`anion-dl` (bundle ID, Cargo/npm, заголовок API и адреса релизов) сохранены
для совместимости с установленными версиями и сервером.

Векторный исходник иконки — `src-tauri/icons/app-icon.svg`, адаптация
`anion/src/app/icons/logo.component.html`: портрет и красная луна с фронта,
скруглённая форма и знак воспроизведения. PNG используется также в шапке и favicon.
Перегенерация всех размеров:

```bash
bun run tauri icon src-tauri/icons/app-icon.svg --output /tmp/anion-flow-icon --png 1024
cp /tmp/anion-flow-icon/1024x1024.png src-tauri/icons/app-icon.png
bun run tauri icon src-tauri/icons/app-icon.png
```
