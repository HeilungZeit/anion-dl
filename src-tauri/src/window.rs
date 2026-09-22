//! Главное окно создаётся здесь, а не по конфигу: его размер зависит от
//! монитора, а монитор становится известен только во время работы.
//!
//! В `tauri.conf.json` окно описано с `"create": false` — оттуда берутся
//! заголовок, минимальный размер и прочие поля, а размер и позицию мы
//! проставляем до создания, чтобы окно не мигало стартовыми 1440×900.

use tauri::{App, Monitor, WebviewWindowBuilder};

const MAIN_LABEL: &str = "main";

/// Доли полного разрешения монитора (не рабочей области) под окно.
const WIDTH_SHARE: f64 = 0.85;
const HEIGHT_SHARE: f64 = 0.86;

pub fn create_main(app: &App) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_LABEL)
        .expect("в tauri.conf.json нет окна main")
        .clone();

    let mut builder = WebviewWindowBuilder::from_config(app.handle(), &config)?;
    if let Some(monitor) = target_monitor(app) {
        let (x, y, width, height) = geometry(
            &monitor,
            config.min_width.unwrap_or(0.0),
            config.min_height.unwrap_or(0.0),
        );
        builder = builder.inner_size(width, height).position(x, y);
    }
    builder.build()?;
    Ok(())
}

/// Монитор, где сейчас курсор, — там пользователь и ждёт окно. Сама ОС этого
/// не гарантирует: macOS открывает на экране активной строки меню, Windows —
/// на основном.
fn target_monitor(app: &App) -> Option<Monitor> {
    app.cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
}

/// Логические координаты и размер: `Monitor` отдаёт физические пиксели,
/// билдер принимает логические, иначе на Retina окно вышло бы вдвое больше.
///
/// Минимум из конфига важнее доли экрана, рабочая область (без Dock и панели
/// задач) — важнее минимума: окно, вылезающее за край, хуже тесного.
fn geometry(monitor: &Monitor, min_width: f64, min_height: f64) -> (f64, f64, f64, f64) {
    let scale = monitor.scale_factor();
    let screen = monitor.size().to_logical::<f64>(scale);
    let area = monitor.work_area();
    let area_pos = area.position.to_logical::<f64>(scale);
    let area_size = area.size.to_logical::<f64>(scale);

    let width = (screen.width * WIDTH_SHARE).max(min_width).min(area_size.width);
    let height = (screen.height * HEIGHT_SHARE).max(min_height).min(area_size.height);
    let x = area_pos.x + (area_size.width - width) / 2.0;
    let y = area_pos.y + (area_size.height - height) / 2.0;
    (x, y, width, height)
}
