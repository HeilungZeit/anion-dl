mod cvh;
mod download;
mod files;
mod kodik;
mod stream_proxy;
// pub, чтобы резолвер можно было прогнать из examples/resolve_probe.rs без
// кликов по нативному окну.
pub mod resolver;
mod window;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(download::Downloads::default())
        .invoke_handler(tauri::generate_handler![
            cvh::cvh_playlist,
            resolver::resolve_manifest,
            resolver::resolve_playback,
            resolver::change_manifest_quality,
            download::download_episode,
            download::cancel_download,
            files::probe_files,
            files::allow_playback
        ])
        // Поток CDNVideoHub для плеера: hls.js ходит сюда, а не на CDN.
        .register_asynchronous_uri_scheme_protocol(
            stream_proxy::SCHEME,
            |_context, request, responder| {
                tauri::async_runtime::spawn(async move {
                    responder.respond(stream_proxy::handle(request).await);
                });
            },
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| Ok(window::create_main(app)?))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
