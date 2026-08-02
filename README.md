# anion-dl

Десктопная качалка серий для anion: Angular 22 + Taiga UI 5 в оболочке Tauri 2.
Получает каталог из `https://anion.online/api`, резолвит HLS-поток Kodik в скрытом
webview и собирает MP4 через встроенный минимальный LGPL ffmpeg.

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

Результат: `src-tauri/target/release/bundle/dmg/anion-dl_0.1.1_aarch64.dmg`.
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
