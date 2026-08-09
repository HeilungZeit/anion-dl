//! Сборка HLS-потока в mp4 через сайдкар ffmpeg.
//!
//! Поток не зашифрован и уже в H.264 + AAC, поэтому идёт ремукс (`-c copy`), а
//! не перекодирование: секунды вместо десятков минут и качество один в один.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Живые процессы ffmpeg по id задачи.
///
/// Нужен, потому что отменить загрузку можно только убив процесс: из JS ручку
/// дочернего процесса не достать, а брошенный ffmpeg продолжит качать в фоне.
#[derive(Default)]
pub struct Downloads(Mutex<HashMap<String, CommandChild>>);

impl Downloads {
    /// Реестр под замком, переживающий отравление.
    ///
    /// `unwrap()` здесь был бы каскадом: одна паника с захваченным замком — и
    /// ВСЕ последующие загрузки паникуют вместо того, чтобы вернуть ошибку.
    /// Отравление означает лишь, что кто-то упал, держа замок; сам HashMap
    /// остаётся целым, и продолжать с ним безопасно.
    fn registry(&self) -> std::sync::MutexGuard<'_, HashMap<String, CommandChild>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Событие прогресса. Летит в UI примерно раз в секунду — с такой частотой
/// ffmpeg сам пишет блоки `-progress`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub task_id: String,
    /// Сколько секунд видео уже собрано.
    pub processed_secs: f64,
    /// Длительность целиком. 0, пока ffmpeg не напечатал Duration.
    pub total_secs: f64,
    pub size_bytes: u64,
}

pub const PROGRESS_EVENT: &str = "download://progress";

/// Результат загрузки. Отдельное поле под предупреждение нужно, чтобы отличить
/// «скачалось, но были шероховатости» от провала: раньше и то и другое было
/// ошибкой, и полная серия помечалась красным.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadReport {
    pub path: String,
    pub warning: Option<String>,
}

#[tauri::command]
pub async fn download_episode(
    app: AppHandle,
    task_id: String,
    manifest_url: String,
    output_path: String,
    referer: String,
) -> Result<DownloadReport, String> {
    // Папку создаём здесь, а не в UI: раскладка по подпапкам означает, что
    // каталог аниме до первой серии не существует, а ffmpeg сам его не заведёт —
    // он падает с «No such file or directory» уже после резолва манифеста.
    if let Some(parent) = std::path::Path::new(&output_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Не удалось создать папку {}: {error}", parent.display()))?;
    }

    let sidecar = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|error| format!("Сайдкар ffmpeg не найден: {error}"))?;

    let (mut rx, child) = sidecar
        .args(build_args(&manifest_url, &output_path, &referer))
        .spawn()
        .map_err(|error| format!("Не удалось запустить ffmpeg: {error}"))?;

    app.state::<Downloads>()
        .registry()
        .insert(task_id.clone(), child);

    let mut total_secs = 0.0_f64;
    let mut size_bytes = 0_u64;
    let mut complaints = 0_u32;
    let mut processed_secs = 0.0_f64;
    // ffmpeg пишет диагностику в stderr, поэтому при ненулевом коде возврата
    // показать пользователю можно только её.
    let mut stderr_tail: Vec<String> = Vec::new();

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let line = String::from_utf8_lossy(&line).to_string();

                if let Some(value) = line.strip_prefix("total_size=") {
                    size_bytes = value.trim().parse().unwrap_or(size_bytes);
                }

                if let Some(value) = line.strip_prefix("out_time_ms=") {
                    // Вопреки имени, ffmpeg пишет сюда МИКРОсекунды.
                    let micros: f64 = value.trim().parse().unwrap_or(0.0);
                    processed_secs = micros / 1_000_000.0;

                    let _ = app.emit(
                        PROGRESS_EVENT,
                        Progress {
                            task_id: task_id.clone(),
                            processed_secs,
                            total_secs,
                            size_bytes,
                        },
                    );
                }
            }
            CommandEvent::Stderr(line) => {
                let line = String::from_utf8_lossy(&line).to_string();

                if total_secs == 0.0 {
                    if let Some(parsed) = parse_duration(&line) {
                        total_secs = parsed;
                    }
                }

                if is_decoder_complaint(&line) {
                    complaints += 1;
                }

                stderr_tail.push(line);
                if stderr_tail.len() > 40 {
                    stderr_tail.remove(0);
                }
            }
            CommandEvent::Terminated(status) => {
                let was_cancelled = forget_child(&app, &task_id).is_none();

                return if was_cancelled {
                    // Реестр пуст — значит процесс убил cancel_download, а не
                    // сам ffmpeg. Недокачанный файл убираем: он всё равно
                    // непригоден и только путал бы в Finder.
                    let _ = std::fs::remove_file(&output_path);
                    Err(CANCELLED.into())
                } else if status.code == Some(0) {
                    // Нулевой код возврата НЕ означает целый файл: при обрыве
                    // сегмента ffmpeg молча продолжает и оставляет дыру.
                    if let Some(reason) = incompleteness(processed_secs, total_secs) {
                        Err(format!("{reason} Файл неполный — перекачайте."))
                    } else {
                        Ok(DownloadReport {
                            path: output_path,
                            warning: warn_about(complaints),
                        })
                    }
                } else {
                    Err(format!(
                        "ffmpeg завершился с кодом {:?}:\n{}",
                        status.code,
                        // Через "\n", а не "": Tauri отдаёт stderr уже
                        // построчно и перевод строки срезает, поэтому склейка
                        // впритык давала одну нечитаемую стену текста.
                        stderr_tail.join("\n")
                    ))
                };
            }
            _ => {}
        }
    }

    forget_child(&app, &task_id);
    Err("ffmpeg завершился, не сообщив результат".into())
}

/// Маркер отмены. UI отличает его от настоящей ошибки, чтобы не пугать красным.
pub const CANCELLED: &str = "Отменено";

fn forget_child(app: &AppHandle, task_id: &str) -> Option<CommandChild> {
    app.state::<Downloads>().registry().remove(task_id)
}

/// Убивает ffmpeg выбранной задачи. Файл удалит сама download_episode, когда
/// увидит, что процесс исчез из реестра.
#[tauri::command]
pub fn cancel_download(downloads: State<'_, Downloads>, task_id: String) -> Result<(), String> {
    let child = downloads.registry().remove(&task_id);

    match child {
        Some(child) => child
            .kill()
            .map_err(|error| format!("Не удалось остановить загрузку: {error}")),
        // Задача уже успела завершиться сама — отменять нечего, это не ошибка.
        None => Ok(()),
    }
}

fn build_args(manifest_url: &str, output_path: &str, referer: &str) -> Vec<String> {
    vec![
        // Referer нужен: CDN отдаёт сегменты только с ним.
        "-headers".into(),
        format!("Referer: {referer}\r\n"),
        // Ретраи протокола: работают ВНУТРИ одного запроса за сегмент —
        // оборвалось соединение, переподключились. Наблюдалось вживую —
        // таймаут одного из хостов CDN стоил 12 кадров из 600 при коде
        // возврата 0.
        "-reconnect".into(),
        "1".into(),
        "-reconnect_streamed".into(),
        "1".into(),
        "-reconnect_on_network_error".into(),
        "1".into(),
        "-reconnect_delay_max".into(),
        "10".into(),
        // ...а `-reconnect_on_network_error` покрывает только TCP/TLS: ответ
        // 502/503 сетевой ошибкой не считается и без этого списка не
        // переспрашивается вовсе.
        //
        // 4xx сюда добавлять НЕЛЬЗЯ: 403 у CDN означает протухшую подпись, она
        // не оживёт, и ретраи выльются в сотни бесполезных запросов при
        // намертво стоящем прогрессе (проверено на Alloha).
        "-reconnect_on_http_error".into(),
        "5xx,408,429".into(),
        // Соединение может остаться живым, но перестать отдавать байты — на
        // такой сокет ретраи не срабатывают, и задача висит вечно. В
        // МИКРОсекундах, вопреки виду: 20 с на чтение при сегментах ~10 с.
        "-rw_timeout".into(),
        "20000000".into(),
        // Ретраи ДЕМУКСЕРА, поверх протокольных. По умолчанию 0, и это значит
        // не «без повторов», а «пропустить сегмент и идти дальше» — вот откуда
        // берётся дыра в файле при exit=0. Ретраи протокола сюда не дотянутся:
        // запрос к тому моменту уже завершился отказом.
        //
        // Ценнее самих повторов побочный эффект: исчерпав их, ffmpeg
        // завершается ненулевым кодом, и тихая дыра становится явной ошибкой.
        "-seg_max_retry".into(),
        "10".into(),
        "-i".into(),
        manifest_url.into(),
        // Явные -map, иначе при нескольких аудиодорожках ffmpeg может выбрать
        // не ту озвучку.
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "0:a:0".into(),
        "-c".into(),
        "copy".into(),
        // Обязателен при TS -> MP4, без него звук в контейнере битый.
        "-bsf:a".into(),
        "aac_adtstoasc".into(),
        // Двигает moov в начало файла. По умолчанию ffmpeg кладёт его после
        // mdat, и тогда плееры (в частности телеграмный) не начинают
        // воспроизведение, пока не скачают файл целиком.
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        "-y".into(),
        output_path.into(),
    ]
}

/// Ворчание декодера на стыках потока.
///
/// Сюда сознательно НЕ входит «Connection to tcp:// … failed»: с включёнными
/// `-reconnect*` обрыв штатно повторяется, и файл выходит целым.
///
/// Само по себе такое ворчание браком НЕ считается. HLS часто начинается не с
/// ключевого кадра, и пара жалоб в начале потока — норма: ровно на этом
/// загрузка полной серии однажды была помечена ошибкой, хотя файл смотрелся
/// целиком. Поэтому жалобы теперь только предупреждают, а решает объём данных.
fn is_decoder_complaint(line: &str) -> bool {
    const MARKERS: [&str; 3] = [
        "non-existing PPS",
        "no frame!",
        "Error in the pull function",
    ];

    MARKERS.iter().any(|marker| line.contains(marker))
}

/// Допустимое отставание собранного от заявленного: 1% длительности, но не
/// меньше пяти секунд.
///
/// Прежние жёсткие 2 с были ошибкой: последний блок `-progress` печатается до
/// финального сброса буферов, поэтому итоговый `out_time` штатно оказывается на
/// секунду-другую меньше `Duration`, и полная серия падала в ошибку.
fn duration_tolerance(total_secs: f64) -> f64 {
    (total_secs * 0.01).max(5.0)
}

/// Жёсткий признак неполного файла: собрано заметно меньше заявленного.
///
/// Это единственная проверка, по которой задача считается упавшей. Она не ловит
/// дыру в середине (при `-c copy` таймстемпы сохраняются, и длительность
/// остаётся полной) — такой случай уходит в предупреждение, а не в ошибку:
/// заставлять перекачивать 24 минуты из-за подозрения дороже, чем пропустить
/// полсекунды видео.
/// Сколько жалоб декодера считать бытовым шумом стыков HLS.
const COMPLAINT_NOISE_FLOOR: u32 = 4;

/// Предупреждение о шероховатостях. Не ошибка — файл отдаётся пользователю.
fn warn_about(complaints: u32) -> Option<String> {
    if complaints > COMPLAINT_NOISE_FLOOR {
        return Some(format!(
            "Декодер {complaints} раз пожаловался на стыки — возможны короткие пропуски."
        ));
    }

    None
}

fn incompleteness(processed_secs: f64, total_secs: f64) -> Option<String> {
    if total_secs > 0.0 && processed_secs < total_secs - duration_tolerance(total_secs) {
        return Some(format!(
            "Собрано {processed_secs:.0} с из {total_secs:.0} с."
        ));
    }

    None
}

/// Вытаскивает длительность из строки вида `  Duration: 00:23:40.02, start: ...`
fn parse_duration(line: &str) -> Option<f64> {
    let rest = line.trim_start().strip_prefix("Duration:")?.trim_start();
    let stamp = rest.split(',').next()?.trim();

    let mut parts = stamp.split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;

    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

#[cfg(test)]
mod tests {
    use super::{incompleteness, is_decoder_complaint, parse_duration, warn_about};

    #[test]
    fn reads_duration_line() {
        let line = "  Duration: 00:23:40.02, start: 0.000000, bitrate: N/A";
        let parsed = parse_duration(line).expect("должна разобраться");

        assert!((parsed - 1420.02).abs() < 0.01);
    }

    #[test]
    fn ignores_other_lines() {
        assert!(parse_duration("  Stream #0:0: Video: h264").is_none());
    }

    #[test]
    fn spots_decoder_complaints() {
        assert!(is_decoder_complaint(
            "[h264 @ 0x1] non-existing PPS 0 referenced"
        ));
        assert!(is_decoder_complaint("[h264 @ 0x1] no frame!"));
    }

    #[test]
    fn tolerates_recovered_connection_drops() {
        // Реальная строка из прогона, где обрыв был повторён и файл вышел
        // целым: 600 кадров из 600. Браковать такое нельзя.
        assert!(!is_decoder_complaint(
            "[tcp @ 0x1] Connection to tcp://rock.cloud.solodcdn.com:443 failed: Operation timed out"
        ));
        assert!(!is_decoder_complaint(
            "  Stream #0:0: Video: h264, yuv420p, 640x360"
        ));
    }

    #[test]
    fn flags_short_output() {
        assert!(incompleteness(1200.0, 1420.0).is_some());
    }

    #[test]
    fn accepts_full_output() {
        // Полная серия: последний блок -progress печатается до финального
        // сброса буферов, поэтому пара секунд недобора — норма. Ровно на этом
        // прежний допуск в 2 с давал ложную ошибку.
        assert!(incompleteness(1418.0, 1420.02).is_none());
        assert!(incompleteness(1419.0, 1420.0).is_none());
        // Длительность неизвестна — сверять не с чем, брак не выдумываем.
        assert!(incompleteness(10.0, 0.0).is_none());
    }

    #[test]
    fn keeps_quiet_about_a_few_complaints() {
        // HLS часто стартует не с ключевого кадра — пара жалоб это норма.
        assert!(warn_about(0).is_none());
        assert!(warn_about(2).is_none());
    }

    #[test]
    fn warns_when_complaints_pile_up() {
        assert!(warn_about(40).is_some());
    }
}
