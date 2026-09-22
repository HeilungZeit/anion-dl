//! Сверка списка задач с тем, что реально лежит на диске.
//!
//! Эти два источника расходятся, и без сверки UI врёт в обе стороны: файл можно
//! удалить мимо приложения — задача останется «Готово», а «Показать в Finder»
//! упрётся в пустоту; и наоборот, `clearFinished` убирает задачу, оставляя файл,
//! после чего серия молча качается заново.

use std::path::Path;

use serde::Serialize;
use tauri::Manager;

/// Состояние одного пути. Путь возвращается обратно, потому что вызывающая
/// сторона сопоставляет ответ со своими задачами именно по нему.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileState {
    pub path: String,
    pub exists: bool,
    /// Размер на диске. 0, если файла нет.
    pub size_bytes: u64,
}

/// Пакетная проверка: список задач сверяется целиком, по одному вызову на
/// страницу, а не на строку.
///
/// Команда асинхронная, а `stat` уходит в пул блокирующих задач. Синхронная
/// команда Tauri выполняется в главном потоке, а папка загрузок может лежать
/// на уснувшем внешнем диске или в сетевой шаре. Там `stat` раскручивает диск
/// секундами, и всё это время окно не отвечало бы.
#[tauri::command]
pub async fn probe_files(paths: Vec<String>) -> Result<Vec<FileState>, String> {
    tauri::async_runtime::spawn_blocking(move || probe_all(paths))
        .await
        .map_err(|error| format!("Сверка файлов прервалась: {error}"))
}

fn probe_all(paths: Vec<String>) -> Vec<FileState> {
    paths.into_iter().map(probe).collect()
}

fn probe(path: String) -> FileState {
    // Ошибку stat намеренно не отличаем от отсутствия: и «файла нет», и «нет
    // прав на каталог» означают для UI одно — открывать нечего. Каталог с
    // подходящим именем тоже не считается файлом.
    match std::fs::metadata(&path) {
        Ok(meta) if meta.is_file() => FileState {
            exists: true,
            size_bytes: meta.len(),
            path,
        },
        _ => FileState {
            path,
            exists: false,
            size_bytes: 0,
        },
    }
}

/// Открывает asset-протоколу доступ к одной скачанной серии, чтобы встроенный
/// плеер мог её проиграть.
///
/// Статическая область в `tauri.conf.json` здесь не подходит: папку загрузок
/// выбирает пользователь, и это может быть что угодно, вплоть до внешнего
/// диска. Разрешать `**` ради этого — значит дать вебвью читать весь диск,
/// поэтому доступ выдаётся точечно, на файл и только на видео.
///
/// Асинхронная по той же причине, что и `probe_files`: проверка файла на
/// уснувшем диске не должна замораживать главный поток.
#[tauri::command]
pub async fn allow_playback(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let file = std::path::PathBuf::from(&path);

    if !is_playable(&file) {
        return Err("Встроенный плеер открывает только mp4".into());
    }

    let probe = file.clone();
    let exists = tauri::async_runtime::spawn_blocking(move || probe.is_file())
        .await
        .unwrap_or(false);

    if !exists {
        return Err("Файл не найден — возможно, его удалили или переместили".into());
    }

    app.asset_protocol_scope()
        .allow_file(&file)
        .map_err(|error| error.to_string())
}

fn is_playable(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4"))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{is_playable, probe_all};

    #[test]
    fn plays_only_mp4() {
        assert!(is_playable(Path::new("/tmp/Серия - E01 [Озвучка].mp4")));
        assert!(is_playable(Path::new("/tmp/a.MP4")));
        assert!(!is_playable(Path::new("/etc/passwd")));
        assert!(!is_playable(Path::new("/tmp/a.mp4.json")));
    }

    #[test]
    fn reports_existing_file_with_size() {
        let path = std::env::temp_dir().join("anion-dl-probe-test.bin");
        std::fs::write(&path, b"12345").expect("временный файл должен создаться");

        let state = probe_all(vec![path.to_string_lossy().into_owned()]);

        assert!(state[0].exists);
        assert_eq!(state[0].size_bytes, 5);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reports_missing_file() {
        let path = std::env::temp_dir().join("anion-dl-probe-missing.bin");
        let _ = std::fs::remove_file(&path);

        let state = probe_all(vec![path.to_string_lossy().into_owned()]);

        assert!(!state[0].exists);
        assert_eq!(state[0].size_bytes, 0);
    }

    #[test]
    fn does_not_mistake_a_directory_for_a_file() {
        let path = std::env::temp_dir();

        let state = probe_all(vec![path.to_string_lossy().into_owned()]);

        assert!(!state[0].exists);
    }

    #[test]
    fn keeps_order_and_paths_for_matching() {
        let missing = std::env::temp_dir().join("anion-dl-probe-order.bin");
        let _ = std::fs::remove_file(&missing);
        let raw = missing.to_string_lossy().into_owned();

        let state = probe_all(vec![raw.clone(), raw.clone()]);

        assert_eq!(state.len(), 2);
        assert_eq!(state[0].path, raw);
    }
}
