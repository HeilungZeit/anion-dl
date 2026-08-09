//! Сверка списка задач с тем, что реально лежит на диске.
//!
//! Эти два источника расходятся, и без сверки UI врёт в обе стороны: файл можно
//! удалить мимо приложения — задача останется «Готово», а «Показать в Finder»
//! упрётся в пустоту; и наоборот, `clearFinished` убирает задачу, оставляя файл,
//! после чего серия молча качается заново.

use serde::Serialize;

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
#[tauri::command]
pub fn probe_files(paths: Vec<String>) -> Vec<FileState> {
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

#[cfg(test)]
mod tests {
    use super::probe_files;

    #[test]
    fn reports_existing_file_with_size() {
        let path = std::env::temp_dir().join("anion-dl-probe-test.bin");
        std::fs::write(&path, b"12345").expect("временный файл должен создаться");

        let state = probe_files(vec![path.to_string_lossy().into_owned()]);

        assert!(state[0].exists);
        assert_eq!(state[0].size_bytes, 5);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reports_missing_file() {
        let path = std::env::temp_dir().join("anion-dl-probe-missing.bin");
        let _ = std::fs::remove_file(&path);

        let state = probe_files(vec![path.to_string_lossy().into_owned()]);

        assert!(!state[0].exists);
        assert_eq!(state[0].size_bytes, 0);
    }

    #[test]
    fn does_not_mistake_a_directory_for_a_file() {
        let path = std::env::temp_dir();

        let state = probe_files(vec![path.to_string_lossy().into_owned()]);

        assert!(!state[0].exists);
    }

    #[test]
    fn keeps_order_and_paths_for_matching() {
        let missing = std::env::temp_dir().join("anion-dl-probe-order.bin");
        let _ = std::fs::remove_file(&missing);
        let raw = missing.to_string_lossy().into_owned();

        let state = probe_files(vec![raw.clone(), raw.clone()]);

        assert_eq!(state.len(), 2);
        assert_eq!(state[0].path, raw);
    }
}
