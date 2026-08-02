mod download;
// pub, чтобы резолвер можно было прогнать из examples/resolve_probe.rs без
// кликов по нативному окну.
pub mod resolver;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(download::Downloads::default())
        .invoke_handler(tauri::generate_handler![
            resolver::resolve_manifest,
            download::download_episode,
            download::cancel_download
        ])
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
