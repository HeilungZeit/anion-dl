# anion-dl

Десктопная качалка серий для anion: Angular 22 + Taiga UI 5 в оболочке Tauri 2.
Получает каталог из локального `anion-go`, резолвит HLS-поток Kodik в скрытом
webview и собирает MP4 через встроенный минимальный LGPL ffmpeg.

Перед изменениями прочитайте [AGENT.md](AGENT.md). История решений и проверок —
в [PLAN.md](PLAN.md).

## Разработка

```bash
./scripts/fetch-ffmpeg.sh
bun install
bun run tauri dev
```

Локальный `anion-go` ожидается на `http://localhost:8080`.

## Сборка macOS

```bash
bun run tauri build --bundles dmg
```

Результат: `src-tauri/target/release/bundle/dmg/anion-dl_0.1.0_aarch64.dmg`.
Приложение подписывается ad-hoc; для распространения без предупреждений
Gatekeeper потребуются Developer ID Application и нотарификация Apple.
